import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '@n8n-media-review/shared';
import { OzonRepository } from '../../repositories/ozon.js';
import type { PurchaseRepository } from '../../repositories/purchases.js';
import { OzonPublishingService } from './index.js';
import { OzonAutoPublishingCoordinator, buildOzonPricingItem, buildOzonVariantIdentities, buildSharedAttributes, currentPresetReplanPlanContract, inspectOzonMediaManifest, resolveOzonVariantPublicationScope, resolvePublicationDimensions, sameOzonPrePlanMediaEvidence, selectOzonPricingOption, selectPrices, uniqueManifestAssets } from './auto-publishing.js';

const roots: string[] = [];

describe('OZON PRE_PLAN media evidence timestamps', () => {
  const evidence = {
    sourceStageId: 'E004',
    submissionId: '5f02de4d-6fc8-4b4a-9767-0afcad24fbed',
    variantId: '850797d5-7a93-47c5-8fcf-bc79e296387a',
    deliveredAt: '2026-08-13T10:18:44.025Z',
    updatedAt: '2026-08-13T10:19:19.48Z',
    decision: 'ACCEPTED',
    jobId: 'b8094cb3-2c9c-411c-af6b-aab99bbff6d1',
    payloadHash: `sha256:${'a'.repeat(64)}`
  };

  it('treats equivalent PostgreSQL fractional timestamp renderings as the same evidence', () => {
    expect(sameOzonPrePlanMediaEvidence([evidence], [{ ...evidence, updatedAt: '2026-08-13T10:19:19.480Z' }])).toBe(true);
  });

  it('still rejects a different millisecond or an invalid timestamp', () => {
    expect(sameOzonPrePlanMediaEvidence([evidence], [{ ...evidence, updatedAt: '2026-08-13T10:19:19.481Z' }])).toBe(false);
    expect(sameOzonPrePlanMediaEvidence([evidence], [{ ...evidence, updatedAt: 'invalid' }])).toBe(false);
  });
});

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
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableTestJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OZON automatic media inspection', () => {
  it('uses the latest E004/E005 batches and keeps image order stable', async () => {
    const fixture = await createFixture();
    const imageA = await fixture.asset('E005', 'image', 'new-images', 'variants/咖啡色/images/02.png', Buffer.from('image-02'), '2026-07-27T10:00:00Z');
    const imageB = await fixture.asset('E005', 'image', 'new-images', 'variants/咖啡色/images/01.png', Buffer.from('image-01'), '2026-07-27T10:00:00Z');
    const oldImage = await fixture.asset('E005', 'image', 'old-images', 'variants/咖啡色/images/old.png', Buffer.from('old-image'), '2026-07-27T09:00:00Z');
    const video = await fixture.asset('E004', 'video', 'video', 'variants/咖啡色/videos/01.mp4', Buffer.from('video'), '2026-07-27T10:01:00Z');
    await fixture.manifest([oldImage, imageA, imageB, video]);

    const inspected = await inspectOzonMediaManifest(fixture.manifestPath, fixture.sku, fixture.productName, [{ variantId: fixture.variantId, name: '咖啡色' }]);

    expect(inspected.issues).toEqual([]);
    expect(inspected.variants).toHaveLength(1);
    expect(inspected.variants[0]?.images.map((asset) => path.basename(asset.relativePath))).toEqual(['01.png', '02.png']);
    expect(inspected.variants[0]?.videos).toHaveLength(1);
    expect(inspected.signature).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses explicit E003 image order for OZON offer defaults', async () => {
    const fixture = await createFixture();
    const image07 = {
      ...await fixture.asset('E005', 'image', 'ordered-images', 'variants/咖啡色/images/07.png', Buffer.from('image-07'), '2026-08-10T01:00:00Z'),
      sortOrder: 0
    };
    const image01 = {
      ...await fixture.asset('E005', 'image', 'ordered-images', 'variants/咖啡色/images/01.png', Buffer.from('image-01'), '2026-08-10T01:00:00Z'),
      sortOrder: 1
    };
    const image04 = {
      ...await fixture.asset('E005', 'image', 'ordered-images', 'variants/咖啡色/images/04.png', Buffer.from('image-04'), '2026-08-10T01:00:00Z'),
      sortOrder: 2
    };
    const video = await fixture.asset('E004', 'video', 'video', 'variants/咖啡色/videos/01.mp4', testMp4(12), '2026-08-10T01:01:00Z');
    await fixture.manifest([image01, image04, image07, video]);

    const inspected = await inspectOzonMediaManifest(
      fixture.manifestPath,
      fixture.sku,
      fixture.productName,
      [{ variantId: fixture.variantId, name: '咖啡色' }]
    );
    const mediaAssets = uniqueManifestAssets(inspected.variants.flatMap((variant) => [...variant.images, ...variant.videos]));

    expect(inspected.issues).toEqual([]);
    expect(inspected.variants[0]?.images.map((asset) => path.basename(asset.relativePath))).toEqual(['07.png', '01.png', '04.png']);
    expect(mediaAssets.filter((asset) => asset.kind === 'image').map((asset) => asset.sortOrder)).toEqual([0, 1, 2]);
  });

  it.each([
    { label: '部分缺失', orders: [0, undefined], message: '全部声明 sortOrder' },
    { label: '重复', orders: [0, 0], message: '重复的 sortOrder' },
    { label: '不连续', orders: [0, 2], message: '从 0 开始且连续' }
  ])('stops OZON initialization when the latest E005 batch has $label sortOrder', async ({ orders, message }) => {
    const fixture = await createFixture();
    const first = await fixture.asset('E005', 'image', 'invalid-images', 'variants/咖啡色/images/01.png', Buffer.from('image-01'), '2026-08-10T01:00:00Z');
    const second = await fixture.asset('E005', 'image', 'invalid-images', 'variants/咖啡色/images/02.png', Buffer.from('image-02'), '2026-08-10T01:00:00Z');
    const ordered = [first, second].map((asset, index) => orders[index] === undefined ? asset : { ...asset, sortOrder: orders[index] });
    await fixture.manifest(ordered);

    await expect(inspectOzonMediaManifest(
      fixture.manifestPath,
      fixture.sku,
      fixture.productName,
      [{ variantId: fixture.variantId, name: '咖啡色' }]
    )).rejects.toMatchObject({ code: 'MEDIA_MANIFEST_INVALID', message: expect.stringContaining(message) });
  });

  it('waits when the current variant has no E004 video', async () => {
    const fixture = await createFixture();
    const image = await fixture.asset('E005', 'image', 'images', 'variants/咖啡色/images/01.png', Buffer.from('image'), '2026-07-27T10:00:00Z');
    await fixture.manifest([image]);

    const inspected = await inspectOzonMediaManifest(fixture.manifestPath, fixture.sku, fixture.productName, [{ variantId: fixture.variantId, name: '咖啡色' }]);

    expect(inspected.issues).toContain('咖啡色：最新 E004 批次必须恰好包含 1 个视频，当前 0 个');
  });

  it('requires exactly the missing publication variants and excludes the default placeholder', () => {
    const placeholder = { variantId: randomUUID(), name: '默认变体' };
    const black = { variantId: randomUUID(), name: '黑色' };
    const wine = { variantId: randomUUID(), name: '深酒红色' };
    const khaki = { variantId: randomUUID(), name: '卡其色' };
    const listing = {
      status: 'PUBLISHED',
      data: { offers: [{ variantId: khaki.variantId, productVariantId: khaki.variantId }] }
    } as any;

    expect(resolveOzonVariantPublicationScope([placeholder, black, wine, khaki], listing)).toEqual({
      mode: 'APPEND_MISSING',
      publicationVariants: [black, wine, khaki],
      representedVariantIds: [khaki.variantId],
      requiredVariantIds: [black.variantId, wine.variantId]
    });
    expect(resolveOzonVariantPublicationScope([placeholder, black, wine, khaki])).toMatchObject({
      mode: 'INITIAL_FULL',
      publicationVariants: [black, wine, khaki],
      requiredVariantIds: [black.variantId, wine.variantId, khaki.variantId]
    });
    expect(resolveOzonVariantPublicationScope([placeholder, black, wine, khaki], {
      status: 'PUBLISHED',
      data: {
        offers: [black, wine, khaki].map((variant) => ({
          offerId: `offer-${variant.variantId}`,
          variantId: variant.variantId,
          productVariantId: variant.variantId
        }))
      }
    } as any)).toMatchObject({
      mode: 'NO_OP',
      requiredVariantIds: [],
      representedVariantIds: [black.variantId, wine.variantId, khaki.variantId]
    });
  });

  it('rejects an already represented variant mixed into a scoped missing-variant round', async () => {
    const fixture = await createFixture();
    const missingVariantId = randomUUID();
    const existingImage = await fixture.asset('E005', 'image', 'existing-images', 'variants/咖啡色/images/01.png', Buffer.from('existing'), '2026-08-08T01:00:00Z');
    const missingImage = {
      ...await fixture.asset('E005', 'image', 'missing-images', 'variants/黑色/images/01.png', Buffer.from('missing'), '2026-08-08T01:00:00Z'),
      variantId: missingVariantId,
      variantName: '黑色'
    };
    const missingVideo = {
      ...await fixture.asset('E004', 'video', 'missing-video', 'variants/黑色/videos/01.mp4', testMp4(12), '2026-08-08T01:01:00Z'),
      variantId: missingVariantId,
      variantName: '黑色'
    };
    await fixture.manifest([existingImage, missingImage, missingVideo]);

    const inspected = await inspectOzonMediaManifest(
      fixture.manifestPath,
      fixture.sku,
      fixture.productName,
      [
        { variantId: fixture.variantId, name: '咖啡色' },
        { variantId: missingVariantId, name: '黑色' }
      ],
      [missingVariantId]
    );

    expect(inspected.issues).toContain(
      `媒体清单包含本轮提交作用域外的变体：${fixture.variantId}；请拆分到下一轮处理`
    );
  });

  it('generates v2 from an automatic manifest draft and injects duration from the actual MP4', async () => {
    const fixture = await createFixture();
    const imageContent = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const videoContent = testMp4(12);
    const image = await fixture.asset('E005', 'image', 'images', 'variants/咖啡色/images/01.png', imageContent, '2026-07-27T10:00:00Z');
    const video = await fixture.asset('E004', 'video', 'video', 'variants/咖啡色/videos/01.mp4', videoContent, '2026-07-27T10:01:00Z');
    await fixture.manifest([image, video]);
    const inspected = await inspectOzonMediaManifest(
      fixture.manifestPath,
      fixture.sku,
      fixture.productName,
      [{ variantId: fixture.variantId, name: '咖啡色' }]
    );
    expect(inspected.issues).toEqual([]);
    const mediaAssets = uniqueManifestAssets(inspected.variants.flatMap((variant) => [...variant.images, ...variant.videos]));
    const imageAsset = mediaAssets.find((asset) => asset.kind === 'image')!;
    const videoAsset = mediaAssets.find((asset) => asset.kind === 'video')!;
    expect(videoAsset.durationSeconds).toBeUndefined();
    let listing = {
      sku: fixture.sku,
      productName: fixture.productName,
      status: 'READY',
      rowVersion: 2,
      revision: 2,
      data: {
        categoryKey: 'ozon_17001_97001',
        categoryVersionId: randomUUID(),
        fulfillmentMode: 'FBS',
        warehouseId: '10001',
        currency: 'RUB',
        vat: '0.2',
        titleRu: 'Тестовый товар',
        descriptionRu: 'Описание товара',
        brand: '无品牌',
        dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 800, weightUnit: 'g' },
        sharedAttributes: [],
        offers: [{
          variantId: fixture.variantId,
          variantCode: '01',
          offerId: `${fixture.sku}-01`,
          barcode: '',
          modelGroup: fixture.sku,
          price: 999,
          oldPrice: 1_299,
          minPrice: 899,
          stock: 10,
          attributes: [],
          media: [
            { assetId: imageAsset.assetId, relativePath: imageAsset.relativePath, kind: 'image', sortOrder: 0, isPrimary: true },
            { assetId: videoAsset.assetId, relativePath: videoAsset.relativePath, kind: 'video', sortOrder: 1, isPrimary: false }
          ]
        }, {
          variantId: randomUUID(),
          variantCode: '02',
          offerId: `${fixture.sku}-02`,
          barcode: '',
          modelGroup: fixture.sku,
          price: 999,
          oldPrice: 1_299,
          minPrice: 899,
          stock: 10,
          attributes: [],
          media: [{ assetId: 'old-missing-asset', relativePath: 'variants/旧色/images/01.png', kind: 'image', sortOrder: 0, isPrimary: true }]
        }],
        mediaAssets: [...mediaAssets, {
          ...imageAsset,
          assetId: 'old-missing-asset',
          relativePath: 'variants/旧色/images/01.png'
        }],
        mediaSourceRoot: fixture.productRoot
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } as any;
    const updateListing = vi.fn(async (_sku: string, input: any) => {
      listing = {
        ...listing,
        rowVersion: listing.rowVersion + 1,
        revision: listing.revision + 1,
        data: Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'rowVersion'))
      };
      return listing;
    });
    const repository = {
      getListing: vi.fn(async () => listing),
      updateListing,
      reserveSubmissionRevision: vi.fn(async () => listing),
      getSettings: vi.fn(async () => ({
        enabled: true,
        rootDirectory: fixture.rootDirectory,
        defaultStoreAlias: 'default'
      })),
      getCategory: vi.fn(async () => ({
        descriptionCategoryId: 17001,
        typeId: 97001,
        publishedVersion: {
          id: randomUUID(),
          versionNo: 4,
          schemaHash: `sha256:${'a'.repeat(64)}`,
          snapshot: {
            attributes: [
              { id: 21845, complexId: 100002 },
              { id: 21837, complexId: 100001 },
              { id: 21841, complexId: 100001 },
              { id: 5299, complexId: 0, type: 'Decimal', required: false },
              { id: 6573, complexId: 0, type: 'Decimal', required: false },
              { id: 5355, complexId: 0, type: 'Decimal', required: false },
              { id: 4383, complexId: 0, type: 'Decimal', required: false }
            ]
          }
        }
      }))
    } as unknown as OzonRepository;
    const purchaseRepository = {
      getPurchase: vi.fn(async () => ({
        procurementVersions: [{
          id: randomUUID(),
          versionNo: 7,
          createdAt: '2026-08-07T01:00:00.000Z',
          productHeightCm: '10',
          productDepthCm: '20',
          productWidthCm: '30',
          netWeightGrams: '450'
        }]
      }))
    } as unknown as PurchaseRepository;
    const service = new OzonPublishingService(
      repository,
      purchaseRepository,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );

    const generated = await (service as any).generateAutomatic(fixture.sku, 2, [`${fixture.sku}-01`]);

    expect(generated.productJson.schemaVersion).toBe(2);
    expect(generated.productJson.offers.map((offer: any) => offer.offerId)).toEqual([`${fixture.sku}-01`]);
    expect(generated.productJson.mediaAssets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        assetId: videoAsset.assetId,
        sha256: videoAsset.sha256,
        durationSeconds: 12
      })
    ]));
    expect(purchaseRepository.getPurchase).toHaveBeenCalledOnce();
    expect(updateListing).toHaveBeenCalledOnce();
    expect(generated.productJson.sharedAttributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ attributeId: 5299 }),
      expect.objectContaining({ attributeId: 6573 }),
      expect.objectContaining({ attributeId: 5355 }),
      expect.objectContaining({ attributeId: 4383 })
    ]));
  });
});

describe('OZON automatic publishing status', () => {
  it('distinguishes the management switch, store eligibility counts and remote finishing jobs', async () => {
    const repository = {
      configured: true,
      stats: vi.fn(async () => ({ WAITING_MEDIA: 1, IMPORTING: 2 })),
      listJobs: vi.fn(async () => ({ items: [], total: 2, page: 1, pageSize: 1 }))
    } as unknown as OzonRepository;
    const publishing = {
      readiness: vi.fn(async () => ({
        ready: false,
        settings: { enabled: false }
      }))
    } as unknown as OzonPublishingService;
    const coordinator = new OzonAutoPublishingCoordinator(
      repository,
      publishing,
      { configured: true } as PurchaseRepository,
      { configured: true } as any,
      {} as any,
      {} as any,
      { read: () => ({ submissionHistory: [] }) } as any,
      {} as FastifyBaseLogger
    );

    await expect(coordinator.status()).resolves.toMatchObject({
      managementEnabled: false,
      acceptingNewJobs: false,
      continuingBoundJobs: 2,
      eligibleAutoStoreCount: 0,
      blockedAutoStoreCount: 0
    });
    expect(repository.listJobs).toHaveBeenCalledWith({
      page: 1,
      pageSize: 1,
      remoteOnly: true,
      activeOnly: true
    });
  });

  it('reports the multistore capability blocker instead of claiming that new jobs are accepted', async () => {
    const repository = {
      configured: true,
      stats: vi.fn(async () => ({})),
      listJobs: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 1 }))
    } as unknown as OzonRepository;
    const publishing = {
      readiness: vi.fn(async () => ({ ready: true, settings: { enabled: true } }))
    } as unknown as OzonPublishingService;
    const coordinator = new OzonAutoPublishingCoordinator(
      repository,
      publishing,
      { configured: true } as PurchaseRepository,
      { configured: true } as any,
      {} as any,
      {} as any,
      { read: () => ({ submissionHistory: [] }) } as any,
      {} as FastifyBaseLogger,
      {},
      {
        storeRepository: {
          isFleetCapabilityReady: vi.fn(() => false),
          listStores: vi.fn(async () => [{
            enabled: true,
            autoPublishEnabled: true,
            autoPublishActivatedAt: '2026-08-11T00:00:00.000Z',
            defaultPresetId: randomUUID(),
            readiness: { ready: true }
          }])
        } as any,
        storeService: {} as any
      }
    );

    await expect(coordinator.status()).resolves.toMatchObject({
      managementEnabled: true,
      acceptingNewJobs: false,
      eligibleAutoStoreCount: 1,
      blockedAutoStoreCount: 0,
      capability: {
        multistoreFleetReady: false,
        blockers: [{
          code: 'OZON_MULTISTORE_FLEET_CAPABILITY_DISABLED'
        }]
      }
    });
  });

  it('leaves materialized per-store publication jobs exclusively to the n8n runtime claimant', async () => {
    const preparation = {
      id: '00000000-0000-4000-8000-000000000060',
      payload: { multistorePreparation: true },
      state: 'READY'
    } as any;
    const publication = {
      id: '00000000-0000-4000-8000-000000000061',
      payload: { mode: 'MULTISTORE_PUBLICATION' },
      state: 'READY'
    } as any;
    const repository = {
      configured: true,
      getSettings: vi.fn(async () => ({ enabled: true, credentialReady: true })),
      listRunnableAutomaticJobs: vi.fn(async () => [publication, preparation])
    } as unknown as OzonRepository;
    const coordinator = new OzonAutoPublishingCoordinator(
      repository,
      {} as OzonPublishingService,
      {} as PurchaseRepository,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );
    const processJob = vi.spyOn(coordinator as any, 'processJob').mockResolvedValue(undefined);
    (coordinator as any).stopped = false;

    await (coordinator as any).workerOnce();

    expect(processJob).toHaveBeenCalledTimes(1);
    expect(processJob).toHaveBeenCalledWith(preparation);
  });

  it('forwards the preparation authorization rowVersion into the existing CAS recheck', async () => {
    const job = {
      id: 'c3ac35ed-0000-4000-8000-000000000001',
      sku: '0000119',
      source: 'AUTO',
      state: 'READY',
      rowVersion: 13
    } as any;
    const recheck = vi.fn(async () => job);
    const rebindAutomaticPreparationAfterMediaRescan = vi.fn(async () => undefined);
    const coordinator = new OzonAutoPublishingCoordinator(
      { configured: true, recheck, rebindAutomaticPreparationAfterMediaRescan } as unknown as OzonRepository,
      {} as OzonPublishingService,
      {} as PurchaseRepository,
      {} as any,
      {} as any,
      {} as any,
      { read: () => ({ submissionHistory: [] }) } as any,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );
    vi.spyOn(coordinator, 'runWorkerNow').mockResolvedValue(undefined);

    await expect(coordinator.recheck(job.id, 12)).resolves.toBe(job);
    expect(rebindAutomaticPreparationAfterMediaRescan).toHaveBeenCalledWith({
      jobId: job.id,
      expectedJobRowVersion: 12
    });
    expect(recheck).toHaveBeenCalledWith(job.id, 'AUTO', 12);
  });

  it('uses the exact automatic media-rescan rebound without running generic recheck', async () => {
    const job = {
      id: '096f4dec-b56b-43f8-bfba-8bed0c8392a9',
      sku: '0000121',
      source: 'AUTO',
      state: 'READY',
      rowVersion: 8
    } as any;
    const recheck = vi.fn();
    const rebindAutomaticPreparationAfterMediaRescan = vi.fn(async () => job);
    const coordinator = new OzonAutoPublishingCoordinator(
      { configured: true, recheck, rebindAutomaticPreparationAfterMediaRescan } as unknown as OzonRepository,
      {} as OzonPublishingService,
      {} as PurchaseRepository,
      {} as any,
      {} as any,
      {} as any,
      { read: () => ({ submissionHistory: [] }) } as any,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );
    vi.spyOn(coordinator, 'runWorkerNow').mockResolvedValue(undefined);

    await expect(coordinator.recheck(job.id, 7)).resolves.toBe(job);
    expect(recheck).not.toHaveBeenCalled();
    expect(rebindAutomaticPreparationAfterMediaRescan).toHaveBeenCalledWith({
      jobId: job.id,
      expectedJobRowVersion: 7
    });
  });
});

