import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import type {
  OzonListingDraft,
  OzonProductMapping,
  OzonPublishJob
} from '@n8n-media-review/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  OzonKnownPostPlatformMinPriceRecoveryChecks,
  OzonKnownPostPlatformMinPriceRecoveryInput,
  OzonRepository
} from '../../repositories/ozon.js';
import type { PurchaseRepository } from '../../repositories/purchases.js';
import {
  OzonPublishingService,
  normalizeKnownPostPlatformPricesRead,
  normalizeKnownPostPlatformRemoteProducts
} from './index.js';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OZON known post-platform min-price recovery service', () => {
  it('resolves 105 stale processing to the unique signed success directory and rechecks before commit', async () => {
    const fixture = await createFixture105();
    const productBefore = await readFile(fixture.productJsonPath, 'utf8');
    const recover = recoveryRepositoryMethod(fixture.job, fixture.listing, fixture.mappings);
    const repository = {
      getJob: vi.fn(async () => fixture.job),
      getSettings: vi.fn(async () => ({
        rootDirectory: fixture.root,
        adminApiWebhookUrl: 'http://n8n.test/webhook/ozon-admin',
        preflightWebhookUrl: 'http://n8n.test/webhook/ozon-preflight'
      })),
      listProductMappingsForSku: vi.fn(async () => fixture.mappings),
      recoverKnownPostPlatformMinPriceFailure: recover
    } as unknown as OzonRepository;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      if (body.action === 'productStatus') {
        return responseJson(presentProductStatus(fixture.job.offerIds, fixture.mappings));
      }
      if (body.action === 'preflight') {
        return responseJson(pricesReadPreflight(String(body.offerId), {
          price: 194.38,
          oldPrice: 388.76,
          minPrice: 0,
          currency: 'CNY',
          marketingSellerPrice: 155.5
        }));
      }
      return responseJson({ ok: false }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new OzonPublishingService(
      repository,
      {} as PurchaseRepository,
      { error: vi.fn() } as unknown as FastifyBaseLogger
    );
    const input = {
      reason: 'MIN_PRICE_WRITE_OMITTED_V1',
      rowVersion: 45,
      listingRowVersion: 12,
      dryRun: true
    } as const;

    const dryRun = await service.recoverKnownPostPlatformMinPriceFailure(fixture.job.id, input);
    expect(dryRun).toMatchObject({
      status: 'DRY_RUN',
      proposed: {
        jobState: 'IMPORTING',
        listingState: 'SUBMITTING',
        schedulerMode: 'RECONCILE_IMPORT',
        pendingPriceOfferIds: ['0000105-01'],
        preservedStockOfferIds: ['0000105-01'],
        workRelPath: 'success/2026-08-08/0000105__r2',
        directoryStage: 'SUCCESS'
      },
      checks: {
        productJson: {
          status: 'MATCHED',
          location: 'UNIQUE_ORPHAN_SUCCESS',
          resolvedWorkRelPath: 'success/2026-08-08/0000105__r2',
          resolvedDirectoryStage: 'SUCCESS'
        },
        remoteProducts: { status: 'MATCHED', requestedOfferIds: ['0000105-01'] },
        pricesRead: {
          status: 'ONLY_MIN_PRICE_MISSING',
          offers: [{
            offerId: '0000105-01',
            expected: { price: 194.38, oldPrice: 388.76, minPrice: 97.19, currency: 'CNY' },
            actual: { price: 194.38, oldPrice: 388.76, minPrice: 0, currency: 'CNY' }
          }]
        },
        routing: {
          resumeState: 'IMPORTING',
          schedulerMode: 'RECONCILE_IMPORT',
          importProductReachable: false
        }
      }
    });

    const applied = await service.recoverKnownPostPlatformMinPriceFailure(fixture.job.id, {
      ...input,
      dryRun: false
    });
    expect(applied).toMatchObject({
      status: 'RECOVERED',
      checks: {
        productJson: { location: 'UNIQUE_ORPHAN_SUCCESS' },
        pricesRead: { status: 'ONLY_MIN_PRICE_MISSING' },
        routing: { schedulerMode: 'RECONCILE_IMPORT', importProductReachable: false }
      }
    });
    expect(await readFile(fixture.productJsonPath, 'utf8')).toBe(productBefore);
    expect(recover).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).action)).toEqual([
      'productStatus', 'preflight',
      'productStatus', 'preflight',
      'productStatus', 'preflight'
    ]);
  });

  it('rejects zero or multiple orphan-success matches and product signature drift before remote readback', async () => {
    const missing = await createFixture105({ createSuccess: false });
    const duplicate = await createFixture105({ duplicateSuccess: true });
    const drifted = await createFixture105();
    await writeFile(drifted.productJsonPath, JSON.stringify({ productCode: '0000105', changed: true }));

    for (const fixture of [missing, duplicate, drifted]) {
      const repository = {
        getJob: vi.fn(async () => fixture.job),
        getSettings: vi.fn(async () => ({
          rootDirectory: fixture.root,
          adminApiWebhookUrl: 'http://n8n.test/webhook/ozon-admin',
          preflightWebhookUrl: 'http://n8n.test/webhook/ozon-preflight'
        })),
        listProductMappingsForSku: vi.fn(async () => fixture.mappings),
        recoverKnownPostPlatformMinPriceFailure: recoveryRepositoryMethod(
          fixture.job,
          fixture.listing,
          fixture.mappings
        )
      } as unknown as OzonRepository;
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const service = new OzonPublishingService(repository, {} as PurchaseRepository, {} as FastifyBaseLogger);

      await expect(service.recoverKnownPostPlatformMinPriceFailure(fixture.job.id, {
        reason: 'MIN_PRICE_WRITE_OMITTED_V1',
        rowVersion: 45,
        listingRowVersion: 12,
        dryRun: true
      })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });
});

