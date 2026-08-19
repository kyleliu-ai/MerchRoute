import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertOzonRfbsStockNormalizationAttestation,
  normalizeOzonRfbsStockMismatchCallback,
  OZON_P002_RFBS_NORMALIZATION_WORKFLOW_ID,
  OZON_RFBS_STOCK_READBACK_NORMALIZED_EVENT
} from './rfbs-stock-callback.js';

const NOW = new Date('2026-08-09T11:20:00.000Z');
const ARCHIVE_ASSERT_NOW = new Date('2026-08-09T11:20:02.000Z');
const VIDEO_CACHE_CLEANED_AT = '2026-08-09T11:20:01.000Z';
const OFFER_IDS = ['0000105-01', '0000105-02', '0000105-03'];
const PRODUCT_IDS = ['5874416999', '5884077033', '5884077037'];
const OZON_SKUS = ['5395936600', '5404205974', '5404205495'];

describe('OZON P002 RFBS aggregate stock evidence', () => {
  it('normalizes only an exact stock-only mismatch backed by the bound raw stocksRead response', () => {
    const fixture = createFixture();
    const normalized = normalizeOzonRfbsStockMismatchCallback(
      fixture.authority,
      fixture.input,
      fixture.execution,
      NOW
    );
    expect(normalized).toMatchObject({
      state: 'SUCCEEDED',
      eventType: OZON_RFBS_STOCK_READBACK_NORMALIZED_EVENT,
      errorCode: undefined,
      stageStates: { stock: 'VERIFIED' },
      offerIds: OFFER_IDS
    });
    expect(normalized?.jobPayload?.finalConsistencyRecovery).toMatchObject({
      phase: 'VERIFIED',
      affectedOffers: []
    });
    expect(normalized?.rfbsStockReadbackAttestation?.offers).toEqual(OFFER_IDS.map((offerId, index) => ({
      offerId,
      ozonProductId: PRODUCT_IDS[index],
      ozonSku: OZON_SKUS[index],
      stock: 1
    })));
    expect(normalized?.productMappings?.map((mapping) => mapping.statusSnapshot?.warnings)).toEqual([
      [], [], []
    ]);
    const archived = archivedNormalizedInput(fixture, normalized!);
    expect(() => assertOzonRfbsStockNormalizationAttestation(
      fixture.authority,
      archived,
      ARCHIVE_ASSERT_NOW
    )).not.toThrow();
  });

  it('rejects a stock row that carries a concrete warehouse identity', () => {
    const fixture = createFixture();
    const stockResponse = responseItems(fixture.execution).find((entry) => entry.operation === 'stocksRead')!;
    stockResponse.body.items[0].stocks[0].warehouse_id = '1020002456503000';
    expect(normalizeOzonRfbsStockMismatchCallback(
      fixture.authority,
      fixture.input,
      fixture.execution,
      NOW
    )).toBeUndefined();
  });

  it('rejects forged callback snapshots when the same execution has no raw stocksRead response', () => {
    const fixture = createFixture();
    const runData = fixture.execution.data.resultData.runData;
    runData['调用 OZON-A001 最终读回'][0].data.main[0] = runData['调用 OZON-A001 最终读回'][0].data.main[0]
      .filter((item: any) => item.json.operation !== 'stocksRead');
    expect(normalizeOzonRfbsStockMismatchCallback(
      fixture.authority,
      fixture.input,
      fixture.execution,
      NOW
    )).toBeUndefined();
  });

  it('rejects mixed price and stock differences even with valid RFBS stock evidence', () => {
    const fixture = createFixture();
    fixture.input.jobPayload.finalConsistencyRecovery.affectedOffers[0].differences.price = {
      expected: 194.38,
      actual: 0
    };
    expect(normalizeOzonRfbsStockMismatchCallback(
      fixture.authority,
      fixture.input,
      fixture.execution,
      NOW
    )).toBeUndefined();
  });

  it('removes string and object stock warnings while preserving unrelated warnings unchanged', () => {
    const fixture = createFixture();
    const unrelatedObject = { code: 'OZON_PRICE_NOTICE', detail: 'keep-object' };
    fixture.input.productMappings[0].statusSnapshot.warnings = [
      'OZON_STOCK_DIFFERENCE：0000105-01',
      'OZON_MEDIA_NOTICE：keep-string',
      { code: 'OZON_STOCK_DIFFERENCE_DETAIL', detail: 'remove-object' },
      unrelatedObject
    ];
    const normalized = normalizeOzonRfbsStockMismatchCallback(
      fixture.authority,
      fixture.input,
      fixture.execution,
      NOW
    );
    expect(normalized?.productMappings?.[0]?.statusSnapshot?.warnings).toEqual([
      'OZON_MEDIA_NOTICE：keep-string',
      unrelatedObject
    ]);
  });

  it('rejects a normalized event that has no internal readback attestation', () => {
    const fixture = createFixture();
    expect(() => assertOzonRfbsStockNormalizationAttestation(
      fixture.authority,
      {
        ...fixture.input,
        state: 'SUCCEEDED',
        eventType: OZON_RFBS_STOCK_READBACK_NORMALIZED_EVENT,
        rfbsStockReadbackAttestation: undefined
      },
      NOW
    )).toThrow('OZON_RFBS_STOCK_READBACK_ATTESTATION_INVALID');
  });

  it('accepts an idempotent prior-success directory date within the authority lifetime', () => {
    const fixture = createFixture();
    fixture.authority.job.createdAt = '2026-08-08T10:24:57.197Z';
    const normalized = normalizeOzonRfbsStockMismatchCallback(
      fixture.authority,
      fixture.input,
      fixture.execution,
      NOW
    )!;
    const archived = archivedNormalizedInput(fixture, normalized);
    archived.workRelPath = 'success/2026-08-08/0000105__r4';
    archived.jobPayload.workRelPath = archived.workRelPath;
    expect(() => assertOzonRfbsStockNormalizationAttestation(
      fixture.authority,
      archived,
      ARCHIVE_ASSERT_NOW
    )).not.toThrow();
  });

  it.each([
    ['top-level revision', (input: any) => { input.revision = 5; }],
    ['top-level task folder', (input: any) => { input.taskFolder = '0000105__r5'; }],
    ['top-level signature', (input: any) => { input.directorySignature = `sha256:${'b'.repeat(64)}`; }],
    ['top-level directory stage', (input: any) => { input.directoryStage = 'PROCESSING'; }],
    ['top-level wrong success folder', (input: any) => { input.workRelPath = 'success/2026-08-09/0000105__r5'; }],
    ['top-level non-calendar date', (input: any) => { input.workRelPath = 'success/2026-02-30/0000105__r4'; }],
    ['top-level pre-creation date', (input: any) => { input.workRelPath = 'success/2026-08-08/0000105__r4'; }],
    ['top-level post-check date', (input: any) => { input.workRelPath = 'success/2026-08-10/0000105__r4'; }],
    ['top-level non-portable path', (input: any) => { input.workRelPath = 'success\\2026-08-09\\0000105__r4'; }],
    ['job payload revision', (input: any) => { input.jobPayload.revision = 5; }],
    ['job payload task folder', (input: any) => { input.jobPayload.taskFolder = '0000105__r5'; }],
    ['job payload work path', (input: any) => { input.jobPayload.workRelPath = 'success/2026-08-09/0000105__r5'; }],
    ['job payload directory stage', (input: any) => { input.jobPayload.directoryStage = 'PROCESSING'; }],
    ['job payload signature', (input: any) => { input.jobPayload.directorySignature = `sha256:${'b'.repeat(64)}`; }],
    ['non-canonical cache-clean timestamp', (input: any) => { input.jobPayload.videoCacheCleanedAt = '2026-08-09T11:20:01+00:00'; }],
    ['cache-clean timestamp before tolerance', (input: any) => { input.jobPayload.videoCacheCleanedAt = '2026-08-09T11:19:54.000Z'; }],
    ['cache-clean timestamp too far in the future', (input: any) => { input.jobPayload.videoCacheCleanedAt = '2026-08-09T11:20:08.000Z'; }],
    ['top-level cache-clean timestamp', (input: any) => { input.videoCacheCleanedAt = VIDEO_CACHE_CLEANED_AT; }],
    ['unrelated normalized field', (input: any) => { input.message = 'forged success'; }],
    ['unapproved job payload field', (input: any) => { input.jobPayload.unapproved = true; }]
  ])('rejects archived normalized input with tampered %s', (_label, mutate) => {
    const fixture = createFixture();
    const normalized = normalizeOzonRfbsStockMismatchCallback(
      fixture.authority,
      fixture.input,
      fixture.execution,
      NOW
    )!;
    const archived = archivedNormalizedInput(fixture, normalized);
    mutate(archived);
    expect(() => assertOzonRfbsStockNormalizationAttestation(
      fixture.authority,
      archived,
      ARCHIVE_ASSERT_NOW
    )).toThrow('OZON_RFBS_STOCK_READBACK_NORMALIZATION_DRIFT');
  });

  it.each([
    ['current state', (request: any) => { request.currentState = 'SUCCEEDED'; }],
    ['import task', (request: any) => { request.importTaskId = 'other-import-task'; }],
    ['job payload revision', (request: any) => { request.jobPayload.revision = 5; }],
    ['directory stage', (request: any) => { request.directoryStage = 'SUCCESS'; }],
    ['work path', (request: any) => { request.workRelPath = 'processing/other'; }],
    ['task folder', (request: any) => { request.taskFolder = '0000105__r5'; }],
    ['directory signature', (request: any) => { request.directorySignature = `sha256:${'b'.repeat(64)}`; }],
    ['top-level contract', (request: any) => { request.publishOfferIds = ['0000105-02']; }]
  ])('rejects a prepared request with drifted %s binding', (_label, mutate) => {
    const fixture = createFixture();
    const request = preparedItems(fixture.execution)[0]!;
    mutate(request);
    expect(normalizeOzonRfbsStockMismatchCallback(
      fixture.authority,
      fixture.input,
      fixture.execution,
      NOW
    )).toBeUndefined();
  });
});