describe('OZON automatic media delivery wake-up', () => {
  it('admits shared preparation from the earliest eligible store snapshot', async () => {
    const enqueueAutomaticJob = vi.fn(async () => ({ job: undefined, becameRunnable: false, deferred: false }));
    const repository = {
      configured: true,
      enqueueAutomaticJob,
      getSettings: vi.fn(async () => ({ rootDirectory: 'G:/missing-test-root' })),
      getListing: vi.fn(async () => { throw new AppError('NOT_FOUND', 'OZON 草稿不存在', undefined, 404); })
    } as unknown as OzonRepository;
    const listEligibleAutoStores = vi.fn(async () => ([
      {
        id: '00000000-0000-4000-8000-000000000010',
        defaultPresetId: '00000000-0000-4000-8000-000000000020',
        autoPublishActivatedAt: '2026-08-01T00:00:00.000Z'
      },
      {
        id: '00000000-0000-4000-8000-000000000011',
        defaultPresetId: '00000000-0000-4000-8000-000000000021',
        autoPublishActivatedAt: '2026-08-02T00:00:00.000Z'
      }
    ]));
    const coordinator = new OzonAutoPublishingCoordinator(
      repository,
      {} as OzonPublishingService,
      { getProductIdentityBySku: vi.fn(async () => undefined) } as unknown as PurchaseRepository,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { warn: vi.fn() } as unknown as FastifyBaseLogger,
      {},
      {
        storeRepository: {
          listEligibleAutoStores,
          getStore: vi.fn(),
          completeFanoutPreparation: vi.fn(),
          finalizeMediaFanout: vi.fn()
        } as any,
        storeService: { createAutomaticPublications: vi.fn() } as any
      }
    );

    await coordinator.onMediaDelivered({
      sku: '0000105',
      stageId: 'E005',
      submissionId: 'fanout-images',
      deliveredAt: '2026-08-08T00:00:00.000Z'
    });

    expect(listEligibleAutoStores).toHaveBeenCalledWith('2026-08-08T00:00:00.000Z');
    expect(enqueueAutomaticJob).toHaveBeenCalledWith(expect.objectContaining({
      sku: '0000105',
      multistoreAdmission: {
        storeId: '00000000-0000-4000-8000-000000000010',
        presetId: '00000000-0000-4000-8000-000000000020',
        activatedAt: '2026-08-01T00:00:00.000Z'
      }
    }));
  });

  it('does not enqueue #31 automatic work until the exact store-scoped no-brand dictionary proof passes', async () => {
    const enqueueAutomaticJob = vi.fn(async () => ({ job: undefined, becameRunnable: false, deferred: false }));
    const repository = {
      configured: true,
      enqueueAutomaticJob,
      getSettings: vi.fn(async () => ({ rootDirectory: 'G:/missing-test-root' })),
      getListing: vi.fn(async () => { throw new AppError('NOT_FOUND', 'OZON 草稿不存在', undefined, 404); })
    } as unknown as OzonRepository;
    const eligibleStore = {
      id: '00000000-0000-4000-8000-000000000010',
      storeAlias: 'glauke',
      configVersion: 4,
      credential: { activeVersionId: '00000000-0000-4000-8000-000000000050' },
      defaultPresetId: '00000000-0000-4000-8000-000000000020',
      presetRowVersion: 5,
      autoPublishActivatedAt: '2026-08-01T00:00:00.000Z',
      noBrandDictionaryRequirement: {
        descriptionCategoryId: 15621048,
        typeId: 91248,
        attributeId: 31,
        dictionaryId: 28732849,
        categoryVersionId: '00000000-0000-4000-8000-000000000060'
      }
    };
    const proveExactNoBrandDictionaryValue = vi.fn()
      .mockRejectedValueOnce(new AppError('CONFIG_INVALID', 'Нет бренда 不唯一', undefined, 409))
      .mockResolvedValueOnce({ dictionaryValueId: 126745801, value: 'Нет бренда' });
    const coordinator = new OzonAutoPublishingCoordinator(
      repository,
      {} as OzonPublishingService,
      { getProductIdentityBySku: vi.fn(async () => undefined) } as unknown as PurchaseRepository,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { warn: vi.fn() } as unknown as FastifyBaseLogger,
      {},
      {
        storeRepository: { listEligibleAutoStores: vi.fn(async () => [eligibleStore]) } as any,
        storeService: {} as any,
        storeGateway: { proveExactNoBrandDictionaryValue } as any
      }
    );
    const delivery = {
      sku: '0000152',
      stageId: 'E005' as const,
      submissionId: 'no-brand-proof',
      deliveredAt: '2026-08-24T00:00:00.000Z'
    };

    await expect(coordinator.onMediaDelivered(delivery)).resolves.toBeUndefined();
    expect(enqueueAutomaticJob).not.toHaveBeenCalled();

    await coordinator.onMediaDelivered({ ...delivery, submissionId: 'no-brand-proof-confirmed' });
    expect(enqueueAutomaticJob).toHaveBeenCalledOnce();
    expect(proveExactNoBrandDictionaryValue).toHaveBeenNthCalledWith(2, {
      storeId: eligibleStore.id,
      expectedStoreConfigVersion: 4,
      expectedCredentialVersionId: '00000000-0000-4000-8000-000000000050',
      categoryVersionId: '00000000-0000-4000-8000-000000000060',
      presetRowVersion: 5,
      descriptionCategoryId: 15621048,
      typeId: 91248,
      attributeId: 31,
      dictionaryId: 28732849
    });
    expect(proveExactNoBrandDictionaryValue.mock.calls[1]?.[0]).not.toHaveProperty('leaseToken');
  });

  it('never falls back to the legacy credential after the default store has activated Vault', async () => {
    const enqueueAutomaticJob = vi.fn();
    const repository = {
      configured: true,
      enqueueAutomaticJob,
      getSettings: vi.fn(async () => ({ rootDirectory: 'G:/missing-test-root', credentialReady: true })),
      getListing: vi.fn(async () => { throw new AppError('NOT_FOUND', 'OZON 草稿不存在', undefined, 404); })
    } as unknown as OzonRepository;
    const coordinator = new OzonAutoPublishingCoordinator(
      repository,
      {} as OzonPublishingService,
      { getProductIdentityBySku: vi.fn(async () => undefined) } as unknown as PurchaseRepository,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { warn: vi.fn() } as unknown as FastifyBaseLogger,
      {},
      {
        storeRepository: {
          listEligibleAutoStores: vi.fn(async () => []),
          getStore: vi.fn(async () => ({
            id: '00000000-0000-4000-8000-000000000002',
            enabled: true,
            autoPublishEnabled: true,
            autoPublishActivatedAt: '2026-08-01T00:00:00.000Z',
            credential: {
              bindingMode: 'VAULT',
              activeVersionId: '00000000-0000-4000-8000-000000000050'
            }
          })),
          completeFanoutPreparation: vi.fn(),
          finalizeMediaFanout: vi.fn()
        } as any,
        storeService: { createAutomaticPublications: vi.fn() } as any
      }
    );

    await expect(coordinator.onMediaDelivered({
      sku: '0000105',
      stageId: 'E005',
      submissionId: 'no-silent-fallback',
      deliveredAt: '2026-08-08T00:00:00.000Z'
    })).resolves.toBeUndefined();
    expect(enqueueAutomaticJob).not.toHaveBeenCalled();
  });

  it('durably defers a capability-gated delivery without creating a preparation job', async () => {
    const deferAutomaticMediaDeliveryForCapability = vi.fn(async () => ({
      job: undefined,
      becameRunnable: false,
      deferred: true
    }));
    const enqueueAutomaticJob = vi.fn();
    const listEligibleAutoStores = vi.fn();
    const repository = {
      configured: true,
      deferAutomaticMediaDeliveryForCapability,
      enqueueAutomaticJob
    } as unknown as OzonRepository;
    const coordinator = new OzonAutoPublishingCoordinator(
      repository,
      {} as OzonPublishingService,
      {} as PurchaseRepository,
      {} as any,
      {} as any,
      {} as any,
      { read: () => ({ submissionHistory: [] }) } as any,
      { warn: vi.fn() } as unknown as FastifyBaseLogger,
      {},
      {
        storeRepository: {
          isFleetCapabilityReady: vi.fn(() => false),
          listEligibleAutoStores
        } as any,
        storeService: {} as any
      }
    );
    const delivery = {
      sku: '0000119',
      stageId: 'E005' as const,
      submissionId: '9dfe696b-f740-4eda-aa61-eac625b0b247',
      variantId: '6cae502a-0651-4732-812d-6c2a7f4a00e1',
      deliveredAt: '2026-08-11T07:26:00.004Z',
      resolvedOutputRoot: 'G:/safe/ozon/inbox/0000119',
      selectedRelativePaths: ['variants/dark-brown/images/01.png']
    };

    await expect(coordinator.onMediaDelivered(delivery)).resolves.toBeUndefined();
    expect(deferAutomaticMediaDeliveryForCapability).toHaveBeenCalledWith({
      sku: delivery.sku,
      media: {
        sourceStageId: delivery.stageId,
        submissionId: delivery.submissionId,
        variantId: delivery.variantId,
        deliveredAt: delivery.deliveredAt,
        resolvedOutputRoot: delivery.resolvedOutputRoot,
        selectedRelativePaths: delivery.selectedRelativePaths
      }
    });
    expect(listEligibleAutoStores).not.toHaveBeenCalled();
    expect(enqueueAutomaticJob).not.toHaveBeenCalled();
  });

  it('replays capability-deferred identities as one batch before starting the worker', async () => {
    const variantId = '6cae502a-0651-4732-812d-6c2a7f4a00e1';
    const deliveries = [
      {
        sku: '0000119',
        sourceStageId: 'E004' as const,
        submissionId: '72e3276d-a297-4ed5-9e21-9bce2b342c29',
        variantId,
        payload: {
          deliveredAt: '2026-08-11T07:25:45.012Z',
          autoPublishDecision: 'DEFERRED',
          autoPublishDeferredReason: 'OZON_MULTISTORE_FLEET_CAPABILITY_DISABLED'
        }
      },
      {
        sku: '0000119',
        sourceStageId: 'E005' as const,
        submissionId: '9dfe696b-f740-4eda-aa61-eac625b0b247',
        variantId,
        payload: {
          deliveredAt: '2026-08-11T07:26:00.004Z',
          autoPublishDecision: 'DEFERRED',
          autoPublishDeferredReason: 'OZON_MULTISTORE_FLEET_CAPABILITY_DISABLED'
        }
      }
    ];
    let fleetReady = false;
    const order: string[] = [];
    const preparationJob = { id: randomUUID(), sku: '0000119', source: 'AUTO', state: 'READY' } as any;
    const deferAutomaticMediaDeliveryForCapability = vi.fn(async () => ({
      job: undefined,
      becameRunnable: false,
      deferred: true
    }));
    const enqueueAutomaticJob = vi.fn(async (input: { media: { sourceStageId: string } }) => {
      order.push(`enqueue:${input.media.sourceStageId}`);
      return {
        job: preparationJob,
        becameRunnable: input.media.sourceStageId === 'E004',
        deferred: false
      };
    });
    const repository = {
      configured: true,
      listDeferredAutomaticMediaDeliveries: vi.fn(async () => deliveries),
      deferAutomaticMediaDeliveryForCapability,
      enqueueAutomaticJob
    } as unknown as OzonRepository;
    const coordinator = new OzonAutoPublishingCoordinator(
      repository,
      {} as OzonPublishingService,
      {} as PurchaseRepository,
      {} as any,
      {} as any,
      {} as any,
      { read: () => ({ submissionHistory: [] }) } as any,
      { warn: vi.fn() } as unknown as FastifyBaseLogger,
      {},
      {
        storeRepository: {
          isFleetCapabilityReady: vi.fn(() => fleetReady),
          listEligibleAutoStores: vi.fn(async () => [{
            id: '00000000-0000-4000-8000-000000000002',
            defaultPresetId: '45c2fbb2-fa2c-4bbc-a2be-c8393d507adf',
            autoPublishActivatedAt: '2026-08-09T06:59:30.377Z'
          }])
        } as any,
        storeService: {} as any
      }
    );
    vi.spyOn(coordinator as any, 'inspectDeliveredMediaReadiness').mockResolvedValue(true);
    const runWorkerNow = vi.spyOn(coordinator, 'runWorkerNow').mockImplementation(async () => {
      order.push('worker');
    });

    await coordinator.reconcileNow();
    expect(deferAutomaticMediaDeliveryForCapability).toHaveBeenCalledTimes(2);
    expect(enqueueAutomaticJob).not.toHaveBeenCalled();
    expect(runWorkerNow).not.toHaveBeenCalled();

    fleetReady = true;
    await coordinator.reconcileNow();

    expect(enqueueAutomaticJob).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['enqueue:E004', 'enqueue:E005', 'worker']);
    expect(runWorkerNow).toHaveBeenCalledOnce();
  });

  it('freezes one shared-material fan-out and preserves per-store partial failure', async () => {
    const variantId = '00000000-0000-4000-8000-000000000020';
    const completeFanoutPreparation = vi.fn(async () => undefined);
    const finalizeMediaFanout = vi.fn(async () => true);
    const listEligibleAutoStores = vi.fn(async () => ([
      { id: '00000000-0000-4000-8000-000000000010' },
      { id: '00000000-0000-4000-8000-000000000011' }
    ]));
    const createAutomaticPublicationsFromFrozenPlan = vi.fn()
      .mockResolvedValueOnce({
        publications: [{ id: '00000000-0000-4000-8000-000000000030' }],
        failures: [{ storeId: '00000000-0000-4000-8000-000000000011', storeAlias: 'second', code: 'TEST_FAILURE', message: 'second failed' }],
        accepted: 1, failed: 1
      });
    const frozenPlanHash = `sha256:${'a'.repeat(64)}`;
    const automaticPublicationPlan = vi.fn(async (_sku: string, _rowVersion: number, storeIds: string[]) => ({
      planHash: frozenPlanHash,
      generatedVersionId: '00000000-0000-4000-8000-000000000050',
      revision: 2,
      contentPolicyVersion: 'merchroute-ozon-content-v3',
      materialHash: `sha256:${'b'.repeat(64)}`,
      materialHashVersion: 'ozon-shared-material-v1',
      items: storeIds.map((storeId, index) => ({
        storeId,
        publicationId: `00000000-0000-4000-8000-00000000003${index + 1}`,
        plannedJobId: `00000000-0000-4000-8000-00000000004${index + 1}`,
        taskId: `store-${index + 1}__0000105__r2`
      }))
    }));
    let frozenPlan: Record<string, unknown> = {};
    const freezePreparationFanoutPlan = vi.fn(async (_jobId: string, _rowVersion: number, plan: Record<string, unknown>) => {
      frozenPlan = structuredClone(plan);
      return frozenPlan;
    });
    const resolveAutomaticMediaDeliveryEvidence = vi.fn(async () => ([
      {
        sourceStageId: 'E005', submissionId: 'images', variantId,
        deliveredAt: '2026-08-08T00:00:00.000Z', decision: 'ACCEPTED',
        jobId: '00000000-0000-4000-8000-000000000040'
      },
      {
        sourceStageId: 'E004', submissionId: 'video', variantId,
        deliveredAt: '2026-08-08T00:01:00.000Z', decision: 'ACCEPTED',
        jobId: '00000000-0000-4000-8000-000000000040'
      }
    ]));
    const coordinator = new OzonAutoPublishingCoordinator(
      {
        configured: true,
        resolveAutomaticMediaDeliveryEvidence,
        getJob: vi.fn(async () => ({ ...job, payload: { ...job.payload, fanoutPlan: frozenPlan } }))
      } as unknown as OzonRepository,
      {} as OzonPublishingService,
      {} as PurchaseRepository,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { warn: vi.fn() } as unknown as FastifyBaseLogger,
      {},
      {
        storeRepository: {
          listEligibleAutoStores,
          getStore: vi.fn(),
          freezePreparationFanoutPlan,
          completeFanoutPreparation,
          finalizeMediaFanout
        } as any,
        storeService: { automaticPublicationPlan, createAutomaticPublicationsFromFrozenPlan } as any
      }
    );
    const job = {
      id: '00000000-0000-4000-8000-000000000040',
      rowVersion: 9,
      payload: {
        multistorePreparation: true,
        mediaDeliveries: [
          { sourceStageId: 'E005', submissionId: 'images', variantId, deliveredAt: '2026-08-08T00:00:00.000Z' },
          { sourceStageId: 'E004', submissionId: 'video', variantId, deliveredAt: '2026-08-08T00:01:00.000Z' }
        ]
      }
    } as unknown as import('@n8n-media-review/shared').OzonPublishJob;
    const listing = {
      sku: '0000105',
      rowVersion: 7,
      data: {
        offers: [{
          productVariantId: variantId,
          media: [{ assetId: 'image-1' }, { assetId: 'video-1' }]
        }],
        mediaAssets: [
          {
            assetId: 'image-1', sourceStageId: 'E005', sourceSubmissionId: 'images',
            productVariantId: variantId, deliveredAt: '2026-08-08T00:00:00.037Z'
          },
          {
            assetId: 'video-1', sourceStageId: 'E004', sourceSubmissionId: 'video',
            productVariantId: variantId, deliveredAt: '2026-08-08T00:01:00.050Z'
          },
          {
            assetId: 'unreferenced-new-image', sourceStageId: 'E005', sourceSubmissionId: 'new-images',
            productVariantId: variantId, deliveredAt: '2026-08-08T00:02:00.000Z'
          }
        ]
      }
    } as unknown as import('@n8n-media-review/shared').OzonListingDraft;

    await (coordinator as any).dispatchPreparedListing(job, listing, {}, { enabled: true });

    expect(resolveAutomaticMediaDeliveryEvidence).toHaveBeenCalledWith({
      sku: '0000105',
      identities: expect.arrayContaining([
        expect.objectContaining({ sourceStageId: 'E005', submissionId: 'images', variantId }),
        expect.objectContaining({ sourceStageId: 'E004', submissionId: 'video', variantId })
      ])
    });
    expect(listEligibleAutoStores).toHaveBeenCalledOnce();
    expect(listEligibleAutoStores).toHaveBeenCalledWith('2026-08-08T00:01:00.000Z');
    expect(automaticPublicationPlan).toHaveBeenCalledWith(
      '0000105', 7,
      ['00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000011']
    );
    expect(freezePreparationFanoutPlan).toHaveBeenCalledWith(job.id, job.rowVersion, expect.objectContaining({
      planHash: frozenPlanHash,
      items: [
        expect.objectContaining({ storeId: '00000000-0000-4000-8000-000000000010' }),
        expect.objectContaining({ storeId: '00000000-0000-4000-8000-000000000011' })
      ]
    }));
    expect(createAutomaticPublicationsFromFrozenPlan).toHaveBeenCalledOnce();
    expect(createAutomaticPublicationsFromFrozenPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planHash: frozenPlanHash }),
      expect.objectContaining({ sourceStageId: 'E004', submissionId: 'video', variantId }),
      job.id
    );
    expect(finalizeMediaFanout).not.toHaveBeenCalled();
    expect(completeFanoutPreparation).toHaveBeenCalledOnce();
    expect(completeFanoutPreparation).toHaveBeenCalledWith(job.id, expect.objectContaining({
      publicationIds: [
        '00000000-0000-4000-8000-000000000030'
      ],
      failures: [expect.objectContaining({
        code: 'TEST_FAILURE',
        deliveryIdentities: expect.arrayContaining([
          expect.objectContaining({ sourceStageId: 'E005', submissionId: 'images' }),
          expect.objectContaining({ sourceStageId: 'E004', submissionId: 'video' })
        ])
      })]
    }));
  });

  it('does not plan or freeze a store when its #31 no-brand dictionary proof fails at fan-out', async () => {
    const variantId = '00000000-0000-4000-8000-000000000020';
    const jobId = '00000000-0000-4000-8000-000000000040';
    const completeFanoutPreparation = vi.fn(async () => undefined);
    const freezePreparationFanoutPlan = vi.fn();
    const automaticPublicationPlan = vi.fn();
    const createAutomaticPublicationsFromFrozenPlan = vi.fn();
    const proveExactNoBrandDictionaryValue = vi.fn(async () => {
      throw new AppError('CONFIG_INVALID', 'Нет бренда 字典缺失', undefined, 409);
    });
    const coordinator = new OzonAutoPublishingCoordinator(
      {
        configured: true,
        resolveAutomaticMediaDeliveryEvidence: vi.fn(async () => ([{
          sourceStageId: 'E004',
          submissionId: 'video',
          variantId,
          deliveredAt: '2026-08-24T00:01:00.000Z',
          decision: 'ACCEPTED',
          jobId
        }]))
      } as unknown as OzonRepository,
      {} as OzonPublishingService,
      {} as PurchaseRepository,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { warn: vi.fn() } as unknown as FastifyBaseLogger,
      {},
      {
        storeRepository: {
          listEligibleAutoStores: vi.fn(async () => [{
            id: '00000000-0000-4000-8000-000000000010',
            storeAlias: 'glauke',
            configVersion: 4,
            credential: { activeVersionId: '00000000-0000-4000-8000-000000000050' },
            defaultPresetId: '00000000-0000-4000-8000-000000000030',
            presetRowVersion: 5,
            noBrandDictionaryRequirement: {
              descriptionCategoryId: 15621048,
              typeId: 91248,
              attributeId: 31,
              dictionaryId: 28732849,
              categoryVersionId: '00000000-0000-4000-8000-000000000060'
            }
          }]),
          freezePreparationFanoutPlan,
          completeFanoutPreparation,
          finalizeMediaFanoutBatch: vi.fn()
        } as any,
        storeService: { automaticPublicationPlan, createAutomaticPublicationsFromFrozenPlan } as any,
        storeGateway: { proveExactNoBrandDictionaryValue } as any
      }
    );
    const job = {
      id: jobId,
      rowVersion: 9,
      payload: {
        multistorePreparation: true,
        mediaDeliveries: [{
          sourceStageId: 'E004', submissionId: 'video', variantId,
          deliveredAt: '2026-08-24T00:01:00.000Z'
        }]
      }
    } as unknown as import('@n8n-media-review/shared').OzonPublishJob;
    const listing = {
      sku: '0000152',
      rowVersion: 7,
      data: {
        offers: [{ productVariantId: variantId, media: [{ assetId: 'video-1' }] }],
        mediaAssets: [{
          assetId: 'video-1', sourceStageId: 'E004', sourceSubmissionId: 'video',
          productVariantId: variantId, deliveredAt: '2026-08-24T00:01:00.000Z'
        }]
      }
    } as unknown as import('@n8n-media-review/shared').OzonListingDraft;

    await (coordinator as any).dispatchPreparedListing(job, listing, {}, { enabled: true });

    expect(proveExactNoBrandDictionaryValue).toHaveBeenCalledOnce();
    expect(automaticPublicationPlan).not.toHaveBeenCalled();
    expect(freezePreparationFanoutPlan).not.toHaveBeenCalled();
    expect(createAutomaticPublicationsFromFrozenPlan).not.toHaveBeenCalled();
    expect(completeFanoutPreparation).toHaveBeenCalledWith(jobId, {
      publicationIds: [],
      storeIds: [],
      failures: [expect.objectContaining({ code: 'OZON_NO_ELIGIBLE_AUTO_STORE' })]
    });
  });

  it.each([
    {
      label: 'missing source identity',
      asset: {
        assetId: 'video-1', sourceStageId: 'E004',
        productVariantId: '00000000-0000-4000-8000-000000000020',
        deliveredAt: '2026-08-08T00:01:00.000Z'
      },
      code: 'OZON_MEDIA_DELIVERY_IDENTITY_MISSING'
    },
    {
      label: 'trigger identity not referenced',
      asset: {
        assetId: 'video-1', sourceStageId: 'E004', sourceSubmissionId: 'other-video',
        productVariantId: '00000000-0000-4000-8000-000000000020',
        deliveredAt: '2026-08-08T00:02:00.000Z'
      },
      code: 'OZON_MEDIA_DELIVERY_IDENTITY_DRIFT'
    }
  ])('fails closed before fan-out for $label in referenced frozen media', async ({ asset, code }) => {
    const completeFanoutPreparation = vi.fn();
    const createAutomaticPublications = vi.fn();
    const coordinator = new OzonAutoPublishingCoordinator(
      {
        configured: true,
        resolveAutomaticMediaDeliveryEvidence: vi.fn(async () => [])
      } as unknown as OzonRepository,
      {} as OzonPublishingService,
      {} as PurchaseRepository,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { warn: vi.fn() } as unknown as FastifyBaseLogger,
      {},
      {
        storeRepository: {
          listEligibleAutoStores: vi.fn(), completeFanoutPreparation, finalizeMediaFanout: vi.fn()
        } as any,
        storeService: { createAutomaticPublications } as any
      }
    );
    const job = {
      id: '00000000-0000-4000-8000-000000000040',
      payload: {
        multistorePreparation: true,
        mediaDeliveries: [{
          sourceStageId: 'E004', submissionId: 'video',
          variantId: '00000000-0000-4000-8000-000000000020',
          deliveredAt: '2026-08-08T00:01:00.000Z'
        }]
      }
    } as any;
    const listing = {
      sku: '0000105', rowVersion: 7,
      data: {
        offers: [{ media: [{ assetId: 'video-1' }] }],
        mediaAssets: [asset]
      }
    } as any;

    await expect((coordinator as any).dispatchPreparedListing(job, listing, {}, { enabled: true }))
      .rejects.toMatchObject({ code });
    expect(completeFanoutPreparation).not.toHaveBeenCalled();
    expect(createAutomaticPublications).not.toHaveBeenCalled();
  });

  it('replays the durable ledger across a deferred pass and only caches it after consumption', async () => {
    const variantId = randomUUID();
    const durableDelivery = {
      sku: '0000105',
      sourceStageId: 'E005' as const,
      submissionId: 'durable-black-images',
      variantId,
      payload: {
        deliveredAt: '2026-08-08T07:48:00.000Z',
        resolvedOutputRoot: 'G:/01_MerchRoute/OZON-Auto-Publish/inbox/0000105',
        selectedRelativePaths: ['variants/黑色/images/01.png'],
        autoPublishDecision: 'DEFERRED'
      }
    };
    const enqueueAutomaticJob = vi.fn()
      .mockResolvedValueOnce({ job: undefined, becameRunnable: false, deferred: true })
      .mockResolvedValueOnce({ job: undefined, becameRunnable: false, deferred: false });
    const repository = {
      configured: true,
      listDeferredAutomaticMediaDeliveries: vi.fn()
        .mockResolvedValueOnce([durableDelivery])
        .mockResolvedValueOnce([durableDelivery])
        .mockResolvedValueOnce([]),
      enqueueAutomaticJob,
      getSettings: vi.fn(async () => ({ rootDirectory: 'G:/missing-test-root' })),
      getListing: vi.fn(async () => { throw new AppError('NOT_FOUND', 'OZON 草稿不存在', undefined, 404); })
    } as unknown as OzonRepository;
    const coordinator = new OzonAutoPublishingCoordinator(
      repository,
      {} as OzonPublishingService,
      {
        configured: true,
        getProductIdentityBySku: vi.fn(async () => ({
          sku: '0000105', productName: '潮流单肩包', variants: [{ variantId, name: '黑色' }]
        }))
      } as unknown as PurchaseRepository,
      { configured: true } as any,
      {} as any,
      {} as any,
      { read: () => ({ submissionHistory: [] }) } as any,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );

    await coordinator.reconcileNow();
    await coordinator.reconcileNow();
    await coordinator.reconcileNow();

    expect(repository.listDeferredAutomaticMediaDeliveries).toHaveBeenCalledTimes(3);
    expect(enqueueAutomaticJob).toHaveBeenCalledTimes(2);
    expect(enqueueAutomaticJob).toHaveBeenCalledWith({
      sku: '0000105',
      mediaReady: false,
      media: {
        sourceStageId: 'E005',
        submissionId: 'durable-black-images',
        variantId,
        deliveredAt: '2026-08-08T07:48:00.000Z',
        resolvedOutputRoot: 'G:/01_MerchRoute/OZON-Auto-Publish/inbox/0000105',
        selectedRelativePaths: ['variants/黑色/images/01.png']
      }
    });
  });

  it('lets a rebound durable row override an older terminal in-memory reconciliation key', async () => {
    const variantId = randomUUID();
    const delivery = (decision: 'DEFERRED' | 'ACCEPTED') => ({
      sku: '0000106',
      sourceStageId: 'E004' as const,
      submissionId: 'rebound-green-video',
      variantId,
      payload: {
        deliveredAt: '2026-08-08T07:49:00.000Z',
        autoPublishDecision: decision
      }
    });
    const enqueueAutomaticJob = vi.fn(async () => ({
      job: undefined,
      becameRunnable: false,
      deferred: false
    }));
    const repository = {
      configured: true,
      listDeferredAutomaticMediaDeliveries: vi.fn()
        .mockResolvedValueOnce([delivery('DEFERRED')])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([delivery('ACCEPTED')]),
      enqueueAutomaticJob,
      getSettings: vi.fn(async () => ({ rootDirectory: 'G:/missing-test-root' })),
      getListing: vi.fn(async () => { throw new AppError('NOT_FOUND', 'OZON 草稿不存在', undefined, 404); })
    } as unknown as OzonRepository;
    const coordinator = new OzonAutoPublishingCoordinator(
      repository,
      {} as OzonPublishingService,
      {
        configured: true,
        getProductIdentityBySku: vi.fn(async () => ({
          sku: '0000106', productName: '绿色测试商品', variants: [{ variantId, name: '绿色' }]
        }))
      } as unknown as PurchaseRepository,
      { configured: true } as any,
      {} as any,
      {} as any,
      { read: () => ({ submissionHistory: [] }) } as any,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );

    await coordinator.reconcileNow();
    await coordinator.reconcileNow();
    await coordinator.reconcileNow();

    expect(enqueueAutomaticJob).toHaveBeenCalledTimes(2);
    expect(enqueueAutomaticJob.mock.calls[1]?.[0]).toMatchObject({
      sku: '0000106',
      media: { sourceStageId: 'E004', submissionId: 'rebound-green-video', variantId }
    });
  });

  it('does not cache a delivery while it is attached to an automatic round', async () => {
    const variantId = randomUUID();
    const attachedJob = { id: randomUUID(), sku: '0000106', source: 'AUTO', state: 'READY' };
    const enqueueAutomaticJob = vi.fn(async () => ({
      job: attachedJob,
      becameRunnable: false,
      deferred: false
    }));
    const repository = {
      configured: true,
      listDeferredAutomaticMediaDeliveries: vi.fn(async () => [{
        sku: '0000106',
        sourceStageId: 'E004',
        submissionId: 'durable-green-video',
        variantId,
        payload: {
          deliveredAt: '2026-08-08T07:49:00.000Z',
          autoPublishDecision: 'ACCEPTED'
        }
      }]),
      enqueueAutomaticJob,
      getSettings: vi.fn(async () => ({ rootDirectory: 'G:/missing-test-root' })),
      getListing: vi.fn(async () => { throw new AppError('NOT_FOUND', 'OZON 草稿不存在', undefined, 404); })
    } as unknown as OzonRepository;
    const coordinator = new OzonAutoPublishingCoordinator(
      repository,
      {} as OzonPublishingService,
      {
        configured: true,
        getProductIdentityBySku: vi.fn(async () => ({
          sku: '0000106', productName: '绿色测试商品', variants: [{ variantId, name: '绿色' }]
        }))
      } as unknown as PurchaseRepository,
      { configured: true } as any,
      {} as any,
      {} as any,
      { read: () => ({ submissionHistory: [] }) } as any,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );

    await coordinator.reconcileNow();
    await coordinator.reconcileNow();

    expect(enqueueAutomaticJob).toHaveBeenCalledTimes(2);
  });

  it('passes manifest-backed mediaReady and starts the worker only for a runnable transition', async () => {
    const fixture = await createFixture();
    const image = await fixture.asset(
      'E005',
      'image',
      'delivery-images',
      'variants/咖啡色/images/01.png',
      Buffer.from('delivery-image'),
      '2026-08-08T00:00:00.000Z'
    );
    await fixture.manifest([image]);
    const enqueueAutomaticJob = vi.fn();
    const repository = {
      configured: true,
      enqueueAutomaticJob,
      getSettings: vi.fn(async () => ({ rootDirectory: fixture.rootDirectory })),
      getListing: vi.fn(async () => { throw new AppError('NOT_FOUND', 'OZON 草稿不存在', undefined, 404); })
    } as unknown as OzonRepository;
    const purchases = {
      getProductIdentityBySku: vi.fn(async () => ({
        sku: fixture.sku,
        productName: fixture.productName,
        variants: [{ variantId: fixture.variantId, name: '咖啡色' }]
      }))
    } as unknown as PurchaseRepository;
    const coordinator = new OzonAutoPublishingCoordinator(
      repository,
      {} as OzonPublishingService,
      purchases,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );
    const runWorkerNow = vi.spyOn(coordinator, 'runWorkerNow').mockResolvedValue();
    const delivery = {
      sku: fixture.sku,
      stageId: 'E005',
      submissionId: 'delivery-1',
      variantId: fixture.variantId,
      deliveredAt: '2026-08-08T00:00:00.000Z'
    } as const;

    enqueueAutomaticJob.mockResolvedValueOnce({
      job: { id: randomUUID(), state: 'NEEDS_ATTENTION' },
      becameRunnable: false
    });
    await coordinator.onMediaDelivered(delivery);
    expect(enqueueAutomaticJob).toHaveBeenNthCalledWith(1, expect.objectContaining({ mediaReady: false }));
    expect(runWorkerNow).not.toHaveBeenCalled();

    const video = await fixture.asset(
      'E004',
      'video',
      'delivery-video',
      'variants/咖啡色/videos/01.mp4',
      testMp4(12),
      '2026-08-08T00:01:00.000Z'
    );
    await fixture.manifest([image, video]);
    enqueueAutomaticJob.mockResolvedValueOnce({
      job: { id: randomUUID(), state: 'READY' },
      becameRunnable: true
    });
    await coordinator.onMediaDelivered({ ...delivery, submissionId: 'delivery-2' });
    expect(enqueueAutomaticJob).toHaveBeenNthCalledWith(2, expect.objectContaining({ mediaReady: true }));
    expect(runWorkerNow).toHaveBeenCalledOnce();
  });

  it('keeps mediaReady false when the manifest omits a PostgreSQL product variant', async () => {
    const fixture = await createFixture();
    const image = await fixture.asset('E005', 'image', 'images', 'variants/咖啡色/images/01.png', Buffer.from('image'), '2026-08-08T00:00:00.000Z');
    const video = await fixture.asset('E004', 'video', 'video', 'variants/咖啡色/videos/01.mp4', testMp4(12), '2026-08-08T00:01:00.000Z');
    await fixture.manifest([image, video]);
    const enqueueAutomaticJob = vi.fn(async () => ({ job: undefined, becameRunnable: false }));
    const coordinator = new OzonAutoPublishingCoordinator(
      {
        configured: true,
        enqueueAutomaticJob,
        getSettings: vi.fn(async () => ({ rootDirectory: fixture.rootDirectory })),
        getListing: vi.fn(async () => { throw new AppError('NOT_FOUND', 'OZON 草稿不存在', undefined, 404); })
      } as unknown as OzonRepository,
      {} as OzonPublishingService,
      {
        getProductIdentityBySku: vi.fn(async () => ({
          sku: fixture.sku,
          productName: fixture.productName,
          variants: [
            { variantId: fixture.variantId, name: '咖啡色' },
            { variantId: randomUUID(), name: '黑色' }
          ]
        }))
      } as unknown as PurchaseRepository,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );

    await coordinator.onMediaDelivered({
      sku: fixture.sku,
      stageId: 'E004',
      submissionId: 'identity-coverage',
      deliveredAt: '2026-08-08T00:01:00.000Z'
    });

    expect(enqueueAutomaticJob).toHaveBeenCalledWith(expect.objectContaining({ mediaReady: false }));
  });
});

