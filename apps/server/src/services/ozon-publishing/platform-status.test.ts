import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { OzonListingDraft, OzonProductMapping, OzonPublishJob } from '@n8n-media-review/shared';
import type { OzonPlatformStatusRefreshLease, OzonRepository } from '../../repositories/ozon.js';
import type { PurchaseRepository } from '../../repositories/purchases.js';
import {
  normalizeOzonKnownRecoveryRemoteAbsence,
  normalizeOzonPlatformStatusRefresh,
  OzonPublishingService
} from './index.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function listing(): OzonListingDraft {
  return {
    sku: '0000090',
    productName: '状态对账测试',
    status: 'MODERATING',
    rowVersion: 8,
    revision: 4,
    data: {
      fulfillmentMode: 'FBS', warehouseId: '10001', currency: 'CNY', vat: '0.2', titleRu: '', descriptionRu: '',
      descriptionWarnings: [], brand: '', sharedAttributes: [], mediaAssets: [], mediaSourceRoot: '', videoUploadMode: 'COMPRESSED_COPY',
      offers: ['01', '02'].map((variantCode) => ({
        variantId: `00000000-0000-4000-8000-0000000000${variantCode}`,
        variantCode,
        offerId: `0000090-${variantCode}`,
        modelGroup: '0000090',
        barcode: '', price: 100, oldPrice: 120, minPrice: 90, stock: 1,
        descriptionWarnings: [], attributes: [],
        media: [
          { assetId: `image-${variantCode}`, relativePath: `variants/${variantCode}.jpg`, kind: 'image', sortOrder: 0, isPrimary: true },
          { assetId: 'video-shared', relativePath: 'variants/video.mp4', kind: 'video', sortOrder: 1, isPrimary: false }
        ]
      }))
    },
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z'
  };
}

function mapping(offerId: string, statusSnapshot: Record<string, unknown> = {}): OzonProductMapping {
  return {
    storeAlias: 'default', offerId, sku: '0000090', ozonProductId: offerId.endsWith('01') ? '501' : '502',
    ozonSku: offerId.endsWith('01') ? '9001' : '9002', lastAppliedRevision: 4, status: 'ON_SALE',
    statusSnapshot, updatedAt: '2026-08-06T00:00:00.000Z'
  };
}

function lease(overrides: Partial<OzonPlatformStatusRefreshLease> = {}): OzonPlatformStatusRefreshLease {
  const draft = listing();
  return {
    leaseToken: '00000000-0000-4000-8000-000000000090',
    leaseExpiresAt: '2026-08-06T01:00:00.000Z',
    listing: draft,
    storeAlias: 'default',
    offerIds: draft.data.offers.map((offer) => offer.offerId),
    mappings: draft.data.offers.map((offer) => mapping(offer.offerId)),
    ...overrides
  };
}

function approvedInfo(offerId: string, stock: number) {
  return {
    offer_id: offerId,
    id: offerId.endsWith('01') ? 501 : 502,
    sku: offerId.endsWith('01') ? 9001 : 9002,
    is_created: true,
    price: '100',
    statuses: {
      status_name: stock > 0 ? 'Продается' : 'Нет в наличии',
      status_description: stock > 0 ? 'Готов к продаже' : 'Нет в наличии',
      moderate_status: 'approved',
      validation_status: 'success'
    },
    stocks: { stocks: [{ present: stock }] },
    images: [`https://example.test/${offerId}.jpg`]
  };
}

function attributes(offerId: string) {
  return {
    offer_id: offerId,
    complex_attributes: [{ complex_id: 100002, attributes: [{ id: 21845, complex_id: 100002, values: [{ value: 'https://example.test/video.mp4' }] }] }]
  };
}

