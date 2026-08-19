import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  OZON_KNOWN_POST_PLATFORM_MIN_PRICE_FAILURE_REASON,
  validateKnownPostPlatformMinPriceFailureShape
} from './ozon.js';

const input = {
  reason: OZON_KNOWN_POST_PLATFORM_MIN_PRICE_FAILURE_REASON,
  rowVersion: 45,
  listingRowVersion: 12,
  dryRun: true
} as const;

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

function listingDataSignature(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableTestJson(value)).digest('hex')}`;
}

function fixture105() {
  const id = '50bff6f2-9801-4080-8183-2b37b4953d13';
  const offerId = '0000105-01';
  const listingData = { offers: [{ offerId }] };
  const signature = 'sha256:bfcf86588bd3829c857a3409d4e8a9dfdd6e33d5f751f5fd04584ea92ae7b96d';
  const job = {
    id,
    sku: '0000105',
    source: 'AUTO',
    state: 'NEEDS_ATTENTION',
    row_version: 45,
    store_alias: 'default',
    task_id: id,
    import_task_id: '5352371389',
    ozon_product_id: '5874416999',
    listing_revision: 2,
    offer_ids: [offerId],
    task_folder: '0000105__r2',
    directory_stage: 'PROCESSING',
    work_rel_path: 'processing/0000105__r2',
    directory_signature: signature,
    stage_states: {
      import: 'SUCCESS', moderation: 'SUCCESS', images: 'VERIFIED', video: 'VERIFIED',
      price: 'DIFFERENCE', stock: 'VERIFIED', videoCover: 'VERIFIED', productVideo: 'VERIFIED'
    },
    product_links: [{ offerId, ozonProductId: '5874416999', ozonSku: '5395936600', url: 'https://www.ozon.ru/product/5395936600/' }],
    last_error_code: 'OZON_FINAL_READBACK_MISMATCH',
    payload: {
      offerIds: [offerId],
      importTaskId: '5352371389',
      autoPreparedListingDataSignature: listingDataSignature(listingData),
      workRelPath: 'processing/0000105__r2',
      directoryStage: 'PROCESSING',
      workDirectory: 'G:\\01_MerchRoute\\OZON-Auto-Publish\\processing\\0000105__r2',
      productJsonPath: 'G:\\01_MerchRoute\\OZON-Auto-Publish\\processing\\0000105__r2\\product.json',
      importIntent: { phase: 'TASK_ID_BOUND', importTaskId: '5352371389', offerIds: [offerId] },
      finalVerificationLeaseUntil: null,
      networkRecovery: null,
      priceStockWriteProgress: {
        pricesWrite: { succeededOfferIds: [offerId], pendingOfferIds: [], failedOfferIds: [], errorsByOffer: {} },
        stocksWrite: { succeededOfferIds: [offerId], pendingOfferIds: [], failedOfferIds: [], errorsByOffer: {} }
      },
      finalConsistencyRecovery: {
        phase: 'FAILED', confirmationCount: 3,
        affectedOffers: [{
          offerId,
          differences: {
            price: {
              expected: 194.38, actual: 194.38,
              expectedOldPrice: 388.76, actualOldPrice: 388.76,
              expectedMinPrice: 97.19, actualMinPrice: 0,
              expectedCurrency: 'CNY', actualCurrency: 'CNY'
            }
          }
        }]
      }
    }
  };
  const listing = {
    sku: '0000105', status: 'NEEDS_ATTENTION', row_version: 12, revision: 2,
    last_task_id: id, last_error_code: 'OZON_FINAL_READBACK_MISMATCH',
    data: listingData
  };
  const mappings = [{
    store_alias: 'default', sku: '0000105', offer_id: offerId,
    ozon_product_id: '5874416999', ozon_sku: '5395936600', last_applied_revision: 2
  }];
  return { job, listing, mappings };
}

function fixture106() {
  const id = 'd7938c88-500d-4b75-914c-4602e1640ca3';
  const offerId = '0000106-01';
  const listingData = { offers: [{ offerId }] };
  const job = {
    id,
    sku: '0000106',
    source: 'AUTO',
    state: 'MODERATING',
    row_version: 37,
    store_alias: 'default',
    task_id: id,
    import_task_id: '5353120098',
    ozon_product_id: '5875509673',
    listing_revision: 2,
    offer_ids: [offerId],
    task_folder: '0000106__r2',
    directory_stage: 'PROCESSING',
    work_rel_path: 'processing/0000106__r2',
    directory_signature: 'sha256:b3f0b0c2746ced7bceaa392772a5009d4699779b29524e8ba9f4c3664bc68e05',
    stage_states: { import: 'SUCCESS', price: 'DIFFERENCE', stock: 'VERIFIED' },
    product_links: [{
      offerId,
      ozonProductId: '5875509673',
      ozonSku: '5396882480',
      url: 'https://www.ozon.ru/product/5396882480/'
    }],
    last_error_code: null,
    last_error_message: null,
    payload: {
      offerIds: [offerId],
      importTaskId: '5353120098',
      autoPreparedListingDataSignature: listingDataSignature(listingData),
      workRelPath: 'processing/0000106__r2',
      directoryStage: 'PROCESSING',
      workDirectory: 'G:\\01_MerchRoute\\OZON-Auto-Publish\\processing\\0000106__r2',
      productJsonPath: 'G:\\01_MerchRoute\\OZON-Auto-Publish\\processing\\0000106__r2\\product.json',
      importIntent: { phase: 'TASK_ID_BOUND', importTaskId: '5353120098', offerIds: [offerId] },
      finalVerificationLeaseUntil: null,
      networkRecovery: null,
      priceStockWriteProgress: {
        pricesWrite: { succeededOfferIds: [offerId], pendingOfferIds: [], failedOfferIds: [], errorsByOffer: {} },
        stocksWrite: { succeededOfferIds: [offerId], pendingOfferIds: [], failedOfferIds: [], errorsByOffer: {} }
      },
      finalConsistencyRecovery: {
        phase: 'CONFIRMING',
        confirmationCount: 2,
        affectedOffers: [{
          offerId,
          differences: {
            price: {
              expected: 216.08,
              actual: 216.08,
              expectedOldPrice: 432.16,
              actualOldPrice: 432.16,
              expectedMinPrice: 108.04,
              actualMinPrice: 0,
              expectedCurrency: 'CNY',
              actualCurrency: 'CNY'
            }
          }
        }]
      }
    }
  };
  const listing = {
    sku: '0000106', status: 'MODERATING', row_version: 10, revision: 2,
    last_task_id: id, last_error_code: null, last_error_message: null,
    data: listingData
  };
  const mappings = [{
    store_alias: 'default', sku: '0000106', offer_id: offerId,
    ozon_product_id: '5875509673', ozon_sku: '5396882480', last_applied_revision: 2
  }];
  return { job, listing, mappings };
}

function fixture107() {
  const id = '7c525f2c-a52c-475c-b8f5-a99ab61b348f';
  const offerIds = ['0000107-01', '0000107-02', '0000107-03'];
  const listingData = { offers: offerIds.map((offerId) => ({ offerId })) };
  const job = {
    id,
    sku: '0000107',
    source: 'AUTO',
    state: 'MODERATING',
    row_version: 72,
    store_alias: 'default',
    task_id: id,
    import_task_id: '5353123776',
    ozon_product_id: null,
    listing_revision: 2,
    offer_ids: offerIds,
    task_folder: '0000107__r2',
    directory_stage: 'PROCESSING',
    work_rel_path: 'processing/0000107__r2',
    directory_signature: 'sha256:c4f827b34bbd344370d5209e4321a10a7ec4a83b11741e2aac53a43c6091b771',
    stage_states: { import: 'SUCCESS', price: 'WRITE_ACCEPTED', stock: 'WRITE_ACCEPTED' },
    product_links: [],
    last_error_code: null,
    last_error_message: null,
    payload: {
      offerIds,
      importTaskId: '5353123776',
      autoPreparedListingDataSignature: listingDataSignature(listingData),
      workRelPath: 'processing/0000107__r2',
      directoryStage: 'PROCESSING',
      workDirectory: 'G:\\01_MerchRoute\\OZON-Auto-Publish\\processing\\0000107__r2',
      productJsonPath: 'G:\\01_MerchRoute\\OZON-Auto-Publish\\processing\\0000107__r2\\product.json',
      importIntent: { phase: 'TASK_ID_BOUND', importTaskId: '5353123776', offerIds },
      finalVerificationLeaseUntil: null,
      networkRecovery: null,
      priceStockWriteProgress: {
        pricesWrite: { succeededOfferIds: offerIds, pendingOfferIds: [], failedOfferIds: [], errorsByOffer: {} },
        stocksWrite: { succeededOfferIds: offerIds, pendingOfferIds: [], failedOfferIds: [], errorsByOffer: {} }
      }
    }
  };
  const listing = {
    sku: '0000107', status: 'MODERATING', row_version: 6, revision: 2,
    last_task_id: id, last_error_code: null, last_error_message: null,
    data: listingData
  };
  return { job, listing, mappings: [] };
}

describe('known post-platform min-price recovery repository contract', () => {
  it('accepts only the fixed 105 shape and proposes IMPORTING/RECONCILE_IMPORT with price-only pending', () => {
    const fixture = fixture105();
    const result = validateKnownPostPlatformMinPriceFailureShape(
      fixture.job,
      fixture.listing,
      fixture.mappings,
      input
    );
    expect(result.proposed).toEqual({
      jobState: 'IMPORTING',
      listingState: 'SUBMITTING',
      schedulerMode: 'RECONCILE_IMPORT',
      pendingPriceOfferIds: ['0000105-01'],
      preservedStockOfferIds: ['0000105-01'],
      workRelPath: 'processing/0000105__r2',
      directoryStage: 'PROCESSING'
    });
  });

  it('accepts the legacy shape only when both derived absolute payload paths are absent', () => {
    const fixture = fixture105();
    delete fixture.job.payload.workDirectory;
    delete fixture.job.payload.productJsonPath;
    const result = validateKnownPostPlatformMinPriceFailureShape(
      fixture.job,
      fixture.listing,
      fixture.mappings,
      input
    );
    expect(result.proposed).toMatchObject({
      jobState: 'IMPORTING',
      pendingPriceOfferIds: ['0000105-01']
    });
  });

  it('accepts a strictly parseable expired final verification lease that apply will clear', () => {
    const fixture = fixture107();
    fixture.job.payload.finalVerificationLeaseUntil = new Date(Date.now() - 60_000).toISOString();
    const result = validateKnownPostPlatformMinPriceFailureShape(
      fixture.job,
      fixture.listing,
      fixture.mappings,
      {
        reason: OZON_KNOWN_POST_PLATFORM_MIN_PRICE_FAILURE_REASON,
        rowVersion: 72,
        listingRowVersion: 6,
        dryRun: true
      }
    );
    expect(result.proposed.pendingPriceOfferIds).toEqual([
      '0000107-01', '0000107-02', '0000107-03'
    ]);
  });

  it('keeps the old 106 job at its single existing Offer and leaves 02/03 to a separate append ledger', () => {
    const fixture = fixture106();
    const result = validateKnownPostPlatformMinPriceFailureShape(
      fixture.job,
      fixture.listing,
      fixture.mappings,
      {
        reason: OZON_KNOWN_POST_PLATFORM_MIN_PRICE_FAILURE_REASON,
        rowVersion: 37,
        listingRowVersion: 10,
        dryRun: true
      }
    );
    expect(result.proposed).toMatchObject({
      jobState: 'IMPORTING',
      schedulerMode: 'RECONCILE_IMPORT',
      pendingPriceOfferIds: ['0000106-01'],
      preservedStockOfferIds: ['0000106-01']
    });
    expect(result.proposed.pendingPriceOfferIds).not.toContain('0000106-02');
    expect(result.proposed.pendingPriceOfferIds).not.toContain('0000106-03');
  });

  it('accepts only the complete three-Offer 107 pre-final shape without inventing persisted mappings', () => {
    const fixture = fixture107();
    const result = validateKnownPostPlatformMinPriceFailureShape(
      fixture.job,
      fixture.listing,
      fixture.mappings,
      {
        reason: OZON_KNOWN_POST_PLATFORM_MIN_PRICE_FAILURE_REASON,
        rowVersion: 72,
        listingRowVersion: 6,
        dryRun: true
      }
    );
    expect(result.proposed).toMatchObject({
      jobState: 'IMPORTING',
      schedulerMode: 'RECONCILE_IMPORT',
      pendingPriceOfferIds: ['0000107-01', '0000107-02', '0000107-03'],
      preservedStockOfferIds: ['0000107-01', '0000107-02', '0000107-03']
    });
    expect(result.proposed.pendingPriceOfferIds).toHaveLength(3);

    fixture.mappings.push({ offer_id: '0000107-01' });
    expect(() => validateKnownPostPlatformMinPriceFailureShape(
      fixture.job,
      fixture.listing,
      fixture.mappings,
      {
        reason: OZON_KNOWN_POST_PLATFORM_MIN_PRICE_FAILURE_REASON,
        rowVersion: 72,
        listingRowVersion: 6,
        dryRun: true
      }
    )).toThrow();
  });

  it.each([
    ['importTask drift', (fixture: ReturnType<typeof fixture105>) => { fixture.job.import_task_id = '999'; }],
    ['store alias drift', (fixture: ReturnType<typeof fixture105>) => { fixture.job.store_alias = 'secondary'; }],
    ['mapping drift', (fixture: ReturnType<typeof fixture105>) => { fixture.mappings[0]!.ozon_sku = '999'; }],
    ['stock pending', (fixture: ReturnType<typeof fixture105>) => { fixture.job.payload.priceStockWriteProgress.stocksWrite.pendingOfferIds = ['0000105-01']; }],
    ['other final difference', (fixture: ReturnType<typeof fixture105>) => {
      const affected = fixture.job.payload.finalConsistencyRecovery.affectedOffers[0]!;
      (affected.differences as Record<string, unknown>).stock = { expected: 1, actual: 0 };
    }],
    ['min is no longer zero', (fixture: ReturnType<typeof fixture105>) => {
      fixture.job.payload.finalConsistencyRecovery.affectedOffers[0]!.differences.price.actualMinPrice = 97.19;
    }],
    ['one-cent old-price drift', (fixture: ReturnType<typeof fixture105>) => {
      fixture.job.payload.finalConsistencyRecovery.affectedOffers[0]!.differences.price.actualOldPrice = 388.75;
    }],
    ['payload path drift', (fixture: ReturnType<typeof fixture105>) => {
      fixture.job.payload.productJsonPath = 'G:\\manual\\product.json';
    }],
    ['only workDirectory absent', (fixture: ReturnType<typeof fixture105>) => {
      delete fixture.job.payload.workDirectory;
    }],
    ['only productJsonPath absent', (fixture: ReturnType<typeof fixture105>) => {
      delete fixture.job.payload.productJsonPath;
    }],
    ['future final lease', (fixture: ReturnType<typeof fixture105>) => {
      fixture.job.payload.finalVerificationLeaseUntil = new Date(Date.now() + 60_000).toISOString();
    }],
    ['invalid final lease', (fixture: ReturnType<typeof fixture105>) => {
      fixture.job.payload.finalVerificationLeaseUntil = 'not-a-date';
    }],
    ['listing data signature drift', (fixture: ReturnType<typeof fixture105>) => {
      fixture.job.payload.autoPreparedListingDataSignature = `sha256:${'0'.repeat(64)}`;
    }],
    ['job CAS drift', (_fixture: ReturnType<typeof fixture105>) => {}]
  ])('rejects %s', (_label, mutate) => {
    const fixture = fixture105();
    mutate(fixture);
    const candidateInput = _label === 'job CAS drift' ? { ...input, rowVersion: 44 } : input;
    expect(() => validateKnownPostPlatformMinPriceFailureShape(
      fixture.job,
      fixture.listing,
      fixture.mappings,
      candidateInput
    )).toThrow();
  });
});