describe('OZON automatic shared-material market-field boundary', () => {
  it('keeps normal repeated pocket prose as a warning and continues the automatic fan-out', async () => {
    const harness = await createAutoGrossWeightHarness({ procurementGrossWeightGrams: '650' });
    const normalPocketDescription = 'Карман на молнии, открытый накладной карман для мелочей, на задней стенке предусмотрен дополнительный горизонтальный карман';
    harness.descriptions.resolveVariants.mockResolvedValue({
      status: 'READY',
      content: normalPocketDescription,
      source: {
        workflowCode: 'E003', executionId: 170, folderName: '0000170', fileName: 'detail.txt',
        sha256: 'a'.repeat(64), productVariantId: harness.fixture.variantId
      },
      variantSources: [{
        status: 'READY',
        productVariantId: harness.fixture.variantId,
        productVariantName: '咖啡色',
        content: normalPocketDescription,
        source: {
          workflowCode: 'E003', executionId: 170, folderName: '0000170', fileName: 'detail.txt',
          sha256: 'b'.repeat(64), productVariantId: harness.fixture.variantId
        }
      }]
    });

    await expect((harness.coordinator as any).processJob(harness.job())).resolves.toBeUndefined();

    expect(harness.persistAutomaticSharedMaterialRevision).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        descriptionRu: normalPocketDescription,
        offers: expect.arrayContaining([expect.objectContaining({
          productVariantId: harness.fixture.variantId,
          descriptionRu: normalPocketDescription
        })])
      })
    }));
    expect(harness.storeService.createAutomaticPublicationsFromFrozenPlan).toHaveBeenCalledOnce();
    expect(harness.job().state).not.toBe('NEEDS_ATTENTION');
  });

  it('prepares shared material without reading procurement, pricing, title translation, or a global preset', async () => {
    const harness = await createAutoGrossWeightHarness({
      procurementGrossWeightGrams: '650.5',
      pricingFailures: 1
    });

    await expect((harness.coordinator as any).processJob(harness.job())).resolves.toBeUndefined();

    expect(harness.pricing.calculate).not.toHaveBeenCalled();
    expect(harness.purchases.getPurchase).not.toHaveBeenCalled();
    expect(harness.titleTranslator.translate).not.toHaveBeenCalled();
    expect((harness.coordinator.repository as any).getPreset).not.toHaveBeenCalled();
    expect((harness.coordinator.repository as any).getDefaultPreset).not.toHaveBeenCalled();
    const saved = harness.updateListing.mock.calls[0]![1] as any;
    expect(saved).not.toHaveProperty('dimensions');
    expect(saved).not.toHaveProperty('initialization');
    expect(saved).not.toHaveProperty('categoryKey');
    expect(saved).not.toHaveProperty('categoryVersionId');
    expect(harness.persistAutomaticSharedMaterialRevision).toHaveBeenCalledWith(expect.objectContaining({
      jobId: harness.job().id,
      expectedListingRowVersion: 2,
      data: expect.objectContaining({ warehouseId: '', currency: 'CNY' })
    }));
    expect(harness.createListing).not.toHaveBeenCalled();
    expect(harness.publishing.dispatchAutomaticJob).not.toHaveBeenCalled();
    expect(harness.storeService.createAutomaticPublicationsFromFrozenPlan).toHaveBeenCalledOnce();
  });

  it('does not carry historical gross weight, price, stock, or preset snapshots into a new shared revision', async () => {
    const capturedAt = '2026-08-01T08:00:00.000Z';
    const existingResolution = {
      source: 'PROCUREMENT' as const,
      effectiveGrossWeightGrams: 720,
      procurementGrossWeightGrams: 720,
      presetGrossWeightGrams: 800,
      procurementVersionId: randomUUID(),
      procurementVersionNo: 5,
      procurementCapturedAt: capturedAt
    };
    const harness = await createAutoGrossWeightHarness({
      procurementGrossWeightGrams: '999',
      existingResolution
    });
    const existingPresetSnapshot = {
      presetId: harness.preset.id,
      presetName: harness.preset.name,
      presetRowVersion: harness.preset.rowVersion,
      capturedAt,
      definition: harness.preset
    };
    harness.setListingInitialization({
      status: 'COMPLETE',
      initializedAt: capturedAt,
      issues: [],
      grossWeightResolution: existingResolution,
      presetSnapshot: existingPresetSnapshot
    });
    harness.titleTranslator.translate.mockRejectedValue(new Error('标题翻译不可用'));

    await (harness.coordinator as any).processJob(harness.job());

    expect(harness.pricing.calculate).not.toHaveBeenCalled();
    expect(harness.purchases.getPurchase).not.toHaveBeenCalled();
    expect(harness.titleTranslator.translate).not.toHaveBeenCalled();
    const saved = harness.updateListing.mock.calls[0]![1] as any;
    expect(saved).not.toHaveProperty('dimensions');
    expect(saved).not.toHaveProperty('initialization');
    expect(saved.offers.find((offer: any) => offer.offerId === `${harness.fixture.sku}-01`)).toMatchObject({
      offerId: `${harness.fixture.sku}-01`,
      price: 1,
      oldPrice: 1,
      minPrice: 0,
      stock: 0,
      descriptionRu: 'Ручное описание варианта'
    });
    expect(saved.offers.find((offer: any) => offer.offerId === `${harness.fixture.sku}-02`)).toMatchObject({
      offerId: `${harness.fixture.sku}-02`,
      price: 1,
      oldPrice: 1,
      minPrice: 0,
      stock: 0
    });
    expect(harness.descriptions.resolveVariants).toHaveBeenCalledOnce();
    expect(harness.createListing).not.toHaveBeenCalled();
    expect(harness.storeService.createAutomaticPublicationsFromFrozenPlan).toHaveBeenCalledOnce();
  });
});

describe('OZON automatic preparation manual-success reconciliation', () => {
  it('builds a stable plan and reconciles only after exact current-store manual success evidence', async () => {
    const harness = createManualSuccessReconcileHarness();

    const detail = await harness.coordinator.preparationTaskDetail(harness.autoJob.id);
    expect(detail).toMatchObject({
      recovery: {
        canRecheck: false,
        canManualTakeover: false,
        canReconcileManualSuccess: true,
        recoveryMode: 'MANUAL_SUCCESS_RECONCILE'
      },
      manualSuccessReconcilePlan: {
        canReconcileManualSuccess: true,
        blockers: [],
        targetStores: [expect.objectContaining({
          storeId: harness.store.id,
          publicationId: harness.publication.id,
          manualJobId: harness.manualJob.id
        })]
      }
    });

    const dryRun = await harness.coordinator.preparationManualSuccessReconcilePlan(harness.autoJob.id, {
      rowVersion: harness.autoJob.rowVersion
    });
    const applied = await harness.coordinator.reconcilePreparationToManualSuccess(harness.autoJob.id, {
      rowVersion: harness.autoJob.rowVersion,
      planHash: dryRun.plan.planHash,
      requestId: dryRun.plan.requestId
    });

    expect(harness.reconcileAutomaticPreparationToManualSuccess).toHaveBeenCalledOnce();
    expect(harness.reconcileAutomaticPreparationToManualSuccess).toHaveBeenCalledWith(expect.objectContaining({
      jobId: harness.autoJob.id,
      expectedJobRowVersion: harness.autoJob.rowVersion,
      expectedListingRowVersion: harness.listing.rowVersion,
      expectedListingRevision: harness.listing.revision,
      planHash: dryRun.plan.planHash,
      requestId: dryRun.plan.requestId,
      targetStores: [expect.objectContaining({
        storeId: harness.store.id,
        publicationRowVersion: harness.publication.rowVersion,
        manualJobRowVersion: harness.manualJob.rowVersion
      })]
    }));
    expect(applied).toEqual(harness.reconcileResult);
  });

  it('fails closed when any currently eligible store lacks exact manual success evidence', async () => {
    const harness = createManualSuccessReconcileHarness({ missingPublication: true });

    const dryRun = await harness.coordinator.preparationManualSuccessReconcilePlan(harness.autoJob.id, {
      rowVersion: harness.autoJob.rowVersion
    });

    expect(dryRun.plan).toMatchObject({
      canReconcileManualSuccess: false,
      recoveryMode: 'READBACK_REQUIRED'
    });
    expect(dryRun.plan.blockers).toEqual(expect.arrayContaining([
      `MANUAL_SUCCESS_PUBLICATION_MISSING:${harness.store.id}`,
      'MANUAL_SUCCESS_STORE_SET_INCOMPLETE'
    ]));
    await expect(harness.coordinator.reconcilePreparationToManualSuccess(harness.autoJob.id, {
      rowVersion: harness.autoJob.rowVersion,
      planHash: dryRun.plan.planHash,
      requestId: dryRun.plan.requestId
    })).rejects.toMatchObject({ code: 'OZON_READBACK_REQUIRED' });
    expect(harness.reconcileAutomaticPreparationToManualSuccess).not.toHaveBeenCalled();
  });
});