describe('OZON platform status normalization', () => {
  it('treats approved out-of-stock offers as published and fully replaces stage state values', () => {
    const result = normalizeOzonPlatformStatusRefresh(lease(), {
      ok: true,
      result: {
        readAt: '2026-08-06T00:30:00.000Z',
        infoItems: [approvedInfo('0000090-02', 0), approvedInfo('0000090-01', 2)],
        attributeItems: [attributes('0000090-01'), attributes('0000090-02')],
        operations: [{ operation: 'infoList', ok: true }, { operation: 'attributesInfo', ok: true }]
      }
    });

    expect(result.businessState).toBe('PUBLISHED');
    expect(result.offers.map((offer) => [offer.offerId, offer.displayState])).toEqual([
      ['0000090-01', 'ON_SALE'],
      ['0000090-02', 'OUT_OF_STOCK']
    ]);
    expect(result.stageStates).toEqual({
      import: 'SUCCESS', moderation: 'SUCCESS', images: 'VERIFIED', video: 'VERIFIED',
      productVideo: 'VERIFIED', videoCover: 'VERIFIED', price: 'VERIFIED', stock: 'OUT_OF_STOCK'
    });
  });

  it('keeps media differences as warnings without downgrading an approved product', () => {
    const result = normalizeOzonPlatformStatusRefresh(lease(), {
      infoItems: [approvedInfo('0000090-01', 1), approvedInfo('0000090-02', 1)],
      attributeItems: [],
      readAt: '2026-08-06T00:30:00.000Z'
    });

    expect(result.businessState).toBe('PUBLISHED');
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('视频封面属性（仅告警）')
    ]));
    expect(result.stageStates.video).toBe('DIFFERENCE');
  });

  it('requires two consecutive successful missing reads before marking an offer NOT_FOUND', () => {
    const previous = mapping('0000090-02', {
      displayState: 'ON_SALE', businessState: 'PUBLISHED', missingConfirmationCount: 0
    });
    const first = normalizeOzonPlatformStatusRefresh(lease({ mappings: [mapping('0000090-01'), previous] }), {
      ok: true,
      result: { infoItems: [approvedInfo('0000090-01', 1)], attributeItems: [attributes('0000090-01')] }
    });
    const firstMissing = first.offers.find((offer) => offer.offerId === '0000090-02')!;
    expect(firstMissing).toMatchObject({ displayState: 'ON_SALE', businessState: 'PUBLISHED', confirmed: false, missingConfirmationCount: 1 });

    const second = normalizeOzonPlatformStatusRefresh(lease({
      mappings: [mapping('0000090-01'), mapping('0000090-02', firstMissing)]
    }), {
      ok: true,
      result: { infoItems: [approvedInfo('0000090-01', 1)], attributeItems: [attributes('0000090-01')] }
    });
    expect(second.offers.find((offer) => offer.offerId === '0000090-02')).toMatchObject({
      displayState: 'NOT_FOUND', businessState: 'NEEDS_ATTENTION', confirmed: true, missingConfirmationCount: 2
    });
    expect(second.businessState).toBe('NEEDS_ATTENTION');
  });

  it('rejects an explicit failed P003 operation instead of interpreting it as missing products', () => {
    expect(() => normalizeOzonPlatformStatusRefresh(lease(), {
      ok: false,
      httpStatus: 429,
      message: 'rate limited',
      operations: [{ operation: 'infoList', ok: false, statusCode: 429 }]
    })).toThrow(expect.objectContaining({ code: 'OZON_PLATFORM_STATUS_REFRESH_FAILED', statusCode: 429 }));
  });

  it('keeps hidden status ahead of generic errors and reads object-shaped prices', () => {
    const hidden = {
      ...approvedInfo('0000090-01', 1),
      price: { price: '100', marketing_price: '95' },
      is_hidden: true,
      errors: [{ code: 'GENERIC_ERROR', message: 'hidden item error' }]
    };
    const result = normalizeOzonPlatformStatusRefresh(lease(), {
      ok: true,
      result: {
        infoItems: [hidden, approvedInfo('0000090-02', 1)],
        attributeItems: [attributes('0000090-01'), attributes('0000090-02')]
      }
    });
    expect(result.offers[0]).toMatchObject({ displayState: 'HIDDEN', businessState: 'NEEDS_ATTENTION', hasPrice: true });
    expect(result.businessState).toBe('NEEDS_ATTENTION');
  });

  it('classifies an approved OZON not-for-sale response as a hidden business outcome', () => {
    const notForSale = {
      ...approvedInfo('0000090-01', 1),
      statuses: {
        status_name: 'Не продается',
        status_description: 'Не продается',
        moderate_status: 'approved',
        validation_status: 'success'
      }
    };
    const result = normalizeOzonPlatformStatusRefresh(lease({ offerIds: ['0000090-01'] }), {
      ok: true,
      result: { infoItems: [notForSale], attributeItems: [attributes('0000090-01')] }
    });
    expect(result.offers[0]).toMatchObject({
      displayState: 'NOT_FOR_SALE', businessState: 'NEEDS_ATTENTION', visible: false
    });
    expect(result.businessState).toBe('NEEDS_ATTENTION');
  });

  it('keeps an archived Offer and an in-stock on-sale Offer as separate readback evidence', () => {
    const archived = {
      ...approvedInfo('0000090-01', 0),
      is_archived: true,
      statuses: {
        status_name: 'Архив',
        status_description: 'Убран из продажи',
        moderate_status: 'approved',
        validation_status: 'success'
      }
    };
    const result = normalizeOzonPlatformStatusRefresh(lease(), {
      ok: true,
      result: {
        infoItems: [archived, approvedInfo('0000090-02', 1)],
        attributeItems: [attributes('0000090-01'), attributes('0000090-02')]
      }
    });
    expect(result.offers.map((offer) => [offer.offerId, offer.displayState, offer.hasStock])).toEqual([
      ['0000090-01', 'ARCHIVED', false],
      ['0000090-02', 'ON_SALE', true]
    ]);
    expect(result.businessState).toBe('NEEDS_ATTENTION');
  });
});