describe('OZON known post-platform authoritative readback normalizers', () => {
  it('accepts all three 107 Offers when marketing_seller_price legitimately differs', () => {
    const offerIds = ['0000107-01', '0000107-02', '0000107-03'];
    const job = {
      id: '7c525f2c-a52c-475c-b8f5-a99ab61b348f',
      sku: '0000107',
      storeAlias: 'default',
      offerIds,
      ozonProductLinks: []
    } as OzonPublishJob;
    const remote = normalizeKnownPostPlatformRemoteProducts(job, [], presentProductStatus(offerIds));
    expect(remote).toMatchObject({
      status: 'MATCHED',
      requestedOfferIds: offerIds,
      mappings: offerIds.map((offerId, index) => ({
        offerId,
        ozonProductId: String(5_875_515_233 + index),
        ozonSku: String(5_396_887_670 + index)
      }))
    });

    const prices = normalizeKnownPostPlatformPricesRead('CNY', offerIds.map((offerId) => ({
      offer: { offerId, price: 201.6, oldPrice: 403.2, minPrice: 100.8 },
      response: pricesReadPreflight(offerId, {
        price: 201.6,
        oldPrice: 403.2,
        minPrice: 0,
        currency: 'CNY',
        marketingSellerPrice: 0
      })
    })));
    expect(prices.status).toBe('ONLY_MIN_PRICE_MISSING');
    expect(prices.offers.map((offer) => offer.offerId)).toEqual(offerIds);
  });

  it.each([
    ['base price drift', { price: 201.59, oldPrice: 403.2, minPrice: 0, currency: 'CNY' }],
    ['old price drift', { price: 201.6, oldPrice: 400, minPrice: 0, currency: 'CNY' }],
    ['minimum price no longer missing', { price: 201.6, oldPrice: 403.2, minPrice: 100.8, currency: 'CNY' }],
    ['currency drift', { price: 201.6, oldPrice: 403.2, minPrice: 0, currency: 'RUB' }]
  ])('rejects %s', (_label, actual) => {
    expect(() => normalizeKnownPostPlatformPricesRead('CNY', [{
      offer: { offerId: '0000107-01', price: 201.6, oldPrice: 403.2, minPrice: 100.8 },
      response: pricesReadPreflight('0000107-01', actual)
    }])).toThrow();
  });

  it('rejects non-unique or incomplete pricesRead shapes', () => {
    const offer = { offerId: '0000107-01', price: 201.6, oldPrice: 403.2, minPrice: 100.8 };
    expect(() => normalizeKnownPostPlatformPricesRead('CNY', [{
      offer,
      response: {
        ready: true,
        ok: true,
        httpStatus: 200,
        productPrices: { items: [], result: { items: [] } }
      }
    }])).toThrow();
    expect(() => normalizeKnownPostPlatformPricesRead('CNY', [{
      offer,
      response: pricesReadPreflight('0000107-02', {
        price: 201.6, oldPrice: 403.2, minPrice: 0, currency: 'CNY'
      })
    }])).toThrow();
  });
});