describe('OZON automatic compatibility and ownership gates', () => {
  it('does not read or migrate a current preset title rule during shared preparation', async () => {
    const harness = await createAutoGrossWeightHarness({ procurementGrossWeightGrams: '650' });
    harness.preset.rowVersion += 1;
    harness.preset.titleTranslation = { ...harness.preset.titleTranslation, maxLength: 200 };

    await (harness.coordinator as any).processJob(harness.job());

    expect(harness.titleTranslator.translate).not.toHaveBeenCalled();
    expect((harness.coordinator.repository as any).getPreset).not.toHaveBeenCalled();
    expect((harness.coordinator.repository as any).getDefaultPreset).not.toHaveBeenCalled();
    expect(harness.publishing.dispatchAutomaticJob).not.toHaveBeenCalled();
    const saved = harness.updateListing.mock.calls.at(-1)?.[1];
    expect(saved).not.toHaveProperty('initialization');
    expect(saved).not.toHaveProperty('titleTranslation');
    expect(JSON.stringify(saved)).not.toContain('maxLength');
    expect(harness.storeService.createAutomaticPublicationsFromFrozenPlan).toHaveBeenCalledOnce();
  });

  it('preserves stable offer identities and prepares missing variants with independent E003 descriptions', async () => {
    const harness = await createAutoGrossWeightHarness({ procurementGrossWeightGrams: '650' });
    const blackId = randomUUID();
    const wineId = randomUUID();
    const placeholderId = randomUUID();
    harness.setIdentityVariants([
      { variantId: placeholderId, name: '默认变体' },
      { variantId: blackId, name: '黑色' },
      { variantId: wineId, name: '深酒红色' },
      { variantId: harness.retainedVariantId, name: '卡其色' }
    ]);
    const blackImage = {
      ...await harness.fixture.asset('E005', 'image', 'black-images', 'variants/黑色/images/01.png', Buffer.from('black-image'), '2026-08-08T07:48:40.930Z'),
      variantId: blackId,
      variantName: '黑色'
    };
    const blackVideo = {
      ...await harness.fixture.asset('E004', 'video', 'black-video', 'variants/黑色/videos/01.mp4', testMp4(12), '2026-08-08T07:48:32.315Z'),
      variantId: blackId,
      variantName: '黑色'
    };
    const wineImage = {
      ...await harness.fixture.asset('E005', 'image', 'wine-images', 'variants/深酒红色/images/01.png', Buffer.from('wine-image'), '2026-08-08T06:58:38.650Z'),
      variantId: wineId,
      variantName: '深酒红色'
    };
    const wineVideo = {
      ...await harness.fixture.asset('E004', 'video', 'wine-video', 'variants/深酒红色/videos/01.mp4', testMp4(12), '2026-08-08T06:58:31.543Z'),
      variantId: wineId,
      variantName: '深酒红色'
    };
    await harness.fixture.manifest([blackImage, blackVideo, wineImage, wineVideo]);
    harness.setProductLinks([{
      offerId: `${harness.fixture.sku}-01`,
      ozonProductId: '5874416999',
      ozonSku: '5395936600',
      url: 'https://www.ozon.ru/product/5395936600/'
    }]);

    await (harness.coordinator as any).processJob(harness.job());

    const saved = harness.updateListing.mock.calls.at(-1)?.[1];
    expect(new Set(saved.offers.map((offer: any) => offer.offerId))).toEqual(new Set([
      `${harness.fixture.sku}-01`,
      `${harness.fixture.sku}-02`,
      `${harness.fixture.sku}-03`
    ]));
    expect(saved.offers.find((offer: any) => offer.offerId === `${harness.fixture.sku}-01`)).toMatchObject({
      offerId: `${harness.fixture.sku}-01`,
      descriptionRu: 'Ручное описание варианта'
    });
    expect(saved.offers.find((offer: any) => offer.productVariantId === blackId)?.descriptionSource)
      .toMatchObject({ type: 'E003', productVariantId: blackId });
    expect(saved.offers.find((offer: any) => offer.productVariantId === wineId)?.descriptionSource)
      .toMatchObject({ type: 'E003', productVariantId: wineId });
    expect(harness.publishing.dispatchAutomaticJob).not.toHaveBeenCalled();
    expect(harness.storeService.automaticPublicationPlan).toHaveBeenCalledOnce();
    expect(harness.storeService.createAutomaticPublicationsFromFrozenPlan).toHaveBeenCalledOnce();
  });

  it('creates a new stable shared-material revision without applying any store preset', async () => {
    const harness = await createAutoGrossWeightHarness({ procurementGrossWeightGrams: '650' });
    harness.setListingAbsent();

    await (harness.coordinator as any).processJob(harness.job());

    expect(harness.createListing).toHaveBeenCalledOnce();
    expect(harness.updateListing).not.toHaveBeenCalled();
    expect(harness.titleTranslator.translate).not.toHaveBeenCalled();
    expect(harness.pricing.calculate).not.toHaveBeenCalled();
    expect(harness.publishing.dispatchAutomaticJob).not.toHaveBeenCalled();
    expect(harness.transitionJob).toHaveBeenCalledWith(
      harness.job().id,
      expect.objectContaining({
        eventType: 'AUTO_SHARED_MATERIAL_PREPARED',
        jobPayload: expect.objectContaining({
          generatedVersionId: expect.any(String),
          materialHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          materialHashVersion: 'ozon-shared-material-v1',
          contentPolicyVersion: 'merchroute-ozon-content-v3',
          sharedMaterialPreparation: expect.objectContaining({
            preparedByJobId: harness.job().id,
            dataSignature: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
          })
        })
      })
    );
    expect(harness.storeService.createAutomaticPublicationsFromFrozenPlan).toHaveBeenCalledOnce();
  });

  it('keeps shared automatic preparation store-neutral before two-store fan-out', async () => {
    const harness = await createAutoGrossWeightHarness({ procurementGrossWeightGrams: '650' });
    const tekStoreId = '00000000-0000-4000-8000-000000000002';
    const glaukeStoreId = '7d15ba0c-9270-4dd8-bf43-55457670f290';
    const storeIds = [tekStoreId, glaukeStoreId];
    const publicationIds = [randomUUID(), randomUUID()];
    const planHash = `sha256:${'4'.repeat(64)}`;
    const createAutomaticPublicationsFromFrozenPlan = vi.fn(async () => ({
      publications: publicationIds.map((id, index) => ({ id, storeId: storeIds[index] })),
      failures: [],
      accepted: 2,
      failed: 0
    }));
    const automaticPublicationPlan = vi.fn(async () => ({
      planHash,
      generatedVersionId: randomUUID(),
      revision: 1,
      contentPolicyVersion: 'merchroute-ozon-content-v3',
      materialHash: `sha256:${'3'.repeat(64)}`,
      materialHashVersion: 'ozon-shared-material-v1',
      items: storeIds.map((storeId, index) => ({
        storeId,
        publicationId: publicationIds[index],
        plannedJobId: randomUUID(),
        taskId: `store-${index + 1}__${harness.fixture.sku}__r1`
      }))
    }));
    const completeFanoutPreparation = vi.fn(async () => undefined);
    const finalizeMediaFanoutBatch = vi.fn(async () => true);
    (harness.coordinator as any).multistore = {
      storeRepository: {
        listEligibleAutoStores: vi.fn(async () => storeIds.map((id) => ({ id }))),
        freezePreparationFanoutPlan: vi.fn(async (_jobId: string, _rowVersion: number, plan: any) => {
          harness.job().payload.fanoutPlan = structuredClone(plan);
          return structuredClone(plan);
        }),
        completeFanoutPreparation,
        finalizeMediaFanoutBatch
      },
      storeService: { automaticPublicationPlan, createAutomaticPublicationsFromFrozenPlan }
    };
    harness.preset.warehouseId = 'W03 CEL标准-123深圳润百国际仓（库存仓）';
    harness.setListingAbsent();
    const firstVideo = await harness.fixture.asset(
      'E004', 'video', 'first-video', 'variants/咖啡色/videos/01.mp4',
      testMp4(12), '2026-08-11T07:25:45.012Z'
    );
    const lateImages = await harness.fixture.asset(
      'E005', 'image', 'late-images', 'variants/咖啡色/images/01.png',
      Buffer.from('late-images'), '2026-08-11T07:26:00.004Z'
    );
    await harness.fixture.manifest([firstVideo, lateImages]);
    harness.job().payload = {
      ...harness.job().payload,
      multistorePreparation: true,
      mediaDeliveries: [
        {
          sourceStageId: 'E004',
          submissionId: 'first-video',
          variantId: harness.fixture.variantId,
          deliveredAt: '2026-08-11T07:25:45.012Z'
        }
      ]
    };

    await (harness.coordinator as any).processJob(harness.job());

    expect(harness.publishing.resolveStoreContext).not.toHaveBeenCalled();
    const persistedInput = harness.persistAutomaticSharedMaterialRevision.mock.calls.at(-1)?.[0];
    expect(persistedInput.data).toMatchObject({
      warehouseId: '',
      fulfillmentMode: 'FBS',
      currency: 'CNY'
    });
    const shared = persistedInput.data;
    expect(shared).not.toHaveProperty('categoryKey');
    expect(shared).not.toHaveProperty('dimensions');
    expect(JSON.stringify(shared)).not.toContain('W03 CEL标准');
    expect(automaticPublicationPlan).toHaveBeenCalledOnce();
    expect(createAutomaticPublicationsFromFrozenPlan).toHaveBeenCalledOnce();
    expect(createAutomaticPublicationsFromFrozenPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planHash }),
      expect.objectContaining({ sourceStageId: 'E005', submissionId: 'late-images' }),
      harness.job().id
    );
    expect(finalizeMediaFanoutBatch).toHaveBeenCalledOnce();
    expect(finalizeMediaFanoutBatch).toHaveBeenCalledWith(expect.objectContaining({
      jobId: harness.job().id,
      sku: harness.fixture.sku,
      deliveries: expect.arrayContaining([
        expect.objectContaining({ sourceStageId: 'E004', submissionId: 'first-video', variantId: harness.fixture.variantId }),
        expect.objectContaining({ sourceStageId: 'E005', submissionId: 'late-images', variantId: harness.fixture.variantId })
      ]),
      publicationIds,
      storeIds
    }));
    expect(completeFanoutPreparation).toHaveBeenCalledWith(
      harness.job().id,
      expect.objectContaining({ publicationIds, storeIds })
    );
  });

  it('waits before freezing shared material when a complete manifest delivery is not owned by the preparation job', async () => {
    const harness = await createAutoGrossWeightHarness({ procurementGrossWeightGrams: '650' });
    harness.setListingAbsent();
    const video = await harness.fixture.asset(
      'E004', 'video', 'owned-video', 'variants/coffee/videos/01.mp4', testMp4(12), '2026-08-11T07:25:45.012Z'
    );
    const image = await harness.fixture.asset(
      'E005', 'image', 'racing-images', 'variants/coffee/images/01.png', Buffer.from('image'), '2026-08-11T07:26:00.004Z'
    );
    await harness.fixture.manifest([video, image]);
    harness.job().payload = {
      ...harness.job().payload,
      multistorePreparation: true,
      mediaDeliveries: [{
        sourceStageId: 'E004', submissionId: video.submissionId,
        variantId: harness.fixture.variantId, deliveredAt: video.deliveredAt
      }]
    };
    harness.repository.resolveAutomaticMediaDeliveryEvidence.mockImplementation(async ({ identities }: any) => (
      identities.map((identity: any) => ({
        ...identity,
        decision: identity.sourceStageId === 'E004' ? 'ACCEPTED' : 'DEFERRED',
        ...(identity.sourceStageId === 'E004' ? { jobId: harness.job().id } : {})
      }))
    ));

    await (harness.coordinator as any).processJob(harness.job());

    expect(harness.persistAutomaticSharedMaterialRevision).not.toHaveBeenCalled();
    expect(harness.storeService.automaticPublicationPlan).not.toHaveBeenCalled();
    expect(harness.transitionJob).toHaveBeenLastCalledWith(
      harness.job().id,
      expect.objectContaining({
        state: 'WAITING_MEDIA',
        eventType: 'MEDIA_INCOMPLETE',
        message: '公共媒体投递账本正在收口，等待同一准备任务重新绑定后继续'
      })
    );
  });

  it('does not finalize shared media when every store fails before an attempt is persisted', async () => {
    const harness = await createAutoGrossWeightHarness({ procurementGrossWeightGrams: '650' });
    const storeIds = [
      '00000000-0000-4000-8000-000000000002',
      '7d15ba0c-9270-4dd8-bf43-55457670f290'
    ];
    const completeFanoutPreparation = vi.fn(async () => undefined);
    const finalizeMediaFanoutBatch = vi.fn(async () => true);
    (harness.coordinator as any).multistore = {
      storeRepository: {
        listEligibleAutoStores: vi.fn(async () => storeIds.map((id) => ({ id }))),
        freezePreparationFanoutPlan: vi.fn(async (_jobId: string, _rowVersion: number, plan: any) => {
          harness.job().payload.fanoutPlan = structuredClone(plan);
          return structuredClone(plan);
        }),
        completeFanoutPreparation,
        finalizeMediaFanoutBatch
      },
      storeService: {
        automaticPublicationPlan: vi.fn(async () => ({
          planHash: `sha256:${'4'.repeat(64)}`,
          items: storeIds.map((storeId, index) => ({
            storeId,
            publicationId: `${index + 1}0000000-0000-4000-8000-000000000001`,
            plannedJobId: `${index + 3}0000000-0000-4000-8000-000000000001`,
            taskId: `store-${index + 1}__${harness.fixture.sku}__r1`
          }))
        })),
        createAutomaticPublicationsFromFrozenPlan: vi.fn(async () => ({
          publications: [],
          failures: storeIds.map((storeId) => ({
            storeId,
            storeAlias: storeId,
            code: 'OZON_PUBLICATION_CREATE_FAILED',
            message: 'INSERT has more expressions than target columns'
          })),
          accepted: 0,
          // The historical bug reported zero here because no attempt row existed yet.
          failed: 0
        }))
      }
    };
    harness.setListingAbsent();
    const video = await harness.fixture.asset(
      'E004', 'video', 'first-video', 'variants/coffee/videos/01.mp4', testMp4(12), '2026-08-11T07:25:45.012Z'
    );
    const image = await harness.fixture.asset(
      'E005', 'image', 'late-images', 'variants/coffee/images/01.png', Buffer.from('image'), '2026-08-11T07:26:00.004Z'
    );
    await harness.fixture.manifest([video, image]);
    harness.job().payload = {
      ...harness.job().payload,
      multistorePreparation: true,
      mediaDeliveries: [{
        sourceStageId: 'E004',
        submissionId: 'first-video',
        variantId: harness.fixture.variantId,
        deliveredAt: '2026-08-11T07:25:45.012Z'
      }]
    };

    await (harness.coordinator as any).processJob(harness.job());

    expect(finalizeMediaFanoutBatch).not.toHaveBeenCalled();
    expect(completeFanoutPreparation).toHaveBeenCalledWith(harness.job().id, expect.objectContaining({
      publicationIds: [],
      failures: expect.arrayContaining([expect.objectContaining({ code: 'OZON_PUBLICATION_CREATE_FAILED' })])
    }));
  });

  it('initializes a new OZON offer with E003 image order, primary image, and trailing video', async () => {
    const harness = await createAutoGrossWeightHarness({ procurementGrossWeightGrams: '650' });
    harness.setListingAbsent();
    const image07 = {
      ...await harness.fixture.asset('E005', 'image', 'ordered-images', 'variants/咖啡色/images/07.png', Buffer.from('image-07'), '2026-08-10T02:00:00.000Z'),
      sortOrder: 0
    };
    const image01 = {
      ...await harness.fixture.asset('E005', 'image', 'ordered-images', 'variants/咖啡色/images/01.png', Buffer.from('image-01'), '2026-08-10T02:00:00.000Z'),
      sortOrder: 1
    };
    const image04 = {
      ...await harness.fixture.asset('E005', 'image', 'ordered-images', 'variants/咖啡色/images/04.png', Buffer.from('image-04'), '2026-08-10T02:00:00.000Z'),
      sortOrder: 2
    };
    const video = await harness.fixture.asset(
      'E004',
      'video',
      'ordered-video',
      'variants/咖啡色/videos/01.mp4',
      testMp4(12),
      '2026-08-10T02:01:00.000Z'
    );
    await harness.fixture.manifest([image01, image04, image07, video]);

    await (harness.coordinator as any).processJob(harness.job());

    const saved = harness.createListing.mock.calls[0]![2] as any;
    expect(saved.offers[0].media).toEqual([
      expect.objectContaining({ relativePath: image07.relativePath, kind: 'image', sortOrder: 0, isPrimary: true }),
      expect.objectContaining({ relativePath: image01.relativePath, kind: 'image', sortOrder: 1, isPrimary: false }),
      expect.objectContaining({ relativePath: image04.relativePath, kind: 'image', sortOrder: 2, isPrimary: false }),
      expect.objectContaining({ relativePath: video.relativePath, kind: 'video', sortOrder: 3, isPrimary: false })
    ]);
  });

  it('reuses the atomically created stable shared revision without a second create or update', async () => {
    const harness = await createAutoGrossWeightHarness({ procurementGrossWeightGrams: '650' });
    harness.setListingAbsent();
    await (harness.coordinator as any).processJob(harness.job());

    await (harness.coordinator as any).processJob(harness.job());

    expect(harness.createListing).toHaveBeenCalledOnce();
    expect(harness.updateListing).not.toHaveBeenCalled();
    expect(harness.descriptions.resolveVariants).toHaveBeenCalledOnce();
    expect(harness.storeService.automaticPublicationPlan).toHaveBeenCalledOnce();
    expect(harness.storeService.createAutomaticPublicationsFromFrozenPlan).toHaveBeenCalledTimes(2);
    expect(harness.publishing.dispatchAutomaticJob).not.toHaveBeenCalled();
  });

  it('records the repository-normalized data signature before dispatch', async () => {
    const harness = await createAutoGrossWeightHarness({ procurementGrossWeightGrams: '650' });
    harness.setListingAbsent();
    harness.setNormalizeAfterUpdate();

    await (harness.coordinator as any).processJob(harness.job());

    expect(harness.transitionJob.mock.calls.find((call) => call[1].eventType === 'AUTO_SHARED_MATERIAL_PREPARED')?.[1])
      .toMatchObject({
        jobPayload: {
          generatedVersionId: expect.any(String),
          materialHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          materialHashVersion: 'ozon-shared-material-v1',
          contentPolicyVersion: 'merchroute-ozon-content-v3',
          sharedMaterialPreparation: {
            dataSignature: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
          }
        }
      });
    expect(harness.publishing.dispatchAutomaticJob).not.toHaveBeenCalled();
    expect(harness.storeService.createAutomaticPublicationsFromFrozenPlan).toHaveBeenCalledOnce();
  });

  it('does not overwrite a MANUAL-owned shared draft', async () => {
    const harness = await createAutoGrossWeightHarness({ procurementGrossWeightGrams: '650' });
    harness.setListingStatus('DRAFT');
    harness.setListingManagementSource('MANUAL');

    await expect((harness.coordinator as any).processJob(harness.job()))
      .rejects.toMatchObject({ code: 'OZON_MANUAL_DRAFT_PRESENT' });
    expect(harness.updateListing).not.toHaveBeenCalled();
  });

  it('uses the manual-draft gate when an active MANUAL job exists', async () => {
    const harness = await createAutoGrossWeightHarness({ procurementGrossWeightGrams: '650' });
    harness.setActiveManualJobCount(1);

    await expect((harness.coordinator as any).processJob(harness.job()))
      .rejects.toMatchObject({ code: 'OZON_MANUAL_DRAFT_PRESENT' });
    expect(harness.updateListing).not.toHaveBeenCalled();
  });

  it('retries the same prepared READY shared revision without rebuilding, repricing, or re-freezing its plan', async () => {
    const harness = await createAutoGrossWeightHarness({ procurementGrossWeightGrams: '650' });
    await (harness.coordinator as any).processJob(harness.job());

    await (harness.coordinator as any).processJob(harness.job());

    expect(harness.updateListing).toHaveBeenCalledOnce();
    expect(harness.descriptions.resolveVariants).toHaveBeenCalledOnce();
    expect(harness.pricing.calculate).not.toHaveBeenCalled();
    expect(harness.titleTranslator.translate).not.toHaveBeenCalled();
    expect(harness.storeService.automaticPublicationPlan).toHaveBeenCalledOnce();
    expect(harness.storeRepository.freezePreparationFanoutPlan).toHaveBeenCalledOnce();
    expect(harness.storeService.createAutomaticPublicationsFromFrozenPlan).toHaveBeenCalledTimes(2);
    expect(harness.publishing.dispatchAutomaticJob).not.toHaveBeenCalled();
  });

  it('lets the newer worker keep ownership when a duplicate worker loses the job rowVersion race', async () => {
    const harness = await createAutoGrossWeightHarness({ procurementGrossWeightGrams: '650' });
    const transitionsBefore = harness.transitionJob.mock.calls.length;

    await (harness.coordinator as any).handleJobError(
      harness.job().id,
      new AppError('TASK_LOCKED', 'OZON 上品任务状态已变化，请刷新后重试', { id: harness.job().id }, 409)
    );

    expect(harness.transitionJob).toHaveBeenCalledTimes(transitionsBefore);
  });

  it('keeps the original automatic job recoverable when its network dependency is interrupted', async () => {
    const harness = await createAutoGrossWeightHarness({ procurementGrossWeightGrams: '650' });
    const error = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });

    await (harness.coordinator as any).handleJobError(harness.job().id, error);

    const transition = harness.transitionJob.mock.calls.at(-1)?.[1];
    expect(transition).toMatchObject({
      state: 'READY',
      eventType: 'NETWORK_RETRY_SCHEDULED',
      errorCode: 'ECONNRESET',
      incrementRetry: true,
      networkRecovery: {
        status: 'WAITING_NETWORK',
        resumeState: 'READY',
        deliveryState: 'UNKNOWN',
        attempt: 1
      }
    });
    expect(Date.parse(transition.nextAttemptAt) - Date.parse(transition.networkRecovery.lastFailureAt)).toBe(30_000);
  });

  it('leaves PUBLISHED-offer mapping checks to each frozen store publication plan', async () => {
    const harness = await createAutoGrossWeightHarness({ procurementGrossWeightGrams: '650' });
    harness.setProductLinks([]);

    await expect((harness.coordinator as any).processJob(harness.job())).resolves.toBeUndefined();
    expect((harness.coordinator.repository as any).hasProductMappingForSku).not.toHaveBeenCalled();
    expect(harness.updateListing).toHaveBeenCalledOnce();
    expect(harness.storeService.automaticPublicationPlan).toHaveBeenCalledOnce();
    expect(harness.storeService.createAutomaticPublicationsFromFrozenPlan).toHaveBeenCalledOnce();
  });

  it('moves a concurrent insert-only creation conflict directly to NEEDS_ATTENTION', async () => {
    const harness = await createAutoGrossWeightHarness({ procurementGrossWeightGrams: '650' });
    harness.setListingAbsent();
    harness.setCreateConflict();
    let failure: unknown;
    try {
      await (harness.coordinator as any).processJob(harness.job());
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'TASK_LOCKED' });

    await (harness.coordinator as any).handleJobError(harness.job().id, failure);

    expect(harness.transitionJob.mock.calls.at(-1)?.[1]).toMatchObject({
      state: 'NEEDS_ATTENTION',
      eventType: 'AUTOMATION_STOPPED',
      errorCode: 'TASK_LOCKED',
      jobPayload: expect.objectContaining({
        autoPreparedOwnershipInvalidatedAt: expect.any(String),
        autoPreparedOwnershipInvalidatedReason: 'OZON_LISTING_CREATED_CONCURRENTLY'
      })
    });
    harness.setJobState('READY');
    await expect((harness.coordinator as any).processJob(harness.job()))
      .rejects.toMatchObject({ code: 'OZON_MANUAL_DRAFT_PRESENT' });
    expect(harness.updateListing).not.toHaveBeenCalled();
    expect(harness.publishing.dispatchAutomaticJob).not.toHaveBeenCalled();
  });

  it('does not trust a pending marker after a hard crash when a human draft appeared before restart', async () => {
    const harness = await createAutoGrossWeightHarness({ procurementGrossWeightGrams: '650' });
    harness.setListingAbsent();
    harness.setCreateConflict();
    await expect((harness.coordinator as any).processJob(harness.job()))
      .rejects.toMatchObject({ code: 'TASK_LOCKED' });
    harness.setCreateConflict(false);

    await expect((harness.coordinator as any).processJob(harness.job()))
      .rejects.toMatchObject({ code: 'OZON_MANUAL_DRAFT_PRESENT' });
    expect(harness.updateListing).not.toHaveBeenCalled();
    expect(harness.publishing.dispatchAutomaticJob).not.toHaveBeenCalled();
  });

  it('creates one new stable shared revision after a clean CAS recheck without reusing the failed insert', async () => {
    const harness = await createAutoGrossWeightHarness({ procurementGrossWeightGrams: '650' });
    harness.setListingAbsent();
    harness.setCreateConflict();
    let conflict: unknown;
    try {
      await (harness.coordinator as any).processJob(harness.job());
    } catch (error) {
      conflict = error;
    }
    await (harness.coordinator as any).handleJobError(harness.job().id, conflict);

    harness.setListingAbsent();
    harness.setCreateConflict(false);
    harness.setJobState('READY');
    await expect((harness.coordinator as any).processJob(harness.job())).resolves.toBeUndefined();

    expect(harness.createListing).toHaveBeenCalledOnce();
    expect(harness.persistAutomaticSharedMaterialRevision).toHaveBeenCalledTimes(2);
    expect(harness.updateListing).not.toHaveBeenCalled();
    expect(harness.storeService.createAutomaticPublicationsFromFrozenPlan).toHaveBeenCalledOnce();
    expect(harness.publishing.dispatchAutomaticJob).not.toHaveBeenCalled();
  });

  it('does not enforce a carrier preset CREATE_ONLY mode in the store-neutral coordinator', async () => {
    const harness = await createAutoGrossWeightHarness({ procurementGrossWeightGrams: '650' });
    harness.preset.autoPublishMode = 'CREATE_ONLY';
    harness.setListingAbsent();
    harness.setMappingAppearsAfterUpdate();

    await expect((harness.coordinator as any).processJob(harness.job())).resolves.toBeUndefined();
    expect((harness.coordinator.repository as any).getPreset).not.toHaveBeenCalled();
    expect((harness.coordinator.repository as any).hasProductMappingForSku).not.toHaveBeenCalled();
    expect(harness.createListing).toHaveBeenCalledOnce();
    expect(harness.updateListing).not.toHaveBeenCalled();
    expect(harness.storeService.createAutomaticPublicationsFromFrozenPlan).toHaveBeenCalledOnce();
    expect(harness.publishing.dispatchAutomaticJob).not.toHaveBeenCalled();
  });

  it('delegates a late COMPATIBLE mapping check to the frozen per-store materialization', async () => {
    const harness = await createAutoGrossWeightHarness({ procurementGrossWeightGrams: '650' });
    harness.setListingAbsent();
    harness.setMappingAppearsAfterUpdate();

    await expect((harness.coordinator as any).processJob(harness.job())).resolves.toBeUndefined();
    expect((harness.coordinator.repository as any).hasProductMappingForSku).not.toHaveBeenCalled();
    expect(harness.createListing).toHaveBeenCalledOnce();
    expect(harness.updateListing).not.toHaveBeenCalled();
    expect(harness.storeService.automaticPublicationPlan).toHaveBeenCalledOnce();
    expect(harness.storeService.createAutomaticPublicationsFromFrozenPlan).toHaveBeenCalledOnce();
    expect(harness.publishing.dispatchAutomaticJob).not.toHaveBeenCalled();
  });

  it('classifies VERSION_CONFLICT as an immediate non-retryable stop', async () => {
    const harness = await createAutoGrossWeightHarness({ procurementGrossWeightGrams: '650' });
    await (harness.coordinator as any).handleJobError(
      harness.job().id,
      new AppError('VERSION_CONFLICT', '旧媒体已变化', { assetId: 'old' }, 409)
    );
    expect(harness.transitionJob.mock.calls.at(-1)?.[1]).toMatchObject({
      state: 'NEEDS_ATTENTION',
      eventType: 'AUTOMATION_STOPPED',
      errorCode: 'VERSION_CONFLICT',
      errorMessage: '旧媒体已变化',
      nextAttemptAt: null
    });
  });
});