describe('OZON known pre-platform recovery remote absence proof', () => {
  it('accepts and preserves a complete v2 200/200 empty proof', () => {
    const response = productStatusV2Response(['0000105-01', '0000105-02']);
    expect(normalizeOzonKnownRecoveryRemoteAbsence(['0000105-01', '0000105-02'], response)).toEqual({
      status: 'CONFIRMED_EMPTY',
      offerIds: ['0000105-01', '0000105-02'],
      checkedAt: '2026-08-08T00:30:00.000Z',
      infoItemCount: 0,
      attributeItemCount: 0,
      contractVersion: 2,
      requestedOfferIds: ['0000105-01', '0000105-02'],
      operations: response.result.operations,
      absenceEvidence: response.result.absenceEvidence
    });
  });

  it('accepts only the exact attributesInfo HTTP 404 code 5 special empty proof', () => {
    const response = productStatusV2Response(['0000105-01'], { attributesNotFound: true });
    expect(normalizeOzonKnownRecoveryRemoteAbsence(['0000105-01'], response)).toMatchObject({
      status: 'CONFIRMED_EMPTY',
      contractVersion: 2,
      operations: [
        { operation: 'infoList', statusCode: 200, outcome: 'EMPTY', resultShape: 'ARRAY' },
        {
          operation: 'attributesInfo', upstreamOk: false, statusCode: 404, outcome: 'NOT_FOUND',
          resultShape: 'NOT_FOUND_ERROR', errorCode: '5'
        }
      ],
      absenceEvidence: { method: 'INFO_EMPTY_ATTRIBUTES_NOT_FOUND' }
    });
  });

  it('classifies valid v2 product evidence as present', () => {
    const variants = [
      { infoItems: [{ offer_id: '0000105-01', id: 501, status: 'PUBLISHED' }], attributeItems: [] },
      { infoItems: [{ offer_id: '0000105-01', confirmed: true, status: 'NOT_FOUND' }], attributeItems: [] },
      { infoItems: [{ offer_id: '0000105-01', ozon_sku: 9001, status: 'NOT_FOUND' }], attributeItems: [] },
      { infoItems: [{ offer_id: '0000105-01', status: 'MODERATING' }], attributeItems: [] },
      { infoItems: [], attributeItems: [{ offer_id: '0000105-01', attributes: [] }] }
    ];
    for (const variant of variants) {
      const response = productStatusV2Response(['0000105-01'], variant);
      expect(() => normalizeOzonKnownRecoveryRemoteAbsence(['0000105-01'], response))
        .toThrow(expect.objectContaining({ code: 'OZON_REMOTE_STATE_PRESENT' }));
    }
  });

  it('rejects legacy, mismatched, incomplete, or non-object v2 results as unproven', () => {
    const base = productStatusV2Response(['0000105-01']);
    const invalidResponses: Record<string, unknown>[] = [
      { ...base, httpStatus: 502 },
      { ...base, result: { ...base.result, contractVersion: 1 } },
      { ...base, result: { ...base.result, requestedOfferIds: ['0000106-01'] } },
      { ...base, result: { ...base.result, requestedOfferIds: ['0000105-01', '0000105-01'] } },
      { ...base, result: { ...base.result, attributeItems: undefined } },
      { ...base, result: { ...base.result, infoItems: ['not-an-object'] } },
      { ...base, result: { ...base.result, operations: [base.result.operations[0]] } },
      {
        ...base,
        result: {
          ...base.result,
          operations: [base.result.operations[0], { ...base.result.operations[0] }]
        }
      },
      {
        ...base,
        result: {
          ...base.result,
          operations: base.result.operations.map((entry) => entry.operation === 'infoList'
            ? { ...entry, requestId: 'productStatus:wrong' }
            : entry)
        }
      },
      {
        ...base,
        result: {
          ...base.result,
          operations: base.result.operations.map((entry) => entry.operation === 'attributesInfo'
            ? { ...entry, itemCount: 1 }
            : entry)
        }
      },
      { ...base, result: { ...base.result, absenceEvidence: undefined } },
      {
        ...base,
        result: {
          ...base.result,
          absenceEvidence: {
            ...base.result.absenceEvidence,
            infoList: { statusCode: 200, resultShape: 'ARRAY', itemCount: 1 }
          }
        }
      }
    ];
    for (const response of invalidResponses) {
      expect(() => normalizeOzonKnownRecoveryRemoteAbsence(['0000105-01'], response))
        .toThrow(expect.objectContaining({ code: 'OZON_REMOTE_STATE_UNPROVEN' }));
    }
  });

  it('rejects every near-miss of the HTTP 404 code 5 exception', () => {
    const base = productStatusV2Response(['0000105-01'], { attributesNotFound: true });
    const invalidOperations = [
      { upstreamOk: true },
      { statusCode: 400 },
      { outcome: 'EMPTY' },
      { resultShape: 'ARRAY' },
      { itemCount: 1 },
      { errorCode: '404' }
    ];
    for (const patch of invalidOperations) {
      const response = {
        ...base,
        result: {
          ...base.result,
          operations: base.result.operations.map((entry) => entry.operation === 'attributesInfo'
            ? { ...entry, ...patch }
            : entry)
        }
      };
      expect(() => normalizeOzonKnownRecoveryRemoteAbsence(['0000105-01'], response))
        .toThrow(expect.objectContaining({ code: 'OZON_REMOTE_STATE_UNPROVEN' }));
    }
  });

  it('does not treat a non-empty explicit NOT_FOUND row as v2 empty evidence', () => {
    const response = productStatusV2Response(['0000105-01'], {
      infoItems: [{ offer_id: '0000105-01', status: 'NOT_FOUND' }]
    });
    expect(() => normalizeOzonKnownRecoveryRemoteAbsence(['0000105-01'], response))
      .toThrow(expect.objectContaining({ code: 'OZON_REMOTE_STATE_UNPROVEN' }));
  });
});