function createFixture(): any {
  const expectedOfferSnapshots = OFFER_IDS.map((offerId, index) => ({
    offerId,
    productVariantId: `variant-${index + 1}`,
    disposition: index === 0 ? 'PRESERVED_EXISTING' : 'SUBMITTED',
    price: 194.38,
    oldPrice: 388.76,
    minPrice: 97.19,
    stock: 1,
    descriptionRu: `description-${offerId}`,
    media: { imageCount: 7, videoCount: 1 },
    ...(index === 0 ? { mapping: { ozonProductId: PRODUCT_IDS[0], ozonSku: OZON_SKUS[0] } } : {})
  }));
  const contractBody = {
    offerContractVersion: 1,
    expectedOfferIds: OFFER_IDS,
    submittedOfferIds: OFFER_IDS.slice(1),
    publishOfferIds: OFFER_IDS.slice(1),
    expectedOfferSnapshots
  };
  const offerContractHash = `sha256:${createHash('sha256').update(stableJson(contractBody)).digest('hex')}`;
  const payload = {
    offerIds: OFFER_IDS,
    revision: 4,
    storeAlias: 'default',
    warehouseId: '1020002456503000',
    importTaskId: '5358968564',
    materialSnapshot: { store: { fulfillmentMode: 'RFBS' } },
    ...contractBody,
    offerContractHash
  };
  const statusSnapshots = OFFER_IDS.map((offerId) => ({
    displayState: 'ON_SALE',
    businessState: 'PUBLISHED',
    hasStock: true,
    stockPresent: 1,
    readAt: '2026-08-09T11:19:48.333Z',
    warnings: [`OZON_STOCK_DIFFERENCE：${offerId}`]
  }));
  const mappings = OFFER_IDS.map((offerId, index) => ({
    storeAlias: 'default',
    offerId,
    sku: '0000105',
    ozonProductId: PRODUCT_IDS[index],
    ozonSku: OZON_SKUS[index],
    lastAppliedRevision: 4,
    status: 'ON_SALE',
    statusSnapshot: statusSnapshots[index],
    updatedAt: '2026-08-09T11:19:48.333Z'
  }));
  const input = {
    rowVersion: 27,
    state: 'NEEDS_ATTENTION',
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
      warnings: OFFER_IDS.map((offerId) => ({
        code: 'OZON_STOCK_DIFFERENCE', offerId, expected: 1, actual: 0
      })),
      verifiedOfferIds: OFFER_IDS,
      readAt: '2026-08-09T11:19:48.333Z',
      descriptionVerificationByOffer: OFFER_IDS.map((offerId) => ({
        offerId, present: true, matches: true
      }))
    },
    jobPayload: {
      imageRecovery: {
        phase: 'VERIFIED', affectedOffers: [], expectedImageCount: 21, actualImageCount: 21
      },
      platformStatusWarnings: OFFER_IDS.map((offerId) => ({
        code: 'OZON_STOCK_DIFFERENCE', offerId, expected: 1, actual: 0
      })),
      finalConsistencyRecovery: {
        schemaVersion: 1,
        phase: 'FAILED',
        confirmationCount: 3,
        affectedOffers: OFFER_IDS.map((offerId) => ({
          offerId,
          differences: { stock: { expected: 1, actual: 0, valid: true, reasons: [] } }
        }))
      }
    },
    productMappings: OFFER_IDS.map((offerId, index) => ({
      offerId,
      ozonProductId: PRODUCT_IDS[index],
      ozonSku: OZON_SKUS[index],
      platformStatus: 'ON_SALE',
      statusSnapshot: statusSnapshots[index]
    }))
  };
  const job = {
    id: '2fa0f3ae-0b22-4ac9-b644-dc9a63af013a',
    sku: '0000105',
    offerIds: OFFER_IDS,
    storeAlias: 'default',
    state: 'MODERATING',
    source: 'AUTO',
    taskId: '2fa0f3ae-0b22-4ac9-b644-dc9a63af013a',
    importTaskId: '5358968564',
    payload,
    ozonProductLinks: OFFER_IDS.map((offerId, index) => ({
      offerId, ozonProductId: PRODUCT_IDS[index], ozonSku: OZON_SKUS[index]
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
    leaseExpiresAt: '2026-08-09T11:29:30.000Z',
    createdAt: '2026-08-09T10:24:57.197Z',
    updatedAt: '2026-08-09T11:19:30.207Z'
  };
  const authority = {
    job,
    listing: {
      sku: '0000105', productName: '潮流单肩包', status: 'SUBMITTING', rowVersion: 19, revision: 4,
      data: { fulfillmentMode: 'RFBS' }, createdAt: job.createdAt, updatedAt: job.updatedAt
    },
    mappings
  };
  const operations = ['infoList', 'attributesInfo', 'pricesRead', 'stocksRead', 'picturesInfo'];
  const prepared = operations.map((operation, index) => ({ json: {
    jobId: job.id,
    rowVersion: job.rowVersion,
    sku: job.sku,
    storeAlias: job.storeAlias,
    leaseOwner: job.leaseOwner,
    leaseToken: job.leaseToken,
    offerIds: OFFER_IDS,
    jobPayload: structuredClone(payload),
    currentState: job.state,
    importTaskId: job.importTaskId,
    taskFolder: job.taskFolder,
    workRelPath: job.workRelPath,
    directoryStage: job.directoryStage,
    directorySignature: job.directorySignature,
    expectedOfferIds: OFFER_IDS,
    submittedOfferIds: OFFER_IDS.slice(1),
    publishOfferIds: OFFER_IDS.slice(1),
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
      ? { items: OFFER_IDS.map((offerId, offerIndex) => ({
          offer_id: offerId,
          product_id: PRODUCT_IDS[offerIndex],
          stocks: [{ type: 'rfbs', present: 1, reserved: 0, sku: Number(OZON_SKUS[offerIndex]), warehouse_ids: [] }]
        })) }
      : operation === 'picturesInfo'
        ? { items: PRODUCT_IDS.map((productId) => ({ product_id: productId })) }
        : { items: OFFER_IDS.map((offerId) => ({ offer_id: offerId })) }
  } }));
  const execution = {
    id: '190809',
    workflowId: OZON_P002_RFBS_NORMALIZATION_WORKFLOW_ID,
    status: 'running',
    startedAt: '2026-08-09T11:19:30.080Z',
    data: { resultData: { runData: {
      '准备平台最终校验': [{ data: { main: [prepared] } }],
      '调用 OZON-A001 最终读回': [{ data: { main: [responses] } }]
    } } }
  };
  return { authority, input, execution };
}

function archivedNormalizedInput(fixture: any, normalized: any): any {
  const { job } = fixture.authority;
  const workRelPath = `success/2026-08-09/${job.taskFolder}`;
  return {
    ...normalized,
    revision: job.revision,
    taskFolder: job.taskFolder,
    workRelPath,
    directoryStage: 'SUCCESS',
    directorySignature: job.directorySignature,
    jobPayload: {
      ...normalized.jobPayload,
      videoCacheCleanedAt: VIDEO_CACHE_CLEANED_AT,
      revision: job.revision,
      taskFolder: job.taskFolder,
      workRelPath,
      directoryStage: 'SUCCESS',
      directorySignature: job.directorySignature
    }
  };
}

function responseItems(execution: any): any[] {
  return execution.data.resultData.runData['调用 OZON-A001 最终读回'][0].data.main[0]
    .map((item: any) => item.json);
}

function preparedItems(execution: any): any[] {
  return execution.data.resultData.runData['准备平台最终校验'][0].data.main[0]
    .map((item: any) => item.json);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