describe('OZON automatic pricing currency', () => {
  it('uses the preset fixed package and the explicitly selected OZON service', () => {
    const item = buildOzonPricingItem(
      { dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 800, weightUnit: 'g' } },
      '0000051', '复古斜挎包', { purchasePrice: '31.0000', courierFee: '0.0000' }, 650.5
    );
    expect(item).toMatchObject({ actualWeightGrams: '650.5', lengthCm: '30', widthCm: '20', heightCm: '10' });
    const economy = { shipping: { serviceCode: 'CEL_RFBS_ECONOMY' }, amounts: { listing: {} } };
    const express = { shipping: { serviceCode: 'CEL_RFBS_EXPRESS' }, amounts: { listing: {} } };
    expect(selectOzonPricingOption({ options: [express, economy] }, 'cel_rfbs_economy')).toBe(economy);
    expect(() => selectOzonPricingOption({ options: [express] }, 'CEL_RFBS_ECONOMY')).toThrow('没有符合固定包装参数的上架价');
  });

  it('selects the account contract currency from the pricing currency pair', () => {
    const amount = {
      costCurrency: { currencyCode: 'CNY', value: '443.49', displayValue: '443.49' },
      saleCurrency: { currencyCode: 'RUB', value: '4878.39', displayValue: '4878.4' }
    };
    const result = { options: [{ recommended: true, amounts: { listing: amount, strike: amount, targetSale: amount } }] };

    expect(selectPrices(result, 'CNY')).toEqual({ price: 443.49, oldPrice: 443.49, minPrice: 443.49 });
    expect(selectPrices(result, 'RUB')).toEqual({ price: 4878.4, oldPrice: 4878.4, minPrice: 4878.4 });
  });

  it('maps the OZON minimum price directly from the target sale price', () => {
    const pair = (value: string) => ({ costCurrency: { currencyCode: 'CNY', value, displayValue: value } });
    const result = { options: [{ recommended: true, amounts: { listing: pair('385.33'), strike: pair('770.65'), targetSale: pair('192.66') } }] };

    expect(selectPrices(result, 'CNY')).toEqual({ price: 385.33, oldPrice: 770.65, minPrice: 192.66 });
  });
});

describe('OZON automatic model identity', () => {
  it('materializes the OZON no-brand dictionary value instead of the Chinese source label', () => {
    const attributes = buildSharedAttributes(
      [
        { id: 85, complexId: 0 },
        { id: 8229, complexId: 0 },
        { id: 9048, complexId: 0 }
      ] as any,
      {
        sharedAttributes: [{ attributeId: 85, complexId: 0, values: [{ value: '无品牌' }] }]
      } as any,
      'Тестовый товар',
      'Описание товара',
      '0000119',
      970642857
    );

    expect(attributes.find((attribute) => attribute.attributeId === 85)?.values)
      .toEqual([{ dictionaryValueId: 126745801 }]);
    expect(JSON.stringify(attributes)).not.toContain('无品牌');
  });

  it('uses only the SKU for attribute 9048 even when the preset contains a legacy model name', () => {
    const attributes = buildSharedAttributes(
      [
        { id: 8229, complexId: 0 },
        { id: 9048, complexId: 0 },
        { id: 4180, complexId: 0 },
        { id: 4191, complexId: 0 }
      ] as any,
      {
        sharedAttributes: [
          { attributeId: 9048, complexId: 0, values: [{ value: '旧型号名称' }] },
          { attributeId: 8229, complexId: 0, values: [{ value: '0000051' }] }
        ]
      } as any,
      'Тестовый товар',
      'Описание товара',
      '0000051',
      970642857
    );
    expect(attributes).toEqual(expect.arrayContaining([
      { attributeId: 9048, complexId: 0, values: [{ value: '0000051' }] },
      { attributeId: 8229, complexId: 0, values: [{ dictionaryValueId: 970642857 }] },
      { attributeId: 4180, complexId: 0, values: [{ value: 'Тестовый товар' }] },
      { attributeId: 4191, complexId: 0, values: [{ value: 'Описание товара' }] }
    ]));
    expect(JSON.stringify(attributes)).not.toContain('旧型号名称');
  });
});

describe('OZON stable variant identities', () => {
  it('allocates two-digit codes while preserving existing published identities', () => {
    const legacyVariantId = randomUUID();
    const newVariantId = randomUUID();
    const identities = buildOzonVariantIdentities([legacyVariantId, newVariantId], [{
      variantId: legacyVariantId,
      variantCode: 'v-legacy',
      offerId: '0000052-v-legacy'
    }], '0000052');

    expect(identities.get(legacyVariantId)).toEqual({ variantCode: 'v-legacy', offerId: '0000052-v-legacy' });
    expect(identities.get(newVariantId)).toEqual({ variantCode: '01', offerId: '0000052-01' });
  });

});

describe('OZON automatic package dimensions', () => {
  const fallback = { length: 30, width: 20, height: 10, dimensionUnit: 'cm' as const, weight: 800, weightUnit: 'g' as const };

  it('uses only procurement gross weight while retaining preset length, width and height', () => {
    expect(resolvePublicationDimensions({ grossWeightGrams: '450.000', lengthCm: '30.000', widthCm: '15.000', heightCm: '10.000' }, fallback)).toEqual({
      length: 30,
      width: 20,
      height: 10,
      dimensionUnit: 'cm',
      weight: 450,
      weightUnit: 'g'
    });
  });

  it('ignores incomplete procurement dimensions when its gross weight is valid', () => {
    expect(resolvePublicationDimensions({ grossWeightGrams: '450', lengthCm: '30', widthCm: '', heightCm: '10' }, fallback)).toEqual({
      ...fallback,
      weight: 450,
      weightUnit: 'g'
    });
  });

  it('falls back to a legacy preset weight converted to grams for invalid procurement weight', () => {
    const legacyPreset = { ...fallback, weight: 1.25, weightUnit: 'kg' as const };
    expect(resolvePublicationDimensions({ grossWeightGrams: '0', lengthCm: '99', widthCm: '99', heightCm: '99' }, legacyPreset)).toEqual({
      length: 30,
      width: 20,
      height: 10,
      dimensionUnit: 'cm',
      weight: 1250,
      weightUnit: 'g'
    });
  });
});