async function createFixture105(options: { createSuccess?: boolean; duplicateSuccess?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-min-price-'));
  roots.push(root);
  await mkdir(path.join(root, 'processing'), { recursive: true });
  await mkdir(path.join(root, 'success'), { recursive: true });
  const id = '50bff6f2-9801-4080-8183-2b37b4953d13';
  const sku = '0000105';
  const offerId = '0000105-01';
  const taskFolder = '0000105__r2';
  const product = {
    schemaVersion: 2,
    productCode: sku,
    revision: 2,
    currency: 'CNY',
    offers: [{ offerId, price: 194.38, oldPrice: 388.76, minPrice: 97.19 }]
  };
  const signature = `sha256:${createHash('sha256').update(JSON.stringify(product)).digest('hex')}`;
  const createDirectory = async (date: string) => {
    const directory = path.join(root, 'success', date, taskFolder);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'product.json'), JSON.stringify(product));
    await writeFile(path.join(directory, '.ozon-intake.json'), JSON.stringify({ jobId: id, sku, revision: 2, signature }));
    await writeFile(path.join(directory, '_READY'), JSON.stringify({ sku, revision: 2, signature }));
    return directory;
  };
  const directory = options.createSuccess === false
    ? path.join(root, 'success', '2026-08-08', taskFolder)
    : await createDirectory('2026-08-08');
  if (options.duplicateSuccess) await createDirectory('2026-08-07');
  const job = {
    id,
    sku,
    source: 'AUTO',
    state: 'NEEDS_ATTENTION',
    storeAlias: 'default',
    taskId: id,
    importTaskId: '5352371389',
    ozonProductId: '5874416999',
    offerIds: [offerId],
    ozonProductLinks: [{
      offerId,
      ozonProductId: '5874416999',
      ozonSku: '5395936600',
      url: 'https://www.ozon.ru/product/5395936600/'
    }],
    revision: 2,
    listingRevision: 2,
    taskFolder,
    directoryStage: 'PROCESSING',
    workRelPath: `processing/${taskFolder}`,
    directorySignature: signature,
    rowVersion: 45,
    retryCount: 3,
    stageStates: { import: 'SUCCESS', price: 'DIFFERENCE', stock: 'VERIFIED' },
    payload: {
      offerIds: [offerId],
      importTaskId: '5352371389',
      priceStockWriteProgress: {
        pricesWrite: { succeededOfferIds: [offerId], pendingOfferIds: [], failedOfferIds: [], errorsByOffer: {} },
        stocksWrite: { succeededOfferIds: [offerId], pendingOfferIds: [], failedOfferIds: [], errorsByOffer: {} }
      }
    },
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z'
  } as OzonPublishJob;
  const listing = {
    sku,
    status: 'NEEDS_ATTENTION',
    revision: 2,
    lastTaskId: id,
    rowVersion: 12,
    data: { offers: [{ offerId }] }
  } as OzonListingDraft;
  const mappings = [{
    storeAlias: 'default',
    sku,
    offerId,
    ozonProductId: '5874416999',
    ozonSku: '5395936600',
    lastAppliedRevision: 2
  }] as OzonProductMapping[];
  return {
    root,
    directory,
    productJsonPath: path.join(directory, 'product.json'),
    signature,
    job,
    listing,
    mappings
  };
}