function productStatusV2Response(
  requestedOfferIds: string[],
  input: {
    infoItems?: Record<string, unknown>[];
    attributeItems?: Record<string, unknown>[];
    attributesNotFound?: boolean;
  } = {}
) {
  const infoItems = input.infoItems || [];
  const attributeItems = input.attributeItems || [];
  const attributesNotFound = input.attributesNotFound === true;
  const infoList = {
    operation: 'infoList', requestId: 'productStatus:infoList', ok: true, upstreamOk: true, statusCode: 200,
    outcome: infoItems.length ? 'PRESENT' : 'EMPTY', resultShape: 'ARRAY', itemCount: infoItems.length
  };
  const attributesInfo = attributesNotFound
    ? {
        operation: 'attributesInfo', requestId: 'productStatus:attributesInfo', ok: true, upstreamOk: false,
        statusCode: 404, outcome: 'NOT_FOUND', resultShape: 'NOT_FOUND_ERROR', itemCount: 0, errorCode: '5'
      }
    : {
        operation: 'attributesInfo', requestId: 'productStatus:attributesInfo', ok: true, upstreamOk: true,
        statusCode: 200, outcome: attributeItems.length ? 'PRESENT' : 'EMPTY', resultShape: 'ARRAY',
        itemCount: attributeItems.length
      };
  const allEmpty = infoItems.length === 0 && attributeItems.length === 0;
  const absenceEvidence = !allEmpty ? undefined : attributesNotFound
    ? {
        method: 'INFO_EMPTY_ATTRIBUTES_NOT_FOUND',
        infoList: { statusCode: 200, resultShape: 'ARRAY', itemCount: 0 },
        attributesInfo: { statusCode: 404, resultShape: 'NOT_FOUND_ERROR', itemCount: 0, errorCode: '5' }
      }
    : {
        method: 'BOTH_ARRAYS_EMPTY',
        infoList: { statusCode: 200, resultShape: 'ARRAY', itemCount: 0 },
        attributesInfo: { statusCode: 200, resultShape: 'ARRAY', itemCount: 0 }
      };
  return {
    ok: true,
    httpStatus: 200,
    result: {
      contractVersion: 2,
      requestedOfferIds,
      readAt: '2026-08-08T00:30:00.000Z',
      infoItems,
      attributeItems,
      operations: [infoList, attributesInfo],
      ...(absenceEvidence ? { absenceEvidence } : {})
    }
  };
}