describe('OZON PRE_PLAN preparation recovery evidence', () => {
  it('returns a recoverable 0000132-shaped dry-run only after both exact stores prove Offer absence', async () => {
    const harness = await createPrePlanHarness();
    const result = await harness.coordinator.preparationRecheckPlan(harness.job.id, { rowVersion: harness.job.rowVersion });

    expect(result.plan).toMatchObject({
      rowVersion: harness.job.rowVersion,
      canRecheck: true,
      recoveryMode: 'RECHECK',
      frozen: {
        recoveryMode: 'PRE_PLAN',
        checks: {
          noPlatformEvidence: true,
          media: { ownershipValid: true, manifest: { valid: true } },
          contentPolicy: { valid: true },
          stores: { ready: true, count: 2 },
          remoteOfferAbsence: {
            status: 'CONFIRMED_ABSENT',
            requiredPerStore: true,
            evidence: [
              { status: 'CONFIRMED_ABSENT', absent: true },
              { status: 'CONFIRMED_ABSENT', absent: true }
            ]
          }
        }
      }
    });
    expect(result.plan.planHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.plan.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(harness.proveStoreOfferAbsence).toHaveBeenCalledTimes(2);
    expect(harness.proveStoreOfferAbsence.mock.calls.map(([input]: any[]) => input.offerIds)).toEqual([
      [`${harness.fixture.sku}-01`],
      [`${harness.fixture.sku}-01`]
    ]);
    expect(harness.repository.rearmAutomaticPrePlanRecovery).not.toHaveBeenCalled();
  });

  it('proves each store exact Offer set after applying that store preset size expansion', async () => {
    const harness = await createPrePlanHarness({ sizedPresets: true });
    const result = await harness.coordinator.preparationRecheckPlan(harness.job.id, { rowVersion: harness.job.rowVersion });

    expect(result.plan.blockedReason).toBeUndefined();
    expect(result.plan.canRecheck).toBe(true);
    expect(harness.proveStoreOfferAbsence.mock.calls.map(([input]: any[]) => input.offerIds)).toEqual([
      [`${harness.fixture.sku}-01`, `${harness.fixture.sku}-02`],
      [`${harness.fixture.sku}-01`]
    ]);
    expect((result.plan.frozen as any).checks.stores.items.map((store: any) => store.expectedOfferIds)).toEqual([
      [`${harness.fixture.sku}-01`, `${harness.fixture.sku}-02`],
      [`${harness.fixture.sku}-01`]
    ]);
  });

  it.each([
    ['UNKNOWN', 'REMOTE_OFFER_ABSENCE_UNKNOWN'],
    ['PRESENT', 'REMOTE_OFFER_PRESENT']
  ] as const)('fails closed when any store remote proof is %s', async (remoteState, blockedPrefix) => {
    const harness = await createPrePlanHarness({ remoteState });
    const result = await harness.coordinator.preparationRecheckPlan(harness.job.id, { rowVersion: harness.job.rowVersion });

    expect(result.plan.canRecheck).toBe(false);
    expect(result.plan.recoveryMode).toBe('READBACK_REQUIRED');
    expect(result.plan.blockedReason).toContain(blockedPrefix);
    expect((result.plan.frozen as any).checks.remoteOfferAbsence.status).toBe(remoteState);
    expect(harness.repository.rearmAutomaticPrePlanRecovery).not.toHaveBeenCalled();
  });

  it('does not trust a CONFIRMED_ABSENT label when the semantic evidence hash is invalid', async () => {
    const harness = await createPrePlanHarness({ invalidProofHash: true });
    const result = await harness.coordinator.preparationRecheckPlan(harness.job.id, { rowVersion: harness.job.rowVersion });

    expect(result.plan).toMatchObject({ canRecheck: false, recoveryMode: 'READBACK_REQUIRED' });
    expect(result.plan.blockedReason).toContain('REMOTE_OFFER_ABSENCE_UNPROVEN');
    expect((result.plan.frozen as any).checks.remoteOfferAbsence.status).toBe('UNPROVEN');
    expect(harness.repository.rearmAutomaticPrePlanRecovery).not.toHaveBeenCalled();
  });

  it('re-runs every remote proof on apply and rejects semantic evidence drift before CAS', async () => {
    const harness = await createPrePlanHarness({ driftRemoteEvidenceOnApply: true });
    const dryRun = await harness.coordinator.preparationRecheckPlan(harness.job.id, { rowVersion: harness.job.rowVersion });

    await expect(harness.coordinator.recheckPreparation(harness.job.id, {
      rowVersion: dryRun.plan.rowVersion,
      planHash: dryRun.plan.planHash,
      requestId: dryRun.plan.requestId
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(harness.proveStoreOfferAbsence).toHaveBeenCalledTimes(4);
    expect(harness.repository.rearmAutomaticPrePlanRecovery).not.toHaveBeenCalled();
  });

  it('rearms only the original preparation job after a fresh identical apply proof', async () => {
    const harness = await createPrePlanHarness();
    const dryRun = await harness.coordinator.preparationRecheckPlan(harness.job.id, { rowVersion: harness.job.rowVersion });
    const applied = await harness.coordinator.recheckPreparation(harness.job.id, {
      rowVersion: dryRun.plan.rowVersion,
      planHash: dryRun.plan.planHash,
      requestId: dryRun.plan.requestId
    });

    expect(harness.proveStoreOfferAbsence).toHaveBeenCalledTimes(4);
    expect(harness.repository.rearmAutomaticPrePlanRecovery).toHaveBeenCalledTimes(1);
    expect(harness.repository.rearmAutomaticPrePlanRecovery).toHaveBeenCalledWith(expect.objectContaining({
      jobId: harness.job.id,
      expectedJobRowVersion: harness.job.rowVersion,
      planHash: dryRun.plan.planHash,
      requestId: dryRun.plan.requestId,
      expectedEligibilityAt: '2026-08-12T10:01:00.000Z',
      targetStores: expect.arrayContaining([expect.objectContaining({ expectedOfferIds: [`${harness.fixture.sku}-01`] })])
    }));
    expect(applied).toMatchObject({
      requestId: dryRun.plan.requestId,
      job: { id: harness.job.id, state: 'READY', rowVersion: harness.job.rowVersion + 1 }
    });
  });

  it('refreshes only an authentic previously authorized PRE_PLAN after its remote proof expires', async () => {
    const harness = await createPrePlanHarness();
    const firstDryRun = await harness.coordinator.preparationRecheckPlan(harness.job.id, { rowVersion: harness.job.rowVersion });
    const firstApply = await harness.coordinator.recheckPreparation(harness.job.id, {
      rowVersion: firstDryRun.plan.rowVersion,
      planHash: firstDryRun.plan.planHash,
      requestId: firstDryRun.plan.requestId
    });
    Object.assign(harness.job, firstApply.job, {
      state: 'NEEDS_ATTENTION',
      rowVersion: firstApply.job.rowVersion + 2,
      lastErrorCode: 'VERSION_CONFLICT',
      lastErrorMessage: 'OZON PRE_PLAN 冻结恢复证据合同无效或已过期'
    });

    const refreshed = await harness.coordinator.preparationRecheckPlan(harness.job.id, { rowVersion: harness.job.rowVersion });

    expect(refreshed.plan).toMatchObject({
      rowVersion: harness.job.rowVersion,
      canRecheck: true,
      recoveryMode: 'RECHECK',
      frozen: { checks: { job: { authorizedExpiredProofRefresh: true } } }
    });
    expect(refreshed.plan.planHash).not.toBe(firstDryRun.plan.planHash);
    expect(refreshed.plan.requestId).not.toBe(firstDryRun.plan.requestId);
    expect(harness.proveStoreOfferAbsence).toHaveBeenCalledTimes(6);
  });

  it('does not refresh an expired PRE_PLAN marker when its original authorization evidence is forged', async () => {
    const harness = await createPrePlanHarness();
    const firstDryRun = await harness.coordinator.preparationRecheckPlan(harness.job.id, { rowVersion: harness.job.rowVersion });
    const firstApply = await harness.coordinator.recheckPreparation(harness.job.id, {
      rowVersion: firstDryRun.plan.rowVersion,
      planHash: firstDryRun.plan.planHash,
      requestId: firstDryRun.plan.requestId
    });
    const forgedRecovery = structuredClone((firstApply.job as any).payload.prePlanRecovery);
    forgedRecovery.evidence.checks.job.imitationFailureOnly = false;
    Object.assign(harness.job, firstApply.job, {
      state: 'NEEDS_ATTENTION',
      rowVersion: firstApply.job.rowVersion + 2,
      lastErrorCode: 'VERSION_CONFLICT',
      lastErrorMessage: 'OZON PRE_PLAN 冻结恢复证据合同无效或已过期',
      payload: { ...(firstApply.job as any).payload, prePlanRecovery: forgedRecovery }
    });

    const result = await harness.coordinator.preparationRecheckPlan(harness.job.id, { rowVersion: harness.job.rowVersion });

    expect(result.plan.canRecheck).toBe(false);
    expect(result.plan.blockedReason).toContain('PRE_PLAN_GENERIC_RECOVERY_NOT_ALLOWED');
    expect(harness.proveStoreOfferAbsence).toHaveBeenCalledTimes(4);
  });

  it('allows a newly proven refresh after the same authorized PRE_PLAN stops on exact media-ledger drift', async () => {
    const harness = await createPrePlanHarness();
    const firstDryRun = await harness.coordinator.preparationRecheckPlan(harness.job.id, { rowVersion: harness.job.rowVersion });
    const firstApply = await harness.coordinator.recheckPreparation(harness.job.id, {
      rowVersion: firstDryRun.plan.rowVersion,
      planHash: firstDryRun.plan.planHash,
      requestId: firstDryRun.plan.requestId
    });
    Object.assign(harness.job, firstApply.job, {
      state: 'NEEDS_ATTENTION',
      rowVersion: firstApply.job.rowVersion + 2,
      lastErrorCode: 'OZON_MEDIA_DELIVERY_IDENTITY_DRIFT',
      lastErrorMessage: 'OZON PRE_PLAN 媒体账本在生成稳定版本前已变化'
    });

    const refreshed = await harness.coordinator.preparationRecheckPlan(harness.job.id, { rowVersion: harness.job.rowVersion });

    expect(refreshed.plan).toMatchObject({
      canRecheck: true,
      recoveryMode: 'RECHECK',
      frozen: { checks: { job: { authorizedExpiredProofRefresh: true } } }
    });
  });

  it('rejects E003 content drift inside the atomic r2 persistence transaction', async () => {
    const harness = await createPrePlanHarness();
    const dryRun = await harness.coordinator.preparationRecheckPlan(harness.job.id, { rowVersion: harness.job.rowVersion });
    const frozen = dryRun.plan.frozen as any;
    const checks = frozen.checks;
    const recoveryJobRow = {
      id: harness.job.id,
      sku: harness.job.sku,
      source: 'AUTO',
      task_kind: 'SHARED_PREPARATION',
      state: 'READY',
      row_version: harness.job.rowVersion + 1,
      payload: {
        multistorePreparation: true,
        prePlanRecovery: {
          schemaVersion: 1,
          requestId: dryRun.plan.requestId,
          planHash: dryRun.plan.planHash,
          targetStores: checks.stores.items,
          productIdentity: checks.productIdentity,
          manifestSignature: checks.media.manifest.signature,
          evidence: frozen
        }
      }
    };
    const listingRow = {
      sku: harness.listing.sku,
      management_source: 'AUTO',
      row_version: harness.listing.rowVersion,
      revision: harness.listing.revision,
      data: harness.listing.data
    };
    const query = vi.fn(async (sqlInput: unknown) => {
      const sql = String(sqlInput);
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('SELECT * FROM ozon_publish_jobs')) return { rows: [recoveryJobRow] };
      if (sql.includes('SELECT * FROM ozon_listing_drafts')) return { rows: [listingRow] };
      throw new Error(`unexpected PRE_PLAN persistence query: ${sql}`);
    });
    const repository = new OzonRepository('postgres://not-used');
    Object.defineProperty(repository, 'transaction', {
      value: async (operation: (client: unknown) => Promise<unknown>) => operation({ query })
    });

    const changedData = structuredClone(harness.listing.data);
    changedData.descriptionRu = 'Новый текст E003 после dry-run.';
    changedData.offers[0].descriptionRu = 'Новый текст варианта после dry-run.';
    await expect(repository.persistAutomaticSharedMaterialRevision({
      jobId: harness.job.id,
      jobRowVersion: harness.job.rowVersion + 1,
      sku: harness.listing.sku,
      productName: harness.listing.productName,
      expectedListingRowVersion: harness.listing.rowVersion,
      data: changedData,
      mediaSignature: checks.media.manifest.signature,
      offerIds: harness.listing.data.offers.map((offer: any) => offer.offerId)
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE ozon_listing_drafts'))).toBe(false);
  });

  it('reports media ownership drift and rejects stale rowVersion before producing a plan', async () => {
    const harness = await createPrePlanHarness({ mediaOwnerDrift: true });
    const result = await harness.coordinator.preparationRecheckPlan(harness.job.id, { rowVersion: harness.job.rowVersion });
    expect(result.plan).toMatchObject({
      canRecheck: false,
      recoveryMode: 'READBACK_REQUIRED',
      frozen: { checks: { media: { ownershipValid: false } } }
    });
    expect(result.plan.blockedReason).toContain('MEDIA_LEDGER_OWNERSHIP_DRIFT');
    await expect(harness.coordinator.preparationRecheckPlan(harness.job.id, {
      rowVersion: harness.job.rowVersion + 1
    })).rejects.toMatchObject({ code: 'TASK_LOCKED' });
  });
});

describe('OZON frozen fan-out current-preset replan recovery', () => {
  it('returns a read-only 33-offer preview and creates one idempotent replacement request', async () => {
    const harness = createFrozenReplanHarness();
    const dryRun = await harness.coordinator.preparationRecheckPlan(harness.job.id, {
      rowVersion: harness.job.rowVersion
    });

    expect(dryRun.plan).toMatchObject({
      canRecheck: true,
      recoveryMode: 'REPLAN_WITH_CURRENT_PRESET',
      frozen: {
        preview: {
          storeCount: 1,
          offerCount: 33,
          requiredAttributeCoverage: [{
            storeId: harness.storeIds[0],
            categoryKey: 'ozon_shoes',
            complete: true
          }]
        }
      }
    });
    const preview = (dryRun.plan.frozen as any).preview;
    expect(preview.offers).toHaveLength(33);
    expect(preview.offers.every((offer: any) => offer.stock === 1)).toBe(true);
    expect(preview.requiredAttributeCoverage[0].attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ attributeId: 31, source: 'SYSTEM', covered: true, materialized: true }),
      expect.objectContaining({ attributeId: 9163, source: 'PRESET', covered: true, materialized: true }),
      expect.objectContaining({ attributeId: 8292, source: 'SYSTEM', covered: true, materialized: true }),
      expect.objectContaining({ attributeId: 4298, source: 'SIZE', covered: true, materialized: true })
    ]));
    expect(harness.automaticPublicationPlan).toHaveBeenLastCalledWith(
      harness.listing.sku,
      harness.listing.rowVersion,
      harness.storeIds,
      { prepareSharedSource: false, readOnly: true }
    );

    const applied = await harness.coordinator.recheckPreparation(harness.job.id, {
      rowVersion: dryRun.plan.rowVersion,
      planHash: dryRun.plan.planHash,
      requestId: dryRun.plan.requestId
    });
    const automaticPlanCallsAfterApply = harness.automaticPublicationPlan.mock.calls.length;
    const supersededDetail = await harness.coordinator.preparationTaskDetail(harness.job.id);
    const supersededPlan = await harness.coordinator.preparationRecheckPlan(harness.job.id, {
      rowVersion: harness.job.rowVersion
    });
    const replay = await harness.coordinator.recheckPreparation(harness.job.id, {
      rowVersion: dryRun.plan.rowVersion,
      planHash: dryRun.plan.planHash,
      requestId: dryRun.plan.requestId
    });

    expect(harness.replaceAutomaticPreparationWithCurrentPreset).toHaveBeenCalledTimes(1);
    expect(harness.replaceAutomaticPreparationWithCurrentPreset).toHaveBeenCalledWith(expect.objectContaining({
      jobId: harness.job.id,
      expectedJobRowVersion: dryRun.plan.rowVersion,
      planHash: dryRun.plan.planHash,
      requestId: dryRun.plan.requestId,
      expectedFanoutPlanHash: harness.originalFanoutPlanHash,
      expectedListingRowVersion: harness.listing.rowVersion,
      expectedListingRevision: harness.listing.revision,
      expectedGeneratedVersionId: harness.listing.generatedVersionId,
      expectedCurrentPlanHash: `sha256:${'b'.repeat(64)}`,
      expectedPlanContractHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      expectedSettingsRowVersion: 6,
      expectedRootDirectoryHash: `sha256:${'2'.repeat(64)}`,
      expectedVariantColorAuthorityHash: `sha256:${'3'.repeat(64)}`,
      targetStores: [expect.objectContaining({
        expectedOfferIds: expect.arrayContaining(['0000152-01', '0000152-33']),
        expectedProductSnapshotHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        expectedProductContractHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        expectedModeEvidenceHash: `sha256:${'7'.repeat(64)}`,
        expectedPublishedCategoryVersionId: '81000000-0000-4000-8000-000000000008'
      })]
    }));
    expect(applied).toMatchObject({ recoveryMode: 'REPLAN_WITH_CURRENT_PRESET', idempotent: false });
    expect(supersededDetail).toMatchObject({
      recovery: {
        canRecheck: false,
        recoveryMode: 'NONE',
        blockedReason: 'SUPERSEDED_BY_REPLAN_WITH_CURRENT_PRESET'
      },
      supersession: { replacementPreparationJobId: harness.replacementJob.id }
    });
    expect(supersededPlan.plan).toMatchObject({
      canRecheck: false,
      recoveryMode: 'NONE',
      blockedReason: 'SUPERSEDED_BY_REPLAN_WITH_CURRENT_PRESET',
      supersession: { replacementPreparationJobId: harness.replacementJob.id }
    });
    expect(replay).toMatchObject({
      recoveryMode: 'REPLAN_WITH_CURRENT_PRESET',
      idempotent: true,
      job: { id: harness.replacementJob.id }
    });
    expect(harness.automaticPublicationPlan).toHaveBeenCalledTimes(automaticPlanCallsAfterApply);
    expect(harness.repository.recheck).not.toHaveBeenCalled();
  });

  it('uses each store preset current published category for required coverage', async () => {
    const harness = createFrozenReplanHarness({ secondStore: true, secondCategoryMissingRequired: true });
    const dryRun = await harness.coordinator.preparationRecheckPlan(harness.job.id, {
      rowVersion: harness.job.rowVersion
    });

    expect(harness.repository.getCategory).toHaveBeenCalledWith('ozon_shoes');
    expect(harness.repository.getCategory).toHaveBeenCalledWith('ozon_boots');
    expect(harness.repository.getCategory).not.toHaveBeenCalledWith('legacy_listing_category');
    expect(dryRun.plan).toMatchObject({
      canRecheck: false,
      recoveryMode: 'REPLAN_WITH_CURRENT_PRESET',
      frozen: { preview: { storeCount: 2, offerCount: 66 } }
    });
    expect(dryRun.plan.blockedReason).toContain(`REQUIRED_ATTRIBUTE_NOT_MATERIALIZED:${harness.storeIds[1]}:555:0`);
    expect((dryRun.plan.frozen as any).preview.requiredAttributeCoverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ storeId: harness.storeIds[0], categoryKey: 'ozon_shoes', complete: true }),
      expect.objectContaining({ storeId: harness.storeIds[1], categoryKey: 'ozon_boots', complete: false })
    ]));
  });

  it('blocks apply on gateway, lease or remote evidence and never falls through to generic recheck', async () => {
    const harness = createFrozenReplanHarness({ evidenceBlockers: ['GATEWAY_EVIDENCE_PRESENT'] });
    const dryRun = await harness.coordinator.preparationRecheckPlan(harness.job.id, {
      rowVersion: harness.job.rowVersion
    });
    expect(dryRun.plan).toMatchObject({
      canRecheck: false,
      recoveryMode: 'REPLAN_WITH_CURRENT_PRESET'
    });
    expect(dryRun.plan.blockedReason).toContain('GATEWAY_EVIDENCE_PRESENT');

    await expect(harness.coordinator.recheckPreparation(harness.job.id, {
      rowVersion: dryRun.plan.rowVersion,
      planHash: dryRun.plan.planHash,
      requestId: dryRun.plan.requestId
    })).rejects.toMatchObject({ code: 'OZON_READBACK_REQUIRED' });
    expect(harness.replaceAutomaticPreparationWithCurrentPreset).not.toHaveBeenCalled();
    expect(harness.repository.recheck).not.toHaveBeenCalled();
  });

  it('proves the storeId-only no-brand dictionary gate on dry-run and again before replacement', async () => {
    const harness = createFrozenReplanHarness({ noBrandGateFails: true });
    const dryRun = await harness.coordinator.preparationRecheckPlan(harness.job.id, {
      rowVersion: harness.job.rowVersion
    });

    expect(dryRun.plan).toMatchObject({
      canRecheck: false,
      recoveryMode: 'REPLAN_WITH_CURRENT_PRESET'
    });
    expect(dryRun.plan.blockedReason).toContain('CURRENT_PRESET_NO_BRAND_DICTIONARY_UNPROVEN');
    expect(harness.proveExactNoBrandDictionaryValue).toHaveBeenCalledWith(expect.objectContaining({
      storeId: harness.storeIds[0]
    }));
    expect(harness.proveExactNoBrandDictionaryValue.mock.calls[0]?.[0]).not.toHaveProperty('leaseToken');
    expect(harness.automaticPublicationPlan).not.toHaveBeenCalled();

    await expect(harness.coordinator.recheckPreparation(harness.job.id, {
      rowVersion: dryRun.plan.rowVersion,
      planHash: dryRun.plan.planHash,
      requestId: dryRun.plan.requestId
    })).rejects.toMatchObject({ code: 'OZON_READBACK_REQUIRED' });
    expect(harness.proveExactNoBrandDictionaryValue).toHaveBeenCalledTimes(2);
    expect(harness.replaceAutomaticPreparationWithCurrentPreset).not.toHaveBeenCalled();
  });

  it('freezes only the dry-run stores after identity-neutral semantic CAS and blocks every business drift', async () => {
    const targetStoreId = '10000000-0000-4000-8000-000000000001';
    const extraStoreId = '20000000-0000-4000-8000-000000000002';
    const credentialVersionId = '12000000-0000-4000-8000-000000000001';
    const presetId = '13000000-0000-4000-8000-000000000001';
    const categoryVersionId = '14000000-0000-4000-8000-000000000001';
    const presetSnapshot = { categoryKey: 'ozon_shoes', sizes: [{ value: '40', stock: 1 }] };
    const semanticProductSnapshot = {
      titleRu: 'Кроссовки',
      sharedAttributes: [{ attributeId: 9163, values: [{ dictionaryValueId: 22880 }] }],
      offers: [{
        offerId: '0000152-01', stock: 1, price: 1500,
        attributes: [{ attributeId: 4298, revision: 'business-v1', values: [{ value: '40' }] }],
        images: ['variants/brown/images/01.png']
      }]
    };
    const dryRunProductSnapshot = {
      ...structuredClone(semanticProductSnapshot),
      materialHash: `sha256:${'1'.repeat(64)}`,
      generatedVersionId: '15000000-0000-4000-8000-000000000001',
      revision: 4,
      rowVersion: 8
    };
    const replacementProductSnapshot = {
      ...structuredClone(semanticProductSnapshot),
      materialHash: `sha256:${'2'.repeat(64)}`,
      generatedVersionId: '16000000-0000-4000-8000-000000000001',
      revision: 5,
      rowVersion: 9
    };
    const productSnapshotHash = `sha256:${createHash('sha256').update(stableTestJson(dryRunProductSnapshot)).digest('hex')}`;
    const productContractHash = `sha256:${createHash('sha256').update(stableTestJson(semanticProductSnapshot)).digest('hex')}`;
    const replacementProductSnapshotHash = `sha256:${createHash('sha256')
      .update(stableTestJson(replacementProductSnapshot)).digest('hex')}`;
    const modeEvidenceHash = `sha256:${'8'.repeat(64)}`;
    const targetStore = {
      id: targetStoreId,
      storeAlias: 'target',
      rowVersion: 3,
      configVersion: 4,
      defaultPresetId: presetId,
      presetRowVersion: 5,
      presetSnapshot,
      autoPublishMode: 'CREATE_ONLY',
      credential: { activeVersionId: credentialVersionId },
      warehouseId: 'warehouse-1',
      fulfillmentMode: 'FBS',
      accountCurrency: 'RUB'
    };
    const target = {
      id: targetStoreId,
      rowVersion: 3,
      configVersion: 4,
      credentialVersionId,
      presetId,
      presetRowVersion: 5,
      presetDefinitionHash: `sha256:${'f'.repeat(64)}`,
      presetSnapshotHash: `sha256:${createHash('sha256').update(stableTestJson(presetSnapshot)).digest('hex')}`,
      publicationMode: 'CREATE_ONLY',
      warehouseId: 'warehouse-1',
      fulfillmentMode: 'FBS',
      accountCurrency: 'RUB',
      expectedOfferIds: ['0000152-01'],
      categoryKey: 'ozon_shoes',
      expectedPublishedCategoryVersionId: categoryVersionId,
      expectedProductSnapshotHash: productSnapshotHash,
      expectedProductContractHash: productContractHash,
      expectedModeEvidenceHash: modeEvidenceHash
    };
    const deliveredAt = '2026-08-24T01:00:00.000Z';
    const job: any = {
      id: 'b8094cb3-2c9c-411c-af6b-aab99bbff6d1',
      sku: '0000152', taskKind: 'SHARED_PREPARATION', state: 'READY', source: 'AUTO',
      storeAlias: 'default', offerIds: ['0000152-01'], rowVersion: 1, retryCount: 0,
      stageStates: {}, ozonProductLinks: [],
      payload: {
        multistorePreparation: true,
        mediaDeliveries: [{ sourceStageId: 'E005', submissionId: 'images', variantId: 'brown', deliveredAt }],
        replanRecovery: { recoveryMode: 'REPLAN_WITH_CURRENT_PRESET', targetStores: [target] }
      },
      createdAt: deliveredAt, updatedAt: deliveredAt
    };
    const listing: any = {
      sku: job.sku, productName: '运动鞋', status: 'READY', managementSource: 'AUTO',
      rowVersion: 9, revision: 5,
      data: {
        mediaAssets: [{
          assetId: 'asset-1', relativePath: 'variants/brown/images/01.png', kind: 'image',
          sourceStageId: 'E005', sourceSubmissionId: 'images', productVariantId: 'brown', deliveredAt
        }],
        offers: [{ offerId: '0000152-01', media: [{ assetId: 'asset-1' }] }]
      }
    };
    let frozenPlan: any;
    const replacementPlan = {
      schemaVersion: 3,
      planHash: `sha256:${'9'.repeat(64)}`,
      sku: listing.sku,
      contentPolicyVersion: 'merchroute-ozon-content-v3',
      materialHash: `sha256:${'2'.repeat(64)}`,
      materialHashVersion: 'ozon-shared-material-v1',
      sourceMediaIdentityHash: `sha256:${'5'.repeat(64)}`,
      settingsRowVersion: 6,
      rootDirectoryHash: `sha256:${'6'.repeat(64)}`,
      variantColorAuthority: { hash: `sha256:${'7'.repeat(64)}` },
      items: [{
        storeId: targetStoreId,
        ready: true,
        blockers: [],
        storeRowVersion: target.rowVersion,
        storeConfigVersion: target.configVersion,
        credentialVersionId: target.credentialVersionId,
        presetId: target.presetId,
        presetRowVersion: target.presetRowVersion,
        presetDefinitionHash: target.presetDefinitionHash,
        publicationMode: target.publicationMode,
        warehouseId: target.warehouseId,
        fulfillmentMode: target.fulfillmentMode,
        accountCurrency: target.accountCurrency,
        offerIds: target.expectedOfferIds
      }],
      stores: [{
        storeId: targetStoreId,
        productSnapshot: replacementProductSnapshot,
        productSnapshotHash: replacementProductSnapshotHash,
        modeEvidence: { evidenceHash: modeEvidenceHash }
      }]
    };
    const dryRunPlan = {
      ...structuredClone(replacementPlan),
      planHash: `sha256:${'a'.repeat(64)}`,
      materialHash: `sha256:${'1'.repeat(64)}`,
      stores: [{
        storeId: targetStoreId,
        productSnapshot: dryRunProductSnapshot,
        productSnapshotHash,
        modeEvidence: { evidenceHash: modeEvidenceHash }
      }]
    };
    const expectedPlanContract = currentPresetReplanPlanContract(dryRunPlan, [target]);
    expect(dryRunPlan.materialHash).not.toBe(replacementPlan.materialHash);
    expect(dryRunProductSnapshot.generatedVersionId).not.toBe(replacementProductSnapshot.generatedVersionId);
    expect(currentPresetReplanPlanContract(replacementPlan, [target]).hash).toBe(expectedPlanContract.hash);
    Object.assign(job.payload.replanRecovery, {
      expectedCurrentPlanHash: dryRunPlan.planHash,
      expectedPlanContractHash: expectedPlanContract.hash,
      expectedSettingsRowVersion: expectedPlanContract.settingsRowVersion,
      expectedRootDirectoryHash: expectedPlanContract.rootDirectoryHash,
      expectedVariantColorAuthorityHash: expectedPlanContract.variantColorAuthorityHash
    });
    expect(job.payload.replanRecovery.expectedCurrentPlanHash).not.toBe(replacementPlan.planHash);
    let driftPlan: 'TITLE' | 'ATTRIBUTE' | 'STOCK' | 'PRICE' | 'MEDIA' | undefined;
    const automaticPublicationPlan = vi.fn(async (_sku: string, _rowVersion: number, storeIds: string[]) => {
      const result = {
        ...structuredClone(replacementPlan),
        items: replacementPlan.items.filter((item) => storeIds.includes(item.storeId)),
        stores: structuredClone(replacementPlan.stores.filter((entry) => storeIds.includes(entry.storeId)))
      };
      if (driftPlan === 'TITLE') {
        result.stores[0]!.productSnapshot.titleRu = 'Другие кроссовки';
      } else if (driftPlan === 'ATTRIBUTE') {
        // This nested business field deliberately shares the name "revision"
        // with a top-level replacement identity. It must never be normalized away.
        result.stores[0]!.productSnapshot.offers[0]!.attributes[0]!.revision = 'business-v2';
      } else if (driftPlan === 'STOCK') {
        result.stores[0]!.productSnapshot.offers[0]!.stock = 2;
      } else if (driftPlan === 'PRICE') {
        result.stores[0]!.productSnapshot.offers[0]!.price = 1600;
      } else if (driftPlan === 'MEDIA') {
        result.stores[0]!.productSnapshot.offers[0]!.images[0] = 'variants/brown/images/02.png';
      }
      if (driftPlan) {
        result.stores[0]!.productSnapshotHash = `sha256:${createHash('sha256')
          .update(stableTestJson(result.stores[0]!.productSnapshot)).digest('hex')}`;
      }
      return result;
    });
    const freezePreparationFanoutPlan = vi.fn(async (_jobId: string, _rowVersion: number, plan: any) => {
      frozenPlan = structuredClone(plan);
      job.payload = { ...job.payload, fanoutPlan: frozenPlan };
      return frozenPlan;
    });
    const createAutomaticPublicationsFromFrozenPlan = vi.fn(async () => ({
      publications: [{ id: '30000000-0000-4000-8000-000000000003' }],
      failures: [], accepted: 1, failed: 0
    }));
    const storeRepository = {
      listEligibleAutoStores: vi.fn(async () => [targetStore, { ...targetStore, id: extraStoreId, storeAlias: 'extra' }]),
      freezePreparationFanoutPlan,
      finalizeMediaFanoutBatch: vi.fn(async () => true),
      completeFanoutPreparation: vi.fn(async () => undefined)
    };
    const repository = {
      resolveAutomaticMediaDeliveryEvidence: vi.fn(async ({ identities }: any) => identities.map((identity: any) => ({
        ...identity, decision: 'ACCEPTED', jobId: job.id
      }))),
      getCategory: vi.fn(async () => ({ publishedVersion: { id: categoryVersionId } })),
      getJob: vi.fn(async () => job)
    };
    const coordinator = new OzonAutoPublishingCoordinator(
      repository as any,
      { dispatchAutomaticJob: vi.fn() } as any,
      {} as any, {} as any, {} as any, {} as any, {} as any,
      { warn: vi.fn() } as any,
      {},
      {
        storeRepository: storeRepository as any,
        storeService: { automaticPublicationPlan, createAutomaticPublicationsFromFrozenPlan } as any
      }
    );

    for (const drift of ['TITLE', 'ATTRIBUTE', 'STOCK', 'PRICE', 'MEDIA'] as const) {
      driftPlan = drift;
      await expect((coordinator as any).dispatchPreparedListing(job, listing, {}, { enabled: true }))
        .rejects.toMatchObject({ code: 'OZON_CURRENT_PRESET_PLAN_DRIFT' });
    }
    expect(freezePreparationFanoutPlan).not.toHaveBeenCalled();
    driftPlan = undefined;

    await (coordinator as any).dispatchPreparedListing(job, listing, {}, { enabled: true });

    expect(automaticPublicationPlan).toHaveBeenCalledWith(listing.sku, listing.rowVersion, [targetStoreId]);
    expect(frozenPlan.items.map((item: any) => item.storeId)).toEqual([targetStoreId]);
    expect(createAutomaticPublicationsFromFrozenPlan).toHaveBeenCalledWith(
      expect.objectContaining({ items: [expect.objectContaining({ storeId: targetStoreId })] }),
      expect.objectContaining({ sourceStageId: 'E005', submissionId: 'images' }),
      job.id
    );
  });

  it('keeps GET evidence SQL strictly read-only and reserves row locks for apply', async () => {
    const fanoutPlanHash = `sha256:${'a'.repeat(64)}`;
    const query = vi.fn(async (sqlInput: unknown) => {
      const sql = String(sqlInput);
      if (sql.includes('FROM ozon_publish_jobs WHERE id=$1')) {
        return { rows: [{
          id: 'b8094cb3-2c9c-411c-af6b-aab99bbff6d1', sku: '0000152', source: 'AUTO',
          task_kind: 'SHARED_PREPARATION', state: 'NEEDS_ATTENTION', row_version: 7,
          payload: { multistorePreparation: true, fanoutPlan: { planHash: fanoutPlanHash } },
          product_links: [], directory_stage: 'INBOX'
        }] };
      }
      if (sql.includes('FROM ozon_store_publications')) return { rows: [] };
      if (sql.includes('FROM ozon_media_deliveries')) {
        return { rows: [{
          source_stage_id: 'E005', submission_id: 'images', variant_id: 'brown',
          payload: { autoPublishDecision: 'ACCEPTED' }
        }] };
      }
      if (sql.includes('COUNT(*) count')) return { rows: [{ count: '0' }] };
      throw new Error(`unexpected read-only replan evidence query: ${sql}`);
    });
    const repository = new OzonRepository();
    Object.defineProperty(repository, 'pool', { value: { query }, configurable: true });

    await repository.getAutomaticPreparationReplanEvidence('b8094cb3-2c9c-411c-af6b-aab99bbff6d1');

    expect(query).toHaveBeenCalled();
    expect(query.mock.calls.map(([sql]) => String(sql)).some((sql) => /FOR\s+(UPDATE|SHARE)/i.test(sql))).toBe(false);
    expect(query.mock.calls.map(([sql]) => String(sql)).some((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false);
  });
});