function recoveryRepositoryMethod(
  job: OzonPublishJob,
  listing: OzonListingDraft,
  mappings: OzonProductMapping[]
) {
  return vi.fn(async (
    _id: string,
    input: OzonKnownPostPlatformMinPriceRecoveryInput,
    beforeCommit?: (locked: {
      job: OzonPublishJob;
      listing: OzonListingDraft;
      mappings: OzonProductMapping[];
    }) => Promise<OzonKnownPostPlatformMinPriceRecoveryChecks>
  ) => {
    const proposed = {
      jobState: 'IMPORTING' as const,
      listingState: 'SUBMITTING' as const,
      schedulerMode: 'RECONCILE_IMPORT' as const,
      pendingPriceOfferIds: [...job.offerIds],
      preservedStockOfferIds: [...job.offerIds],
      workRelPath: job.workRelPath || '',
      directoryStage: 'PROCESSING' as const
    };
    if (input.dryRun) {
      return {
        status: 'DRY_RUN' as const,
        reason: input.reason,
        dryRun: true,
        previous: { jobRowVersion: job.rowVersion, listingRowVersion: listing.rowVersion },
        proposed,
        job,
        listing
      };
    }
    if (!beforeCommit) throw new Error('beforeCommit required');
    const checks = await beforeCommit({ job, listing, mappings });
    return {
      status: 'RECOVERED' as const,
      reason: input.reason,
      dryRun: false,
      previous: { jobRowVersion: job.rowVersion, listingRowVersion: listing.rowVersion },
      proposed: {
        ...proposed,
        workRelPath: checks.productJson.resolvedWorkRelPath,
        directoryStage: checks.productJson.resolvedDirectoryStage
      },
      checks,
      job,
      listing
    };
  });
}

function presentProductStatus(
  offerIds: string[],
  persistedMappings: OzonProductMapping[] = []
): Record<string, unknown> {
  const infoItems = offerIds.map((offerId, index) => ({
    offer_id: offerId,
    id: persistedMappings.find((mapping) => mapping.offerId === offerId)?.ozonProductId
      || String(5_875_515_233 + index),
    sku: persistedMappings.find((mapping) => mapping.offerId === offerId)?.ozonSku
      || String(5_396_887_670 + index),
    is_archived: false
  }));
  return {
    ok: true,
    httpStatus: 200,
    result: {
      contractVersion: 2,
      requestedOfferIds: offerIds,
      readAt: '2026-08-08T15:30:00.000Z',
      infoItems,
      attributeItems: offerIds.map((offerId) => ({ offer_id: offerId })),
      operations: [
        {
          operation: 'infoList', ok: true, statusCode: 200,
          outcome: 'PRESENT', resultShape: 'ARRAY', itemCount: offerIds.length
        },
        {
          operation: 'attributesInfo', ok: true, statusCode: 200,
          outcome: 'PRESENT', resultShape: 'ARRAY', itemCount: offerIds.length
        }
      ]
    }
  };
}

function pricesReadPreflight(
  offerId: string,
  actual: {
    price: number;
    oldPrice: number | null;
    minPrice: number;
    currency: string;
    marketingSellerPrice?: number;
  }
): Record<string, unknown> {
  return {
    ready: true,
    ok: true,
    httpStatus: 200,
    productPrices: {
      items: [{
        offer_id: offerId,
        price: {
          price: actual.price,
          old_price: actual.oldPrice,
          min_price: actual.minPrice,
          currency_code: actual.currency,
          ...(actual.marketingSellerPrice !== undefined
            ? { marketing_seller_price: actual.marketingSellerPrice }
            : {})
        }
      }],
      total: 1
    }
  };
}

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