describe('OZON platform status refresh service', () => {
  it('uses only action and offerIds, but leaves an active remote job for strict P002 verification', async () => {
    const currentLease = lease({
      job: {
        id: '00000000-0000-4000-8000-000000000091', sku: '0000090', offerIds: ['0000090-01', '0000090-02'],
        storeAlias: 'default', state: 'MODERATING', source: 'MANUAL', importTaskId: '528090', ozonProductLinks: [],
        stageStates: { import: 'SUCCESS', moderation: 'RUNNING', images: 'PENDING', video: 'PENDING', price: 'PENDING', stock: 'PENDING' },
        retryCount: 0, rowVersion: 5, createdAt: '2026-08-06T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z'
      } as OzonPublishJob
    });
    const commit = vi.fn(async (_sku, input) => ({
      listing: { ...currentLease.listing, status: input.businessState },
      job: { ...currentLease.job!, state: input.jobState || currentLease.job!.state },
      mappings: currentLease.mappings,
      changed: true
    }));
    const repository = {
      getSettings: vi.fn(async () => ({ adminApiWebhookUrl: 'http://n8n.test/webhook/admin', defaultStoreAlias: 'default' })),
      acquirePlatformStatusRefresh: vi.fn(async () => currentLease),
      renewPlatformStatusRefresh: vi.fn(async () => '2026-08-06T01:00:00.000Z'),
      commitPlatformStatusRefresh: commit,
      failPlatformStatusRefresh: vi.fn(async () => true)
    } as unknown as OzonRepository;
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      ok: true,
      result: {
        infoItems: [approvedInfo('0000090-02', 0), approvedInfo('0000090-01', 1)],
        attributeItems: [attributes('0000090-01'), attributes('0000090-02')],
        readAt: '2026-08-06T00:30:00.000Z'
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, { error: vi.fn() } as unknown as FastifyBaseLogger);

    const result = await service.refreshPlatformStatus('0000090', 8);

    expect(result.businessState).toBe('PUBLISHED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({
      action: 'productStatus', offerIds: ['0000090-01', '0000090-02']
    });
    expect(commit).toHaveBeenCalledWith('0000090', expect.objectContaining({
      jobState: 'MODERATING',
      stageStates: currentLease.job!.stageStates,
      warnings: expect.arrayContaining(['活动任务仍需通过 P002 逐 Offer 最终验收，平台状态刷新未改变任务阶段'])
    }));
    expect(result.job?.state).toBe('MODERATING');
  });

  it('preserves old state and releases the lease when P003 fails', async () => {
    const currentLease = lease();
    const fail = vi.fn(async () => true);
    const commit = vi.fn();
    const repository = {
      getSettings: vi.fn(async () => ({ adminApiWebhookUrl: 'http://n8n.test/webhook/admin', defaultStoreAlias: 'default' })),
      acquirePlatformStatusRefresh: vi.fn(async () => currentLease),
      renewPlatformStatusRefresh: vi.fn(),
      commitPlatformStatusRefresh: commit,
      failPlatformStatusRefresh: fail
    } as unknown as OzonRepository;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, message: 'rate limited' }), {
      status: 429, headers: { 'Content-Type': 'application/json' }
    })));
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, { error: vi.fn() } as unknown as FastifyBaseLogger);

    await expect(service.refreshPlatformStatus('0000090', 8)).rejects.toMatchObject({
      code: 'OZON_PLATFORM_STATUS_REFRESH_FAILED', statusCode: 502
    });
    expect(commit).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith('0000090', currentLease.leaseToken, expect.objectContaining({
      code: 'OZON_PLATFORM_STATUS_REFRESH_FAILED'
    }));
  });

  it('rejects a bound store mismatch before making a P003 request', async () => {
    const currentLease = lease({ storeAlias: 'archived-store' });
    const fail = vi.fn(async () => true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const repository = {
      getSettings: vi.fn(async () => ({ adminApiWebhookUrl: 'http://n8n.test/webhook/admin', defaultStoreAlias: 'default' })),
      acquirePlatformStatusRefresh: vi.fn(async () => currentLease),
      failPlatformStatusRefresh: fail
    } as unknown as OzonRepository;
    const service = new OzonPublishingService(repository, {} as PurchaseRepository, { error: vi.fn() } as unknown as FastifyBaseLogger);

    await expect(service.refreshPlatformStatus('0000090', 8)).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledTimes(1);
  });
});