function createFrozenReplanHarness(options: {
  secondStore?: boolean;
  secondCategoryMissingRequired?: boolean;
  evidenceBlockers?: string[];
  noBrandGateFails?: boolean;
} = {}) {
  const originalFanoutPlanHash = `sha256:${'a'.repeat(64)}`;
  const currentPlanHash = `sha256:${'b'.repeat(64)}`;
  const evidenceHash = `sha256:${'c'.repeat(64)}`;
  const storeIds = [
    '10000000-0000-4000-8000-000000000001',
    ...(options.secondStore ? ['20000000-0000-4000-8000-000000000002'] : [])
  ];
  const publicationIds = storeIds.map((_, index) => `${index + 3}0000000-0000-4000-8000-00000000000${index + 3}`);
  const publicationJobIds = storeIds.map((_, index) => `${index + 5}0000000-0000-4000-8000-00000000000${index + 5}`);
  const generatedVersionId = '70000000-0000-4000-8000-000000000007';
  const listing: any = {
    sku: '0000152', productName: '运动鞋', managementSource: 'AUTO', status: 'READY',
    rowVersion: 8, revision: 4, generatedVersionId,
    materialHash: `sha256:${'d'.repeat(64)}`,
    materialHashVersion: 'ozon-shared-material-v1',
    contentPolicyVersion: 'merchroute-ozon-content-v3',
    dataSignature: `sha256:${'e'.repeat(64)}`,
    data: { categoryKey: 'legacy_listing_category', categoryVersionId: randomUUID(), offers: [] },
    createdAt: '2026-08-24T01:00:00.000Z', updatedAt: '2026-08-24T01:01:00.000Z'
  };
  const job: any = {
    id: 'b8094cb3-2c9c-411c-af6b-aab99bbff6d1', sku: listing.sku,
    taskKind: 'SHARED_PREPARATION', state: 'NEEDS_ATTENTION', source: 'AUTO', storeAlias: 'default',
    offerIds: [], rowVersion: 7, retryCount: 0, stageStates: {}, ozonProductLinks: [],
    lastErrorCode: 'CONFIG_INVALID', lastErrorMessage: '缺少必填属性 31, 9163, 8292',
    payload: {
      multistorePreparation: true,
      mediaDeliveries: [{
        sourceStageId: 'E005', submissionId: 'images', variantId: 'brown',
        deliveredAt: '2026-08-24T01:00:00.000Z'
      }],
      fanoutPlan: {
        schemaVersion: 3, planHash: originalFanoutPlanHash,
        items: storeIds.map((storeId) => ({ storeId, ready: false, blockers: ['缺少必填属性'] }))
      }
    },
    createdAt: '2026-08-24T01:00:00.000Z', updatedAt: '2026-08-24T01:02:00.000Z'
  };
  const requiredAttributes = [
    { id: 31, complexId: 0, name: 'Бренд одежды и обуви', nameRu: 'Бренд одежды и обуви', nameZh: '服装和鞋类品牌', required: true },
    { id: 9163, complexId: 0, name: 'Пол', nameRu: 'Пол', nameZh: '性别', required: true },
    { id: 8292, complexId: 0, name: 'Объединить на одной карточке', nameRu: 'Объединить на одной карточке', nameZh: '合并至一张卡片', required: true },
    { id: 4298, complexId: 0, name: 'Российский размер', nameRu: 'Российский размер', nameZh: '俄罗斯尺码', required: true }
  ];
  const categories = new Map<string, any>([
    ['ozon_shoes', {
      publishedVersion: { id: '81000000-0000-4000-8000-000000000008', snapshot: {
        attributes: requiredAttributes, sizing: { sizeAttributeKey: '4298:0' }
      } }
    }],
    ['ozon_boots', {
      publishedVersion: { id: '82000000-0000-4000-8000-000000000008', snapshot: {
        attributes: [
          ...requiredAttributes,
          ...(options.secondCategoryMissingRequired
            ? [{ id: 555, complexId: 0, name: 'Материал', nameRu: 'Материал', nameZh: '材质', required: true }]
            : [])
        ],
        sizing: { sizeAttributeKey: '4298:0' }
      } }
    }]
  ]);
  const sizes = Array.from({ length: 11 }, (_, index) => ({
    sizeId: `${String(index + 1).padStart(8, '0')}-0000-4000-8000-000000000001`,
    value: String(35 + index), stock: 1
  }));
  const planStores = storeIds.map((storeId, storeIndex) => {
    const categoryKey = storeIndex === 0 ? 'ozon_shoes' : 'ozon_boots';
    const presetSnapshot = {
      categoryKey,
      sharedAttributes: [{ attributeId: 9163, complexId: 0, values: [{ dictionaryValueId: 22880, value: 'Мужской' }] }],
      variantAttributes: [], sizeAttributeKey: '4298:0', sizes
    };
    const offers = Array.from({ length: 33 }, (_, offerIndex) => ({
      offerId: `${listing.sku}-${String(offerIndex + 1).padStart(2, '0')}`,
      variantId: `color-${Math.floor(offerIndex / 11) + 1}`,
      sizeId: sizes[offerIndex % sizes.length]!.sizeId,
      stock: 1,
      attributes: [{ attributeId: 4298, complexId: 0, values: [{ value: sizes[offerIndex % sizes.length]!.value }] }]
    }));
    const productSnapshot = {
      sharedAttributes: [
        { attributeId: 31, complexId: 0, values: [{ dictionaryValueId: 1, value: 'Нет бренда' }] },
        { attributeId: 9163, complexId: 0, values: [{ dictionaryValueId: 22880, value: 'Мужской' }] },
        { attributeId: 8292, complexId: 0, values: [{ value: listing.sku }] }
      ],
      offers
    };
    return {
      storeId,
      storeSnapshot: { storeAlias: `store-${storeIndex + 1}`, presetSnapshot },
      productSnapshot,
      productSnapshotHash: `sha256:${createHash('sha256').update(stableTestJson(productSnapshot)).digest('hex')}`,
      modeEvidence: { evidenceHash: `sha256:${String(storeIndex + 7).repeat(64)}` }
    };
  });
  const planItems = planStores.map((entry, index) => ({
    storeId: entry.storeId, storeAlias: `store-${index + 1}`, ready: true, blockers: [],
    storeRowVersion: 3, storeConfigVersion: 4,
    credentialVersionId: `${index + 1}2000000-0000-4000-8000-00000000000${index + 1}`,
    presetId: `${index + 1}3000000-0000-4000-8000-00000000000${index + 1}`,
    presetRowVersion: 5, presetDefinitionHash: `sha256:${String(index + 5).repeat(64)}`,
    publicationMode: 'CREATE_ONLY', warehouseId: `warehouse-${index + 1}`,
    fulfillmentMode: 'FBS', accountCurrency: 'RUB',
    offerIds: (entry.productSnapshot.offers as any[]).map((offer) => offer.offerId)
  }));
  const eligibleStores = planItems.map((item, index) => ({
    id: item.storeId,
    storeAlias: item.storeAlias,
    rowVersion: item.storeRowVersion,
    configVersion: item.storeConfigVersion,
    defaultPresetId: item.presetId,
    presetRowVersion: item.presetRowVersion,
    presetSnapshot: planStores[index]!.storeSnapshot.presetSnapshot,
    autoPublishMode: item.publicationMode,
    credential: { activeVersionId: item.credentialVersionId },
    warehouseId: item.warehouseId,
    fulfillmentMode: item.fulfillmentMode,
    accountCurrency: item.accountCurrency,
    ...(options.noBrandGateFails ? {
      noBrandDictionaryRequirement: {
        categoryVersionId: '81000000-0000-4000-8000-000000000008',
        descriptionCategoryId: 17001,
        typeId: 97001,
        attributeId: 31,
        dictionaryId: 1
      }
    } : {})
  }));
  const freshPlan = {
    schemaVersion: 3,
    planHash: currentPlanHash,
    sku: listing.sku,
    contentPolicyVersion: listing.contentPolicyVersion,
    materialHash: listing.materialHash,
    materialHashVersion: listing.materialHashVersion,
    sourceMediaIdentityHash: `sha256:${'1'.repeat(64)}`,
    settingsRowVersion: 6,
    rootDirectoryHash: `sha256:${'2'.repeat(64)}`,
    variantColorAuthority: { hash: `sha256:${'3'.repeat(64)}` },
    items: planItems,
    stores: planStores
  };
  const evidenceBlockers = options.evidenceBlockers || [];
  const evidence: any = {
    safe: evidenceBlockers.length === 0,
    blockers: evidenceBlockers,
    evidenceHash,
    originalJobId: job.id,
    originalJobRowVersion: job.rowVersion,
    originalFanoutPlanHash,
    publicationIds,
    publicationJobIds,
    storeIds,
    publicationCount: storeIds.length,
    publicationJobCount: storeIds.length,
    gatewayRequestCount: evidenceBlockers.includes('GATEWAY_EVIDENCE_PRESENT') ? 1 : 0,
    mappingCount: 0,
    productLinkCount: 0,
    mediaDeliveryCount: 2,
    activeLeaseCount: 0,
    activeSlotCount: 0,
    activeStatusRefreshCount: 0
  };
  const replacementJob: any = {
    ...job,
    id: '90000000-0000-5000-8000-000000000009',
    state: 'READY', rowVersion: 1, revision: listing.revision + 1,
    payload: { multistorePreparation: true, replanRecovery: { recoveryMode: 'REPLAN_WITH_CURRENT_PRESET' } }
  };
  const automaticPublicationPlan = vi.fn(async () => structuredClone(freshPlan));
  const proveExactNoBrandDictionaryValue = vi.fn(async () => {
    if (options.noBrandGateFails) {
      throw new AppError('CONFIG_INVALID', 'Нет бренда 字典值不唯一', undefined, 409);
    }
    return { dictionaryValueId: 126745801 };
  });
  const replaceAutomaticPreparationWithCurrentPreset = vi.fn(async (input: any) => {
    const marker = {
      requestId: input.requestId,
      planHash: input.planHash,
      replacementPreparationJobId: replacementJob.id
    };
    job.rowVersion += 1;
    job.payload = { ...job.payload, replanReplacement: marker };
    return { job: replacementJob, supersededJob: structuredClone(job), idempotent: false };
  });
  const repository: any = {
    getJob: vi.fn(async (id: string) => id === replacementJob.id ? replacementJob : job),
    getListing: vi.fn(async () => listing),
    getCategory: vi.fn(async (categoryKey: string) => categories.get(categoryKey)
      || Promise.reject(new AppError('NOT_FOUND', '类目不存在', { categoryKey }, 404))),
    getAutomaticPreparationRecoveryEvidence: vi.fn(async () => ({
      publicationCount: storeIds.length,
      gatewayRequestCount: 0,
      productLinkCount: 0,
      mappingCount: 0,
      importIntentPresent: false,
      platformWriteAttempted: false,
      activeLease: false,
      activeSlot: false,
      activeStatusRefresh: false
    })),
    getAutomaticPreparationReplanEvidence: vi.fn(async () => evidence),
    replaceAutomaticPreparationWithCurrentPreset,
    recheck: vi.fn()
  };
  const coordinator = new OzonAutoPublishingCoordinator(
    repository,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    { warn: vi.fn() } as any,
    {},
    {
      storeRepository: {
        listEligibleAutoStores: vi.fn(async () => eligibleStores),
        listPublications: vi.fn(async () => [])
      } as any,
      storeService: { automaticPublicationPlan } as any,
      storeGateway: { proveExactNoBrandDictionaryValue } as any
    }
  );
  return {
    coordinator, repository, job, listing, replacementJob, storeIds, originalFanoutPlanHash,
    automaticPublicationPlan, replaceAutomaticPreparationWithCurrentPreset, proveExactNoBrandDictionaryValue
  };
}

async function createPrePlanHarness(options: {
  mediaOwnerDrift?: boolean;
  remoteState?: 'ABSENT' | 'UNKNOWN' | 'PRESENT';
  driftRemoteEvidenceOnApply?: boolean;
  sizedPresets?: boolean;
  invalidProofHash?: boolean;
} = {}) {
  const fixture = await createFixture();
  const image = await fixture.asset('E005', 'image', 'images', 'variants/咖啡色/images/01.png', Buffer.from('pre-plan-image'), '2026-08-12T10:00:00Z');
  const video = await fixture.asset('E004', 'video', 'video', 'variants/咖啡色/videos/01.mp4', testMp4(12), '2026-08-12T10:01:00Z');
  await fixture.manifest([image, video]);
  const job: any = {
    id: 'b8094cb3-2c9c-411c-af6b-aab99bbff6d1',
    sku: fixture.sku,
    taskKind: 'SHARED_PREPARATION',
    state: 'FAILED',
    source: 'AUTO',
    storeAlias: 'default',
    offerIds: [],
    payload: {
      multistorePreparation: true,
      mediaManifestPath: fixture.manifestPath,
      mediaDeliveries: [
        { sourceStageId: 'E004', submissionId: video.submissionId, variantId: fixture.variantId, deliveredAt: video.deliveredAt },
        { sourceStageId: 'E005', submissionId: image.submissionId, variantId: fixture.variantId, deliveredAt: image.deliveredAt }
      ]
    },
    stageStates: {},
    retryCount: 0,
    rowVersion: 7,
    lastErrorCode: 'CONFIG_INVALID',
    lastErrorMessage: 'descriptionRu: IMITATION_CLAIM',
    ozonProductLinks: [],
    createdAt: '2026-08-12T10:00:00Z',
    updatedAt: '2026-08-12T10:02:00Z'
  };
  const offerId = `${fixture.sku}-01`;
  const mediaAssets = uniqueManifestAssets([image, video]);
  const media = mediaAssets.map((asset, sortOrder) => ({
    assetId: asset.assetId,
    relativePath: asset.relativePath,
    kind: asset.kind,
    sortOrder,
    isPrimary: asset.kind === 'image'
  }));
  const listing: any = {
    sku: fixture.sku,
    productName: fixture.productName,
    managementSource: 'AUTO',
    status: 'DRAFT',
    rowVersion: 1,
    revision: 1,
    data: {
      titleRu: '',
      descriptionRu: 'Это аналогичный аксессуар для ежедневного использования.',
      offers: [{
        variantId: fixture.variantId,
        productVariantId: fixture.variantId,
        productVariantName: '咖啡色',
        variantCode: '01',
        offerId,
        barcode: '', modelGroup: fixture.sku, price: 1, stock: 1,
        descriptionRu: 'Подходит как аналогичный вариант для города.',
        attributes: [], media
      }],
      mediaAssets,
      fulfillmentMode: 'FBS', warehouseId: '', currency: 'CNY', vat: '0.2',
      brand: '', sharedAttributes: [], mediaSourceRoot: fixture.productRoot,
      videoUploadMode: 'COMPRESSED_COPY', descriptionWarnings: []
    },
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
  const cleanDatabase = {
    publicationCount: 0, mappingCount: 0, gatewayRequestCount: 0, productLinkCount: 0,
    importIntentPresent: false, platformWriteAttempted: false, activeLease: false,
    activeSlot: false, activeStatusRefresh: false
  };
  const repository: any = {
    getJob: vi.fn(async () => job),
    getListing: vi.fn(async () => listing),
    getSettings: vi.fn(async () => ({ rootDirectory: fixture.rootDirectory })),
    getAutomaticPreparationRecoveryEvidence: vi.fn(async () => cleanDatabase),
    resolveAutomaticMediaDeliveryEvidence: vi.fn(async ({ identities }: any) => identities.map((identity: any) => ({
      ...identity,
      decision: 'ACCEPTED',
      jobId: options.mediaOwnerDrift ? randomUUID() : job.id
    }))),
    transitionJob: vi.fn(async (id: string, input: any) => ({
      ...job,
      id,
      state: input.state,
      rowVersion: job.rowVersion + 1,
      payload: { ...job.payload, ...input.jobPayload }
    })),
    rearmAutomaticPrePlanRecovery: vi.fn(async (input: any) => ({
      ...job,
      id: input.jobId,
      state: 'READY',
      rowVersion: job.rowVersion + 1,
      payload: {
        ...job.payload,
        prePlanRecovery: {
          schemaVersion: 1,
          requestId: input.requestId,
          planHash: input.planHash,
          targetStores: input.targetStores,
          productIdentity: input.expectedProductIdentity,
          manifestSignature: input.expectedManifestSignature,
          evidence: input.recoveryEvidence
        }
      }
    }))
  };
  const presetSnapshot: any = {
    name: 'PRE_PLAN 测试预设',
    description: '',
    categoryKey: 'ozon_17001_97001',
    pricingTemplateId: randomUUID(),
    shippingTemplateId: randomUUID(),
    shippingServiceCode: 'CEL_RFBS_ECONOMY',
    destinationCountryCode: 'RU',
    vat: '0.2',
    defaultStock: 4,
    dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 800, weightUnit: 'g' },
    sharedAttributes: [],
    variantAttributes: [],
    titleTranslation: { workflowId: 'HDh0ZNLK2ps5qasR', language: '俄文', maxLength: 60 },
    descriptionSource: 'E003',
    sizes: [{ value: '', stock: 4 }],
    mediaPolicy: 'REPLACE_ALL'
  };
  const stores = [1, 2].map((index) => ({
    id: `${index}0000000-0000-4000-8000-00000000000${index}`,
    storeAlias: `store-${index}`, rowVersion: 2, configVersion: 3,
    defaultPresetId: `${index}1000000-0000-4000-8000-00000000000${index}`,
    presetRowVersion: 4, autoPublishMode: 'CREATE_ONLY',
    credential: { bindingMode: 'VAULT', activeVersionId: `${index}2000000-0000-4000-8000-00000000000${index}` },
    presetSnapshot: {
      ...structuredClone(presetSnapshot),
      ...(options.sizedPresets && index === 1 ? {
        sizeAttributeKey: '100:0',
        sizes: [
          { sizeId: '31000000-0000-4000-8000-000000000001', value: 'S', stock: 2 },
          { sizeId: '31000000-0000-4000-8000-000000000002', value: 'M', stock: 2 }
        ]
      } : {})
    },
    warehouseId: `warehouse-${index}`,
    fulfillmentMode: 'FBS',
    accountCurrency: 'RUB',
    readiness: { ready: true }
  }));
  let proofCall = 0;
  const proveStoreOfferAbsence = vi.fn(async (input: any) => {
    const callIndex = proofCall++;
    if (options.remoteState === 'UNKNOWN' && callIndex % stores.length === 0) {
      throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'timeout', { outcome: 'UNKNOWN' }, 409);
    }
    if (options.remoteState === 'PRESENT' && callIndex % stores.length === 0) {
      throw new AppError('OZON_REMOTE_STATE_PRESENT', 'present', { offerIds: input.offerIds }, 409);
    }
    const semanticRound = options.driftRemoteEvidenceOnApply && callIndex >= stores.length ? 'changed' : 'stable';
    const operations = [
      { operation: 'infoList', endpoint: semanticRound === 'changed' ? '/v3/product/info/list?drift=1' : '/v3/product/info/list', statusCode: 200, responseShape: 'ITEMS', itemCount: 0, paginationComplete: true },
      { operation: 'attributesInfo', endpoint: '/v4/product/info/attributes', statusCode: 200, responseShape: 'RESULT_ITEMS', itemCount: 0, paginationComplete: true }
    ];
    const semantic = {
      absent: true,
      status: 'CONFIRMED_ABSENT',
      storeId: input.storeId,
      storeConfigVersion: input.expectedStoreConfigVersion,
      credentialVersionId: input.expectedCredentialVersionId,
      offerIds: [...input.offerIds],
      operations
    };
    return {
      ...semantic,
      checkedAt: new Date(Date.now() + callIndex).toISOString(),
      evidenceHash: options.invalidProofHash
        ? `sha256:${'f'.repeat(64)}`
        : `sha256:${createHash('sha256').update(stableTestJson(semantic)).digest('hex')}`
    };
  });
  const coordinator = new OzonAutoPublishingCoordinator(
    repository,
    {} as any,
    { getProductIdentityBySku: vi.fn(async () => ({
      sku: fixture.sku,
      productName: fixture.productName,
      variants: [{ variantId: fixture.variantId, name: '咖啡色' }]
    })) } as any,
    {} as any,
    {} as any,
    {} as any,
    { read: () => ({ submissionHistory: [] }) } as any,
    { warn: vi.fn() } as any,
    {},
    {
      storeRepository: { listEligibleAutoStores: vi.fn(async () => stores) } as any,
      storeService: {} as any,
      storeGateway: { proveStoreOfferAbsence }
    }
  );
  return { coordinator, fixture, job, listing, stores, repository, proveStoreOfferAbsence };
}

function createManualSuccessReconcileHarness(options: { missingPublication?: boolean } = {}) {
  const offerId = '0000170-01';
  const autoJob: any = {
    id: '5f848e98-f28a-4bcc-8f1d-2fab1bae0b7a',
    sku: '0000170',
    taskKind: 'SHARED_PREPARATION',
    state: 'NEEDS_ATTENTION',
    source: 'AUTO',
    storeAlias: 'default',
    offerIds: [],
    rowVersion: 7,
    retryCount: 0,
    stageStates: {},
    ozonProductLinks: [],
    payload: { multistorePreparation: true },
    lastErrorCode: 'CONFIG_INVALID',
    lastErrorMessage: 'descriptionRu 命中关键词堆砌规则',
    createdAt: '2026-09-04T01:00:00.000Z',
    updatedAt: '2026-09-04T01:01:00.000Z'
  };
  const listing: any = {
    sku: autoJob.sku,
    productName: '测试商品',
    status: 'PUBLISHED',
    managementSource: 'MANUAL',
    rowVersion: 11,
    revision: 5,
    data: { offers: [{ offerId }] }
  };
  const store: any = {
    id: '24666790-0000-4000-8000-000000000001',
    storeAlias: 'glauke',
    displayName: 'Glauke/2466679'
  };
  const manualJobId = '17000000-0000-4000-8000-000000000002';
  const publication: any = {
    id: '17000000-0000-4000-8000-000000000001',
    sku: autoJob.sku,
    storeId: store.id,
    source: 'MANUAL',
    status: 'SUCCEEDED',
    offerIds: [offerId],
    productIds: ['123456789'],
    productLinks: ['https://www.ozon.ru/product/987654321/'],
    plannedJobId: manualJobId,
    preparationJobId: null,
    rowVersion: 4,
    completedAt: '2026-09-04T02:00:00.000Z'
  };
  const manualJob: any = {
    id: manualJobId,
    sku: autoJob.sku,
    taskKind: 'STORE_PUBLICATION',
    state: 'SUCCEEDED',
    source: 'MANUAL',
    storeAlias: store.storeAlias,
    offerIds: [offerId],
    rowVersion: 9,
    retryCount: 0,
    stageStates: {},
    publicationId: publication.id,
    ozonProductLinks: [{
      offerId,
      ozonProductId: '123456789',
      ozonSku: '987654321',
      url: publication.productLinks[0],
      displayState: 'ON_SALE',
      lastVerifiedAt: '2026-09-04T02:01:00.000Z'
    }],
    payload: {},
    createdAt: '2026-09-04T01:30:00.000Z',
    updatedAt: '2026-09-04T02:01:00.000Z'
  };
  const reconcileResult = {
    job: { ...autoJob, state: 'CANCELLED', rowVersion: autoJob.rowVersion + 1 },
    requestId: 'result-request-id',
    reconciliation: { mode: 'MANUAL_SUCCESS_RECONCILE', targetStoreCount: 1 }
  };
  const reconcileAutomaticPreparationToManualSuccess = vi.fn(async () => reconcileResult);
  const repository = {
    getJob: vi.fn(async (id: string, source: 'AUTO' | 'MANUAL') => {
      if (id === autoJob.id && source === 'AUTO') return autoJob;
      if (id === manualJob.id && source === 'MANUAL') return manualJob;
      throw new AppError('NOT_FOUND', '任务不存在', { id, source }, 404);
    }),
    getListing: vi.fn(async () => listing),
    getAutomaticPreparationRecoveryEvidence: vi.fn(async () => ({
      publicationCount: 0,
      gatewayRequestCount: 0,
      productLinkCount: 0,
      mappingCount: 1,
      importIntentPresent: false,
      platformWriteAttempted: false,
      activeLease: false,
      activeSlot: false,
      activeStatusRefresh: false
    })),
    reconcileAutomaticPreparationToManualSuccess
  };
  const storeRepository = {
    listEligibleAutoStores: vi.fn(async () => [store]),
    listPublications: vi.fn(async () => options.missingPublication ? [] : [publication])
  };
  const coordinator = new OzonAutoPublishingCoordinator(
    repository as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { warn: vi.fn() } as any,
    {},
    { storeRepository: storeRepository as any, storeService: {} as any }
  );
  return {
    coordinator,
    autoJob,
    listing,
    store,
    publication,
    manualJob,
    reconcileAutomaticPreparationToManualSuccess,
    reconcileResult
  };
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-auto-'));
  roots.push(root);
  const sku = '0000051';
  const productName = '复古斜挎包';
  const variantId = randomUUID();
  const productRoot = path.join(root, 'inbox', sku);
  const manifestPath = path.join(productRoot, 'variants', 'variant-media-manifest.json');
  await mkdir(path.dirname(manifestPath), { recursive: true });
  return {
    rootDirectory: root,
    productRoot,
    sku,
    productName,
    variantId,
    manifestPath,
    async asset(sourceStageId: 'E004' | 'E005', kind: 'image' | 'video', submissionId: string, relativePath: string, content: Buffer, deliveredAt: string) {
      const filePath = path.join(productRoot, ...relativePath.split('/'));
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
      const sha256 = createHash('sha256').update(content).digest('hex');
      return {
        assetId: sha256,
        submissionId,
        sourceStageId,
        kind,
        variantId,
        variantName: '咖啡色',
        variantColor: { nameRu: 'кофе', nameZh: '咖啡色' },
        relativePath,
        deliveredAt,
        sizeBytes: content.length,
        sha256
      };
    },
    async manifest(assets: unknown[]) {
      await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, SKU: sku, productName, assets }, null, 2));
    }
  };
}

async function createAutoGrossWeightHarness(input: {
  procurementGrossWeightGrams: unknown;
  pricingFailures?: number;
  existingResolution?: Record<string, unknown>;
}) {
  const fixture = await createFixture();
  const image = await fixture.asset(
    'E005',
    'image',
    'images',
    'варианты/кофе/изображения/01.png',
    Buffer.from('gross-weight-image'),
    '2026-08-07T01:00:00.000Z'
  );
  const video = await fixture.asset(
    'E004',
    'video',
    'video',
    'варианты/кофе/видео/01.mp4',
    testMp4(12),
    '2026-08-07T01:01:00.000Z'
  );
  await fixture.manifest([image, video]);
  const retainedVariantId = randomUUID();
  const existingMediaAssets = uniqueManifestAssets([image, video]).map((asset) => ({
    ...asset,
    assetId: `retained-${asset.assetId}`,
    productVariantId: retainedVariantId,
    productVariantName: '已上架颜色'
  }));

  const preset = {
    id: randomUUID(),
    name: 'OZON 自动预设',
    rowVersion: 6,
    description: '',
    autoPublishEnabled: true,
    autoPublishMode: 'COMPATIBLE_UPSERT',
    fulfillmentMode: 'FBS',
    warehouseId: '10001',
    categoryKey: 'ozon_17001_97001',
    pricingTemplateId: randomUUID(),
    shippingTemplateId: randomUUID(),
    shippingServiceCode: 'CEL_RFBS_ECONOMY',
    destinationCountryCode: 'RU',
    currency: 'RUB',
    vat: '0.2',
    defaultStock: 4,
    dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 800, weightUnit: 'g' },
    sharedAttributes: [],
    variantAttributes: [],
    titleTranslation: { workflowId: 'HDh0ZNLK2ps5qasR', language: '俄文', maxLength: 60 },
    descriptionSource: 'E003',
    sizes: [{ value: '', stock: 4 }],
    mediaPolicy: 'REPLACE_ALL',
    isDefault: true
  } as any;
  const categoryVersionId = randomUUID();
  const firstProcurementVersionId = randomUUID();
  let latestProcurement: any = {
    id: firstProcurementVersionId,
    versionNo: 7,
    purchasePrice: '31',
    courierFee: '2',
    grossWeightGrams: input.procurementGrossWeightGrams
  };
  let currentJob: any = {
    id: randomUUID(),
    sku: fixture.sku,
    offerIds: [],
    storeAlias: 'default',
    state: 'WAITING_MEDIA',
    source: 'AUTO',
    payload: {
      publicationIntent: 'APPEND_MISSING',
      multistorePreparation: true,
      multistoreAdmission: {
        storeId: randomUUID(),
        presetId: preset.id,
        activatedAt: '2026-08-01T00:00:00.000Z',
        autoPublishMode: 'COMPATIBLE_UPSERT'
      }
    },
    stageStates: { images: 'WAITING_LOCAL', video: 'WAITING_LOCAL', import: 'PENDING', moderation: 'PENDING' },
    retryCount: 0,
    rowVersion: 1,
    ozonProductLinks: [],
    createdAt: '2026-08-07T01:00:00.000Z',
    updatedAt: '2026-08-07T01:00:00.000Z'
  };
  let currentListing: any = {
    sku: fixture.sku,
    productName: fixture.productName,
    status: 'PUBLISHED',
    managementSource: 'AUTO',
    rowVersion: 2,
    revision: 1,
    generatedVersionId: randomUUID(),
    materialHash: `sha256:${'7'.repeat(64)}`,
    materialHashVersion: 'ozon-shared-material-v1',
    contentPolicyVersion: 'merchroute-ozon-content-v3',
    data: {
      categoryKey: preset.categoryKey,
      categoryVersionId,
      fulfillmentMode: 'FBS',
      warehouseId: '10001',
      currency: 'RUB',
      vat: '0.2',
      titleRu: 'Ручной заголовок',
      descriptionRu: 'Ручное описание',
      brand: 'Ручной бренд',
      dimensions: preset.dimensions,
      sharedAttributes: [],
      offers: [{
        variantId: retainedVariantId,
        productVariantId: retainedVariantId,
        productVariantName: '已上架颜色',
        variantCode: '01',
        offerId: `${fixture.sku}-01`,
        barcode: '460000000001',
        modelGroup: fixture.sku,
        price: 300,
        oldPrice: 600,
        minPrice: 150,
        stock: 1,
        descriptionRu: 'Ручное описание варианта',
        descriptionWarnings: [],
        attributes: [{ attributeId: 10097, complexId: 0, values: [{ value: 'ручной цвет' }] }],
        media: existingMediaAssets.map((asset, index) => ({
          assetId: asset.assetId,
          relativePath: asset.relativePath,
          kind: asset.kind,
          sortOrder: index,
          isPrimary: asset.kind === 'image'
        }))
      }],
      mediaAssets: existingMediaAssets,
      mediaSourceRoot: fixture.productRoot,
      videoUploadMode: 'COMPRESSED_COPY',
      initialization: {
        status: 'COMPLETE',
        initializedAt: '2026-08-01T08:00:00.000Z',
        issues: [],
        presetSnapshot: {
          presetId: preset.id,
          presetName: preset.name,
          presetRowVersion: preset.rowVersion,
          capturedAt: '2026-08-01T08:00:00.000Z',
          definition: structuredClone(preset)
        },
        ...(input.existingResolution ? { grossWeightResolution: input.existingResolution } : {})
      }
    },
    ozonProductLinks: [{
      offerId: `${fixture.sku}-01`,
      ozonProductId: '123456789',
      ozonSku: '987654321',
      url: 'https://www.ozon.ru/product/987654321/'
    }],
    createdAt: '2026-08-07T01:00:00.000Z',
    updatedAt: '2026-08-07T01:00:00.000Z'
  };
  let listingExists = true;
  let hasProductMapping = true;
  let activeManualJobCount = 0;
  let createConflict = false;
  let updateFailures = 0;
  let mappingAppearsAfterUpdate = false;
  let normalizeAfterUpdate = false;
  const transitionJob = vi.fn(async (_id, transition: any) => {
    currentJob = {
      ...currentJob,
      state: transition.state,
      rowVersion: currentJob.rowVersion + 1,
      payload: { ...(currentJob.payload || {}), ...(transition.jobPayload || {}) },
      stageStates: { ...currentJob.stageStates, ...(transition.stageStates || {}) },
      updatedAt: new Date().toISOString()
    };
    return currentJob;
  });
  const createListingIfAbsent = vi.fn(async (_identity: unknown, _preset: unknown, initializedData?: any) => {
    if (createConflict) {
      listingExists = true;
      currentListing = {
        ...currentListing,
        status: 'DRAFT',
        managementSource: 'MANUAL',
        rowVersion: 1,
        revision: 1,
        data: { ...currentListing.data, titleRu: '人工并发草稿' }
      };
      throw new AppError('TASK_LOCKED', 'OZON 草稿已被并发创建', { reasonCode: 'OZON_LISTING_CREATED_CONCURRENTLY' }, 409);
    }
    if (listingExists) {
      throw new AppError('TASK_LOCKED', 'OZON 草稿已被并发创建', { reasonCode: 'OZON_LISTING_CREATED_CONCURRENTLY' }, 409);
    }
    listingExists = true;
    currentListing = {
      ...currentListing,
      status: 'DRAFT',
      managementSource: 'AUTO',
      rowVersion: 1,
      revision: 1,
      generatedVersionId: randomUUID(),
      materialHash: `sha256:${'6'.repeat(64)}`,
      materialHashVersion: 'ozon-shared-material-v1',
      contentPolicyVersion: 'merchroute-ozon-content-v3',
      ...(initializedData ? { data: initializedData } : {})
    };
    if (normalizeAfterUpdate) {
      currentListing.data = {
        ...currentListing.data,
        descriptionWarnings: [{ code: 'SIMULATED_REPOSITORY_NORMALIZATION' }]
      };
    }
    if (mappingAppearsAfterUpdate) hasProductMapping = true;
    return currentListing;
  });
  const updateListing = vi.fn(async (_sku, update: any) => {
    if (updateFailures > 0) {
      updateFailures -= 1;
      throw new Error('模拟 updateListing 后台进程崩溃');
    }
    currentListing = {
      ...currentListing,
      status: 'READY',
      managementSource: 'AUTO',
      rowVersion: currentListing.rowVersion + 1,
      revision: currentListing.revision + 1,
      generatedVersionId: randomUUID(),
      materialHash: `sha256:${'5'.repeat(64)}`,
      materialHashVersion: 'ozon-shared-material-v1',
      contentPolicyVersion: 'merchroute-ozon-content-v3',
      data: Object.fromEntries(Object.entries(update).filter(([key]) => key !== 'rowVersion')),
      updatedAt: new Date().toISOString()
    };
    return currentListing;
  });
  const persistAutomaticSharedMaterialRevision = vi.fn(async (input: any) => {
    if (createConflict) {
      listingExists = true;
      currentListing = {
        ...currentListing,
        status: 'DRAFT',
        managementSource: 'MANUAL',
        rowVersion: 1,
        revision: 1,
        data: { ...currentListing.data, titleRu: '人工并发草稿' }
      };
      throw new AppError('TASK_LOCKED', 'OZON 草稿已被并发创建', { reasonCode: 'OZON_LISTING_CREATED_CONCURRENTLY' }, 409);
    }
    if (listingExists) {
      if (input.expectedListingRowVersion !== currentListing.rowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 自动公共素材已变化，请重新准备', { reasonCode: 'OZON_SHARED_MATERIAL_CAS_DRIFT' }, 409);
      }
      await updateListing(input.sku, input.data);
    } else {
      await createListingIfAbsent({ sku: input.sku, productName: input.productName }, undefined, input.data);
    }
    currentListing = {
      ...currentListing,
      status: 'READY',
      managementSource: 'AUTO',
      generatedVersionId: currentListing.generatedVersionId || randomUUID(),
      materialHash: currentListing.materialHash || `sha256:${'5'.repeat(64)}`,
      materialHashVersion: 'ozon-shared-material-v1',
      contentPolicyVersion: 'merchroute-ozon-content-v3',
      dataSignature: `sha256:${createHash('sha256').update(JSON.stringify(currentListing.data)).digest('hex')}`
    };
    currentJob = {
      ...currentJob,
      state: 'READY',
      rowVersion: currentJob.rowVersion + 1,
      offerIds: [...input.offerIds],
      payload: {
        ...currentJob.payload,
        generatedVersionId: currentListing.generatedVersionId,
        materialHash: currentListing.materialHash,
        materialHashVersion: currentListing.materialHashVersion,
        contentPolicyVersion: currentListing.contentPolicyVersion,
        sharedMaterialPreparation: {
          schemaVersion: 1,
          preparedByJobId: currentJob.id,
          listingRowVersion: currentListing.rowVersion,
          listingRevision: currentListing.revision,
          dataSignature: currentListing.dataSignature,
          mediaSignature: input.mediaSignature
        }
      }
    };
    transitionJob.mock.calls.push([currentJob.id, {
      rowVersion: input.jobRowVersion,
      state: 'READY',
      offerIds: input.offerIds,
      eventType: 'AUTO_SHARED_MATERIAL_PREPARED',
      jobPayload: {
        generatedVersionId: currentListing.generatedVersionId,
        materialHash: currentListing.materialHash,
        materialHashVersion: currentListing.materialHashVersion,
        contentPolicyVersion: currentListing.contentPolicyVersion,
        sharedMaterialPreparation: currentJob.payload.sharedMaterialPreparation
      }
    }]);
    return { listing: currentListing, job: currentJob };
  });
  const repository = {
    configured: true,
    resolveAutomaticMediaDeliveryEvidence: vi.fn(async ({ identities }: { identities: any[] }) => identities.map((identity) => ({
      sourceStageId: identity.sourceStageId,
      submissionId: identity.submissionId,
      variantId: identity.variantId,
      deliveredAt: identity.deliveredAt,
      decision: 'ACCEPTED',
      jobId: currentJob.id
    }))),
    getJob: vi.fn(async () => currentJob),
    getSettings: vi.fn(async () => ({
      enabled: true,
      credentialReady: true,
      rootDirectory: fixture.rootDirectory,
      defaultStoreAlias: 'default'
    })),
    getPreset: vi.fn(async () => preset),
    getDefaultPreset: vi.fn(async () => preset),
    listManualJobsForSku: vi.fn(async () => ({ items: [], total: activeManualJobCount, page: 1, pageSize: 1 })),
    hasProductMappingForSku: vi.fn(async () => hasProductMapping),
    getListing: vi.fn(async () => {
      if (!listingExists) throw new AppError('NOT_FOUND', 'OZON 上品草稿不存在', undefined, 404);
      return currentListing;
    }),
    getCategory: vi.fn(async () => ({
      descriptionCategoryId: 17001,
      typeId: 97001,
      publishedVersion: {
        id: categoryVersionId,
        versionNo: 3,
        schemaHash: `sha256:${'a'.repeat(64)}`,
        snapshot: { nameRu: 'Сумка', attributes: [], media: { defaultVideoUploadMode: 'COMPRESSED_COPY' } }
      }
    })),
    searchCatalogDictionary: vi.fn(async () => []),
    transitionJob,
    persistAutomaticSharedMaterialRevision,
    createListingIfAbsent,
    updateListing
  } as unknown as OzonRepository;
  let identityVariants: any[] = [
    {
      variantId: retainedVariantId,
      name: '已上架颜色',
      wbColor: { colorKey: 'a'.repeat(64), nameRu: 'бежевый', nameZh: '已上架颜色' }
    },
    {
      variantId: fixture.variantId,
      name: '咖啡色',
      wbColor: { colorKey: 'c'.repeat(64), nameRu: 'кофе', nameZh: '咖啡色' }
    }
  ];
  const purchases = {
    configured: true,
    getProductIdentityBySku: vi.fn(async () => ({
      sku: fixture.sku,
      productName: fixture.productName,
      variants: identityVariants
    })),
    getPurchase: vi.fn(async () => ({
      sku: fixture.sku,
      productName: fixture.productName,
      procurementVersions: [{ ...latestProcurement }]
    }))
  } as unknown as PurchaseRepository;
  const amount = (value: string) => ({
    costCurrency: { currencyCode: 'CNY', value, displayValue: value },
    saleCurrency: { currencyCode: 'RUB', value, displayValue: value }
  });
  const successfulPricingResult = {
    pricingTemplate: { platformCode: 'OZON' },
    options: [{
      optionId: 'ozon-economy',
      shipping: { serviceCode: preset.shippingServiceCode, template: { platformCode: 'OZON' } },
      amounts: { listing: amount('385.33'), strike: amount('770.65'), targetSale: amount('192.66') }
    }]
  };
  const calculate = vi.fn();
  for (let index = 0; index < (input.pricingFailures || 0); index += 1) {
    calculate.mockRejectedValueOnce(new Error('定价服务暂时不可用'));
  }
  calculate.mockResolvedValue(successfulPricingResult);
  const pricing = { configured: true, calculate } as any;
  const descriptions = {
    resolveVariants: vi.fn(async (_sku: string, _productName: string, variants: any[]) => ({
      status: 'READY',
      content: 'Общее описание товара.',
      source: {
        workflowCode: 'E003', executionId: 88, folderName: 'latest', fileName: 'detail.txt',
        sha256: 'a'.repeat(64), productVariantId: variants[0]?.variantId
      },
      variantSources: variants.map((variant, index) => ({
        status: 'READY',
        productVariantId: variant.variantId,
        productVariantName: variant.name,
        content: `Описание варианта номер ${index + 1}.`,
        source: {
          workflowCode: 'E003', executionId: 88 + index, folderName: `latest-${index}`, fileName: 'detail.txt',
          sha256: String(index + 1).repeat(64), productVariantId: variant.variantId
        }
      }))
    }))
  } as any;
  const titleTranslator = {
    configured: true,
    translate: vi.fn(async () => ({ contentTranslate: 'Тестовый товар', cached: false, model: 'qwen' }))
  } as any;
  const publishing = {
    resolveStoreContext: vi.fn(async () => ({ warehouseId: '10001', accountCurrency: 'RUB' })),
    dispatchAutomaticJob: vi.fn(async () => undefined)
  } as unknown as OzonPublishingService;
  const eligibleAutoStores = [{ id: randomUUID() }, { id: randomUUID() }];
  const frozenPlanHash = `sha256:${'9'.repeat(64)}`;
  const storeRepository = {
    completeFanoutPreparation: vi.fn(async () => undefined),
    finalizeMediaFanout: vi.fn(async () => true),
    finalizeMediaFanoutBatch: vi.fn(async () => true),
    freezePreparationFanoutPlan: vi.fn(async (_jobId: string, _rowVersion: number, plan: any) => {
      currentJob = {
        ...currentJob,
        rowVersion: currentJob.rowVersion + 1,
        payload: { ...currentJob.payload, fanoutPlan: structuredClone(plan) }
      };
      return structuredClone(plan);
    }),
    getStore: vi.fn(),
    isFleetCapabilityReady: vi.fn(() => true),
    listEligibleAutoStores: vi.fn(async () => eligibleAutoStores),
    listStores: vi.fn(async () => [])
  };
  const storeService = {
    automaticPublicationPlan: vi.fn(async () => ({
      planHash: frozenPlanHash,
      generatedVersionId: currentListing.generatedVersionId || randomUUID(),
      revision: currentListing.revision,
      contentPolicyVersion: 'merchroute-ozon-content-v3',
      materialHash: currentListing.materialHash || `sha256:${'8'.repeat(64)}`,
      materialHashVersion: 'ozon-shared-material-v1',
      items: eligibleAutoStores.map((store, index) => ({
        storeId: store.id,
        publicationId: randomUUID(),
        plannedJobId: randomUUID(),
        taskId: `store-${index + 1}__${fixture.sku}__r${currentListing.revision}`,
        storeConfigVersion: 1,
        credentialVersionId: randomUUID(),
        presetId: preset.id,
        presetRowVersion: preset.rowVersion,
        presetDefinitionHash: `sha256:${String(index + 1).repeat(64)}`,
        publicationMode: 'COMPATIBLE_UPSERT',
        materializationHash: `sha256:${String(index + 3).repeat(64)}`,
        offerContractHash: `sha256:${String(index + 5).repeat(64)}`
      }))
    })),
    createAutomaticPublicationsFromFrozenPlan: vi.fn(async () => ({
      publications: [{ id: randomUUID() }, { id: randomUUID() }],
      failures: [],
      accepted: 2,
      failed: 0
    }))
  };
  const coordinator = new OzonAutoPublishingCoordinator(
    repository,
    publishing,
    purchases,
    pricing,
    descriptions,
    titleTranslator,
    { read: () => ({ submissionHistory: [] }) } as any,
    { warn: vi.fn() } as unknown as FastifyBaseLogger,
    { stableProbeMs: 0 },
    { storeRepository: storeRepository as any, storeService: storeService as any }
  );

  return {
    coordinator,
    repository,
    fixture,
    preset,
    retainedVariantId,
    firstProcurementVersionId,
    pricing,
    publishing,
    purchases,
    descriptions,
    titleTranslator,
    storeRepository,
    storeService,
    transitionJob,
    persistAutomaticSharedMaterialRevision,
    createListing: createListingIfAbsent,
    updateListing,
    job: () => currentJob,
    setLatestProcurement(value: any) { latestProcurement = value; },
    setListingInitialization(value: any) { currentListing.data.initialization = value; },
    setListingAbsent() {
      listingExists = false;
      hasProductMapping = false;
      identityVariants = identityVariants.filter((variant) => variant.variantId !== retainedVariantId);
    },
    setProductMapping(value: boolean) { hasProductMapping = value; },
    setCreateConflict(value = true) { createConflict = value; },
    setUpdateFailures(value: number) { updateFailures = value; },
    setMappingAppearsAfterUpdate(value = true) { mappingAppearsAfterUpdate = value; },
    setNormalizeAfterUpdate(value = true) { normalizeAfterUpdate = value; },
    setActiveManualJobCount(value: number) { activeManualJobCount = value; },
    setJobState(value: string) { currentJob.state = value; },
    setListingStatus(value: string) { currentListing.status = value; },
    setListingManagementSource(value: 'MANUAL' | 'AUTO') { currentListing.managementSource = value; },
    setProductLinks(value: any[]) { currentListing.ozonProductLinks = value; },
    setIdentityVariants(value: any[]) { identityVariants = value; },
    setListingOffers(value: any[]) { currentListing.data.offers = value; },
    setListingMediaAssets(value: any[]) { currentListing.data.mediaAssets = value; }
  };
}
