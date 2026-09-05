import { describe, expect, it } from 'vitest';
import type { OzonCategoryTemplate, OzonListingDraft, OzonPublication, OzonPublishJob, OzonReadiness } from './api/client';
import {
  evaluateOzonListingReadiness,
  mergeOzonInitializationIntoForm,
  mergeOzonListingPricesByOfferId,
  mergeOzonOffersAfterScan,
  nextOzonAutoPreparationAction,
  normalizeOzonPresetDimensionsToGrams,
  ozonDimensionsWithManagedGrossWeight,
  ozonEditorSessionMatches,
  ozonListingEditorContextKey,
  ozonListingPriceProjectionComplete,
  ozonManualJobDetailBinding,
  projectOptionalOzonListingPrices,
  ozonJobActionBinding,
  ozonJobArchiveNotice,
  ozonJobFanoutSummary,
  ozonJobIsPublicationManaged,
  ozonJobIsMultistorePreparation,
  ozonVisibleAutomaticJobList,
  ozonVisibleManualJobList,
  ozonPublicationRemoteReadbackEnabled,
  ozonSharedPreparationRecheckEntryAllowed,
  ozonPublicationRecheckInput,
  ozonJobMaterialSnapshot,
  ozonJobNetworkRecovery,
  ozonJobPlatformConsistency,
  ozonJobPrimaryStateMeta,
  ozonJobStageStateValue,
  ozonAutomaticTaskStatistics,
  ozonManualListingDisplayStatus,
  OZON_MANUAL_SHARED_VIDEO_COMPATIBILITY,
  OZON_MANUAL_SHARED_VIDEO_COMPATIBILITY_MESSAGE
} from './ozon-listing';

describe('OZON manual shared-material video compatibility', () => {
  it('defers category compatibility to the selected store preset', () => {
    expect(OZON_MANUAL_SHARED_VIDEO_COMPATIBILITY).toEqual({
      mode: 'PENDING_STORE_PRESET',
      productIntroductionSupported: false,
      videoCoverSupported: false,
      unsupportedRequiredProductSelection: false
    });
    expect(OZON_MANUAL_SHARED_VIDEO_COMPATIBILITY_MESSAGE)
      .toBe('类目兼容性将在选择店铺后，按该店铺默认预设校验');
  });
});

describe('OZON manual listing publication status projection', () => {
  const listing = { sku: '0000120', revision: 3, status: 'READY' as const };
  const publication = (status: OzonPublication['status'], overrides: Partial<OzonPublication> = {}) => ({
    sku: '0000120', revision: 3, source: 'MANUAL' as const, status, ...overrides
  }) as OzonPublication;

  it('shows 已发布 when every store publication for the current revision succeeded', () => {
    expect(ozonManualListingDisplayStatus(listing, [
      publication('SUCCEEDED', { storeId: 'store-a' }),
      publication('SUCCEEDED', { storeId: 'store-b' })
    ])).toBe('PUBLISHED');
  });

  it('ignores old revisions and automatic publications', () => {
    expect(ozonManualListingDisplayStatus(listing, [
      publication('SUCCEEDED', { revision: 2 }),
      publication('SUCCEEDED', { source: 'AUTOMATION' })
    ])).toBe('READY');
  });

  it('projects active and exceptional store outcomes without overwriting the shared draft', () => {
    expect(ozonManualListingDisplayStatus(listing, [publication('SUCCEEDED'), publication('RUNNING')])).toBe('MODERATING');
    expect(ozonManualListingDisplayStatus(listing, [publication('SUCCEEDED'), publication('NEEDS_ATTENTION')])).toBe('NEEDS_ATTENTION');
    expect(ozonManualListingDisplayStatus(listing, [publication('SUCCEEDED'), publication('FAILED')])).toBe('FAILED');
  });
});

describe('OZON publication-safe job actions', () => {
  it('keeps pure legacy jobs on the store-scoped legacy API binding', () => {
    expect(ozonJobActionBinding({
      id: 'legacy-job',
      publicationId: undefined,
      storeId: 'store-a',
      payload: {}
    })).toEqual({ kind: 'LEGACY', jobId: 'legacy-job', storeId: 'store-a' });
    expect(ozonJobIsPublicationManaged({ publicationId: undefined })).toBe(false);
  });

  it('binds publication jobs only to publicationId and hides legacy manual actions', () => {
    const binding = ozonJobActionBinding({
      id: 'must-not-be-used',
      publicationId: 'publication-a',
      storeId: 'must-not-be-used',
      payload: { storeId: 'also-must-not-be-used' }
    });
    expect(binding).toEqual({ kind: 'PUBLICATION', publicationId: 'publication-a' });
    expect(binding).not.toHaveProperty('jobId');
    expect(binding).not.toHaveProperty('storeId');
    expect(ozonJobIsPublicationManaged({ publicationId: ' publication-a ' })).toBe(true);
  });

  it('opens remote readback only for an explicit server capability', () => {
    expect(ozonPublicationRemoteReadbackEnabled()).toBe(false);
    expect(ozonPublicationRemoteReadbackEnabled({ publicationReadbackEnabled: false })).toBe(false);
    expect(ozonPublicationRemoteReadbackEnabled({ publicationReadbackEnabled: true })).toBe(true);
  });

  it('routes manual details to publication, and only PURE_LEGACY to the old SKU/job API', () => {
    expect(ozonManualJobDetailBinding({ id: 'job-a', publicationId: 'publication-a', credentialBindingMode: 'VAULT' }))
      .toEqual({ kind: 'PUBLICATION', publicationId: 'publication-a' });
    expect(ozonManualJobDetailBinding({ id: 'job-b', credentialBindingMode: 'PURE_LEGACY' }))
      .toEqual({ kind: 'PURE_LEGACY', jobId: 'job-b' });
    expect(ozonManualJobDetailBinding({ id: 'job-c', credentialBindingMode: 'VAULT' }).kind).toBe('UNSUPPORTED');
  });

  it('fails closed unless publication recheck has frozen plan and request identities', () => {
    const planHash = `sha256:${'a'.repeat(64)}`;
    const requestId = '11111111-1111-4111-8111-111111111111';
    expect(ozonPublicationRecheckInput({ rowVersion: 4, planHash, requestId }))
      .toEqual({ rowVersion: 4, planHash, requestId });
    expect(ozonPublicationRecheckInput({ rowVersion: 4 })).toBeUndefined();
    expect(ozonPublicationRecheckInput({ rowVersion: 4 }, { planHash, requestId }))
      .toEqual({ rowVersion: 4, planHash, requestId });
  });
});

describe('OZON automatic business-job visibility', () => {
  const businessJob = (id: string, storeId: string) => ({
    id,
    storeId,
    publicationId: `publication-${id}`,
    source: 'AUTO' as const,
    payload: { mode: 'MULTISTORE_PUBLICATION' }
  }) as unknown as OzonPublishJob;

  it('defensively hides every preparation row returned by the server', () => {
    const storeA = businessJob('store-a-job', 'store-a');
    const storeB = businessJob('store-b-job', 'store-b');
    const preparation = {
      id: 'preparation-job',
      source: 'AUTO',
      payload: { multistorePreparation: true }
    } as unknown as OzonPublishJob;

    expect(ozonJobIsMultistorePreparation(preparation)).toBe(true);
    expect(ozonVisibleAutomaticJobList({ items: [storeA, storeB, preparation], total: 3 }))
      .toEqual({ items: [storeA, storeB], total: 2 });
  });

  it('keeps publication and legacy business jobs visible and preserves defensive mixed-source totals', () => {
    const publication = {
      ...businessJob('publication-job', 'store-a'),
      payload: { multistorePreparation: true }
    };
    const legacy = { id: 'legacy-job', source: 'AUTO', payload: {} } as unknown as OzonPublishJob;
    const manual = { id: 'manual-job', source: 'MANUAL', payload: {} } as unknown as OzonPublishJob;

    expect(ozonJobIsMultistorePreparation(publication)).toBe(false);
    expect(ozonVisibleAutomaticJobList({ items: [publication, legacy, manual], total: 3 }))
      .toEqual({ items: [publication, legacy], total: 2 });
  });

  it('hides failed and successful preparations while keeping recovery available through dedicated APIs', () => {
    const failedPreparation = {
      id: 'failed-preparation',
      source: 'AUTO',
      state: 'NEEDS_ATTENTION',
      payload: { multistorePreparation: true }
    } as unknown as OzonPublishJob;
    const successfulPreparation = {
      id: 'successful-preparation',
      source: 'AUTO',
      state: 'SUCCEEDED',
      payload: { multistorePreparation: true }
    } as unknown as OzonPublishJob;

    expect(ozonVisibleAutomaticJobList({
      items: [failedPreparation, successfulPreparation],
      total: 2
    })).toEqual({ items: [], total: 0 });
  });

  it('hides preparation coordinators from manual task history too', () => {
    const manualPublication = {
      id: 'manual-publication', source: 'MANUAL', publicationId: 'publication-manual', payload: {}
    } as unknown as OzonPublishJob;
    const manualPreparation = {
      id: 'manual-preparation', source: 'MANUAL', taskKind: 'SHARED_PREPARATION', payload: { multistorePreparation: true }
    } as unknown as OzonPublishJob;
    const automaticPublication = businessJob('automatic-publication', 'store-a');

    expect(ozonVisibleManualJobList({
      items: [manualPublication, manualPreparation, automaticPublication],
      total: 3
    })).toEqual({ items: [manualPublication], total: 1 });
  });

  it('reads the frozen fan-out recovery capabilities from the task contract', () => {
    expect(ozonJobFanoutSummary({
      payload: {},
      fanoutSummary: {
        phase: 'PARTIAL', targetStoreCount: 2, publicationCount: 2, failureCount: 1,
        canRecheck: true, canManualTakeover: false, recoveryMode: 'RECHECK'
      }
    } as unknown as OzonPublishJob)).toMatchObject({
      phase: 'PARTIAL', targetStoreCount: 2, publicationCount: 2, failureCount: 1,
      canRecheck: true, canManualTakeover: false
    });
  });

  it('accepts the manual-success reconciliation capability without exposing ordinary recheck', () => {
    expect(ozonJobFanoutSummary({
      payload: {},
      fanoutSummary: {
        phase: 'NOT_STARTED', targetStoreCount: 0, publicationCount: 0, failureCount: 1,
        canRecheck: false, canManualTakeover: false, canReconcileManualSuccess: true,
        recoveryMode: 'MANUAL_SUCCESS_RECONCILE'
      }
    } as unknown as OzonPublishJob)).toEqual({
      phase: 'NOT_STARTED', targetStoreCount: 0, publicationCount: 0, failureCount: 1,
      canRecheck: false, canManualTakeover: false, canReconcileManualSuccess: true,
      recoveryMode: 'MANUAL_SUCCESS_RECONCILE'
    });
  });

  it('fails closed when a fan-out summary drifts outside the shared enum contract', () => {
    expect(ozonJobFanoutSummary({
      payload: {},
      fanoutSummary: {
        phase: 'PARTIAL_FAILURE', targetStoreCount: 2, publicationCount: 1, failureCount: 1,
        canRecheck: true, canManualTakeover: false, recoveryMode: 'REUSE_FROZEN_IDENTITIES'
      }
    } as unknown as OzonPublishJob)).toBeUndefined();
  });
});

describe('OZON shared preparation recheck entry', () => {
  it('allows a failed PRE_PLAN task to request its read-only proof even when task detail cannot yet recheck', () => {
    expect(ozonSharedPreparationRecheckEntryAllowed(
      { state: 'NEEDS_ATTENTION', payload: { multistorePreparation: true } },
      { canRecheck: false }
    )).toBe(true);
  });

  it('obeys the server capability after a fan-out contract has been frozen', () => {
    const job = { state: 'NEEDS_ATTENTION' as const, payload: { fanoutPlan: { planHash: `sha256:${'a'.repeat(64)}` } } };
    expect(ozonSharedPreparationRecheckEntryAllowed(job, { canRecheck: false })).toBe(false);
    expect(ozonSharedPreparationRecheckEntryAllowed(job, { canRecheck: true })).toBe(true);
  });
});

describe('OZON listing editor currency context', () => {
  it('keeps manual and every store-scoped automatic task in separate editor sessions', () => {
    const manualKey = ozonListingEditorContextKey({ mode: 'MANUAL_DRAFT', sku: '0000129' });
    const storeAKey = ozonListingEditorContextKey({ mode: 'AUTO_TASK_SNAPSHOT', sku: '0000129', jobId: 'job-a', storeId: 'store-a' });
    const storeBKey = ozonListingEditorContextKey({ mode: 'AUTO_TASK_SNAPSHOT', sku: '0000129', jobId: 'job-b', storeId: 'store-b' });

    expect(new Set([manualKey, storeAKey, storeBKey]).size).toBe(3);
    expect(ozonEditorSessionMatches({ contextKey: storeAKey, sessionId: 4 }, storeAKey, 4)).toBe(true);
    expect(ozonEditorSessionMatches({ contextKey: storeAKey, sessionId: 4 }, storeBKey, 4)).toBe(false);
  });

  it('merges frozen prices by offerId rather than array position', () => {
    expect(mergeOzonListingPricesByOfferId([
      { offerId: '0000129-01', price: 7425 },
      { offerId: '0000129-02', price: 9900 }
    ], [
      { offerId: '0000129-02', price: 900, oldPrice: 1800 },
      { offerId: '0000129-01', price: 675, oldPrice: 1350, minPrice: 337.5 }
    ])).toEqual([
      { offerId: '0000129-01', price: 675, oldPrice: 1350, minPrice: 337.5 },
      { offerId: '0000129-02', price: 900, oldPrice: 1800 }
    ]);
  });

  it('clears unmatched legacy prices instead of relabeling them with the target currency', () => {
    const offers = [
      { offerId: '0000129-01', price: 7425 },
      { offerId: '0000129-02', price: 9900 }
    ];
    const incomplete = [{ offerId: '0000129-01', price: 675 }];

    expect(ozonListingPriceProjectionComplete(offers, incomplete)).toBe(false);
    expect(mergeOzonListingPricesByOfferId(offers, incomplete)).toEqual([
      { offerId: '0000129-01', price: 675 },
      { offerId: '0000129-02', price: undefined, oldPrice: undefined, minPrice: undefined }
    ]);
  });

  it('clears optional legacy prices when the frozen snapshot intentionally omits them', () => {
    expect(mergeOzonListingPricesByOfferId([
      { offerId: '0000129-01', price: 7425, oldPrice: 14850, minPrice: 3712.5 }
    ], [
      { offerId: '0000129-01', price: 675 }
    ])).toEqual([
      { offerId: '0000129-01', price: 675, oldPrice: undefined, minPrice: undefined }
    ]);
  });

  it('preserves stored CNY offer prices when the optional projection is absent', () => {
    const offers = [{ offerId: '0000129-01', price: 675, oldPrice: 1350, minPrice: 337.5 }];
    expect(projectOptionalOzonListingPrices(offers, undefined, false)).toEqual(offers);
    expect(projectOptionalOzonListingPrices(offers, undefined, true)).toEqual([
      { offerId: '0000129-01', price: undefined, oldPrice: undefined, minPrice: undefined }
    ]);
  });
});

describe('OZON automatic task statistics', () => {
  it('does not count archived platform outcomes as processing or requiring attention', () => {
    expect(ozonAutomaticTaskStatistics({
      SUCCEEDED: 24,
      CANCELLED: 3,
      ARCHIVED: 2
    })).toEqual({ waiting: 0, processing: 0, succeeded: 24, needsAttention: 0 });
  });

  it('counts only explicit active states as processing and keeps real failures in attention', () => {
    expect(ozonAutomaticTaskStatistics({
      WAITING_MEDIA: 1,
      READY: 2,
      MODERATING: 3,
      NEEDS_ATTENTION: 4,
      FAILED: 5,
      ARCHIVED: 6,
      CANCELLED: 7
    })).toEqual({ waiting: 1, processing: 5, succeeded: 0, needsAttention: 9 });
  });
});

describe('OZON automatic platform state label', () => {
  it('shows one reassuring automatic status while the original task safely resumes', () => {
    expect(ozonJobPrimaryStateMeta({
      state: 'IMPORTING',
      payload: { networkRecovery: { status: 'WAITING_NETWORK' } },
      ozonProductLinks: []
    } as unknown as OzonPublishJob)).toEqual({ label: 'OZON上品中', color: 'processing' });
  });

  it('keeps the automatic workflow state independent from a platform outcome', () => {
    expect(ozonJobPrimaryStateMeta({
      state: 'NEEDS_ATTENTION',
      offerIds: ['0000119-01'],
      ozonProductLinks: [{
        offerId: '0000119-01',
        ozonProductId: '5913618188',
        ozonSku: '5430089516',
        url: 'https://www.ozon.ru/product/5430089516/',
        displayState: 'NOT_FOR_SALE'
      }]
    })).toEqual({ label: '需要处理', color: 'volcano' });
  });

  it('shows a complete all-archived platform readback without replacing the workflow state', () => {
    const job = {
      state: 'NEEDS_ATTENTION',
      offerIds: ['0000119-01'],
      ozonProductLinks: [{
        offerId: '0000119-01',
        ozonProductId: '5913618212',
        ozonSku: '5430087519',
        url: 'https://www.ozon.ru/product/5430087519/',
        displayState: 'ARCHIVED',
        platformMessage: 'Убран из продажи'
      }]
    } as unknown as OzonPublishJob;

    expect(ozonJobPrimaryStateMeta(job)).toEqual({ label: '需要处理', color: 'volcano' });
    expect(ozonJobArchiveNotice(job)).toEqual({
      message: 'OZON 商品已经归档',
      description: '全部变体已经归档，买家端不可售。这是平台归档状态，不是库存写入失败。 OZON 原始说明：Убран из продажи'
    });
    expect(ozonJobStageStateValue({
      ...job,
      stageStates: {
        import: 'SUCCESS', moderation: 'FAILED', images: 'VERIFIED', video: 'VERIFIED', price: 'VERIFIED', stock: 'VERIFIED'
      }
    }, 'moderation')).toBe('ARCHIVED');
  });

  it('shows mixed archived and on-sale Offers as partial sale', () => {
    const job = {
      state: 'CANCELLED',
      offerIds: ['0000171-01', '0000171-02'],
      ozonProductLinks: [
        { offerId: '0000171-01', displayState: 'ARCHIVED', platformMessage: 'Убран из продажи' },
        { offerId: '0000171-02', displayState: 'ON_SALE' }
      ],
      stageStates: { moderation: 'FAILED' }
    } as unknown as OzonPublishJob;
    expect(ozonJobPrimaryStateMeta(job)).toEqual({ label: '已取消', color: 'default' });
    expect(ozonJobArchiveNotice(job)).toEqual({
      message: 'OZON 商品部分可售',
      description: '平台回读显示 0000171-02 已可售，0000171-01 已经归档。自动流程状态与平台状态分别保留。 OZON 原始说明：Убран из продажи'
    });
    expect(ozonJobStageStateValue(job, 'moderation')).toBe('PARTIAL');
  });
});

describe('OZON network recovery view', () => {
  it('shows only a complete persisted WAITING_NETWORK contract', () => {
    const networkRecovery = {
      schemaVersion: 1,
      status: 'WAITING_NETWORK',
      phase: 'N8N_DISPATCH',
      resumeState: 'READY',
      deliveryState: 'UNKNOWN',
      attempt: 5,
      firstFailureAt: '2026-08-07T01:00:00.000Z',
      lastFailureAt: '2026-08-07T01:16:00.000Z',
      nextAttemptAt: '2026-08-07T01:31:00.000Z',
      errorCode: 'ETIMEDOUT',
      errorMessage: 'request timed out'
    };
    expect(ozonJobNetworkRecovery({ payload: { networkRecovery } } as Pick<OzonPublishJob, 'payload'>))
      .toEqual(networkRecovery);
    expect(ozonJobNetworkRecovery({ payload: { networkRecovery: { ...networkRecovery, nextAttemptAt: '' } } } as Pick<OzonPublishJob, 'payload'>))
      .toBeUndefined();
  });
});

describe('OZON listing automatic preparation', () => {
  const base = {
    sku: '0000095',
    status: 'DRAFT' as const,
    needsInitialization: true,
    initializationPending: false,
    mediaScanPending: false
  };

  it('serializes initialization and one media scan per editor session', () => {
    expect(nextOzonAutoPreparationAction(base)).toBe('INITIALIZE');
    expect(nextOzonAutoPreparationAction({ ...base, initializationAttemptedFor: base.sku })).toBeUndefined();
    expect(nextOzonAutoPreparationAction({
      ...base,
      initializationAttemptedFor: base.sku,
      initializationFinishedFor: base.sku
    })).toBe('SCAN');
    expect(nextOzonAutoPreparationAction({
      ...base,
      initializationAttemptedFor: base.sku,
      initializationFinishedFor: base.sku,
      mediaScanAttemptedFor: base.sku
    })).toBeUndefined();
  });

  it('scans READY drafts without initialization and ignores immutable states', () => {
    expect(nextOzonAutoPreparationAction({ ...base, status: 'READY', needsInitialization: false })).toBe('SCAN');
    expect(nextOzonAutoPreparationAction({ ...base, status: 'PUBLISHED', needsInitialization: false })).toBeUndefined();
    expect(nextOzonAutoPreparationAction({ ...base, needsInitialization: false, mediaScanPending: true })).toBeUndefined();
  });

  it('rejects responses from another SKU or an earlier editor session', () => {
    const active = { contextKey: 'MANUAL_DRAFT:0000095', sessionId: 4 };
    expect(ozonEditorSessionMatches(active, 'MANUAL_DRAFT:0000095', 4)).toBe(true);
    expect(ozonEditorSessionMatches(active, 'MANUAL_DRAFT:0000095', 3)).toBe(false);
    expect(ozonEditorSessionMatches(active, 'MANUAL_DRAFT:0000096', 4)).toBe(false);
  });
});

describe('OZON in-flight merge behavior', () => {
  const black = offer('black', '01');
  const white = offer('white', '02');

  it('does not restore an Offer deleted while media scan was in flight', () => {
    const result = mergeOzonOffersAfterScan([black], [black, white], []);
    expect(result.map((item) => item.variantId)).toEqual(['black']);
  });

  it('does not restore an Offer deleted while initialization was in flight', () => {
    const initialized = {
      sku: '0000095',
      data: {
        titleRu: 'Новое название',
        descriptionRu: 'Новое описание',
        offers: [
          { ...black, descriptionRu: 'Черный вариант' },
          { ...white, descriptionRu: 'Белый вариант' }
        ]
      }
    } as unknown as OzonListingDraft;
    const result = mergeOzonInitializationIntoForm({ offers: [black] }, initialized, new Set());
    expect(result.offers.map((item: any) => item.variantId)).toEqual(['black']);
    expect(result.offers[0].descriptionRu).toBe('Черный вариант');
  });

  it('applies a newly captured managed gross weight without overwriting editable dimensions', () => {
    const grossWeightResolution = {
      source: 'PROCUREMENT' as const,
      effectiveGrossWeightGrams: 650.5,
      procurementGrossWeightGrams: 650.5,
      presetGrossWeightGrams: 800,
      procurementVersionId: '77777777-7777-4777-8777-777777777777',
      procurementVersionNo: 7,
      procurementCapturedAt: '2026-08-07T02:30:00.000Z'
    };
    const initialized = {
      sku: '0000095',
      data: {
        titleRu: 'Новое название',
        descriptionRu: 'Новое описание',
        dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 650.5, weightUnit: 'g' },
        initialization: { status: 'COMPLETE', initializedAt: '2026-08-07T02:30:00.000Z', issues: [], grossWeightResolution },
        offers: [black]
      }
    } as unknown as OzonListingDraft;

    const result = mergeOzonInitializationIntoForm({
      dimensions: { length: 31, width: 21, height: 11, dimensionUnit: 'in', weight: 999, weightUnit: 'lb' },
      offers: [black]
    }, initialized, new Set());

    expect(result.dimensions).toEqual({ length: 31, width: 21, height: 11, dimensionUnit: 'in', weight: 650.5, weightUnit: 'g' });
  });
});

describe('OZON gross-weight form normalization', () => {
  const resolution = {
    source: 'PRESET_FALLBACK' as const,
    effectiveGrossWeightGrams: 650.5,
    procurementGrossWeightGrams: null,
    presetGrossWeightGrams: 650.5,
    procurementVersionId: '77777777-7777-4777-8777-777777777777',
    procurementVersionNo: 7,
    procurementCapturedAt: '2026-08-07T02:30:00.000Z'
  };

  it('locks managed draft weight to the audited grams while retaining length, width, height, and unit', () => {
    expect(ozonDimensionsWithManagedGrossWeight(
      { length: 31, width: 21, height: 11, dimensionUnit: 'in', weight: 2, weightUnit: 'lb' },
      resolution
    )).toEqual({ length: 31, width: 21, height: 11, dimensionUnit: 'in', weight: 650.5, weightUnit: 'g' });
  });

  it('keeps historical dimensions unchanged when there is no audit snapshot', () => {
    const dimensions = { length: 31, width: 21, height: 11, dimensionUnit: 'in' as const, weight: 2, weightUnit: 'lb' as const };
    expect(ozonDimensionsWithManagedGrossWeight(dimensions, undefined)).toBe(dimensions);
  });

  it('loads old kg and lb presets as equivalent grams and always emits g', () => {
    expect(normalizeOzonPresetDimensionsToGrams({ length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 0.6505, weightUnit: 'kg' }))
      .toMatchObject({ weight: 650.5, weightUnit: 'g' });
    expect(normalizeOzonPresetDimensionsToGrams({ length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 2, weightUnit: 'lb' }))
      .toMatchObject({ weight: 907.18474, weightUnit: 'g' });
    expect(normalizeOzonPresetDimensionsToGrams({ length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 650.5, weightUnit: 'g' }))
      .toMatchObject({ weight: 650.5, weightUnit: 'g' });
  });
});

describe('OZON listing readiness explanation', () => {
  it('returns the concrete Offer media requirement used by the DRAFT submit tooltip', () => {
    const listing = {
      data: {
        mediaAssets: [],
        offers: []
      }
    } as unknown as OzonListingDraft;
    const values = {
      titleRu: 'Название',
      descriptionRu: 'Описание',
      warehouseId: 'warehouse',
      dimensions: { length: 1, width: 1, height: 1, weight: 1 },
      offers: [{ offerId: '0000095-01', price: 100, stock: 1, media: [] }]
    };
    const category = {
      typeId: 1,
      publishedVersion: { snapshot: { attributes: [] } }
    } as unknown as OzonCategoryTemplate;
    const readiness = { ready: true } as OzonReadiness;

    expect(evaluateOzonListingReadiness(listing, values, category, readiness).find((check) => check.label === '媒体')).toEqual({
      label: '媒体',
      ok: false,
      detail: '媒体尚未同步：每个 Offer 至少需要 1 张图片和 1 个产品视频/封面'
    });
  });
});

describe('OZON automatic job material audit', () => {
  it('defensively normalizes the versioned material snapshot stored in an unknown payload', () => {
    const snapshot = ozonJobMaterialSnapshot({
      payload: {
        materialSnapshot: {
          schemaVersion: '1',
          capturedAt: '2026-08-07T04:30:00.000Z',
          preset: { id: 'preset-1', name: '默认自动预设', rowVersion: '7', definitionHash: 'preset-signature' },
          category: { key: 'ozon_17001_97001', versionId: 'category-version-1', versionNo: '3', schemaHash: 'category-signature' },
          procurement: {
            versionId: 'procurement-version-1', versionNo: '9', capturedAt: '2026-08-07T04:20:00.000Z',
            productHeightCm: '12.5', productDepthCm: 28, productWidthCm: 20, netWeightGrams: '640'
          },
          packaging: { lengthCm: 30, widthCm: 22, heightCm: 14, grossWeightGrams: '800', grossWeightSource: 'PROCUREMENT' },
          pricing: { pricingTemplateId: 'pricing-1', shippingTemplateId: 'shipping-1', shippingServiceCode: 'CDEK', optionId: 'option-1' },
          store: { storeAlias: 'default', warehouseId: 'warehouse-1', currency: 'RUB', fulfillmentMode: 'FBS' },
          offers: { count: '2', ids: ['0000095-01', '0000095-01', '0000095-02'] },
          artifact: { revision: '11', signature: 'artifact-signature' },
          warnings: ['净重使用采购版本快照', '净重使用采购版本快照']
        }
      }
    } as unknown as Pick<OzonPublishJob, 'payload'>);

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      preset: { name: '默认自动预设', rowVersion: 7 },
      category: { key: 'ozon_17001_97001', versionNo: 3 },
      procurement: { productHeightCm: 12.5, productDepthCm: 28, productWidthCm: 20, netWeightGrams: 640 },
      packaging: { grossWeightGrams: 800, grossWeightSource: 'PROCUREMENT' },
      store: { warehouseId: 'warehouse-1', currency: 'RUB' },
      offers: { count: 2, ids: ['0000095-01', '0000095-02'] },
      artifact: { revision: 11, signature: 'artifact-signature' },
      warnings: ['净重使用采购版本快照']
    });
  });

  it('explicitly treats missing or malformed snapshots as historical data', () => {
    expect(ozonJobMaterialSnapshot({})).toBeUndefined();
    expect(ozonJobMaterialSnapshot({ payload: { materialSnapshot: 'invalid' } } as unknown as Pick<OzonPublishJob, 'payload'>)).toBeUndefined();
    expect(ozonJobMaterialSnapshot({ payload: { materialSnapshot: {} } } as unknown as Pick<OzonPublishJob, 'payload'>)).toBeUndefined();
  });

  it('deduplicates platform refresh, product link, and DIFFERENCE stage warnings', () => {
    const job = {
      payload: { platformStatusRefresh: { warnings: ['OZON 读回图片数量不同', '主图仍在处理'] } },
      stageStates: { import: 'SUCCEEDED', images: 'DIFFERENCE', productVideo: 'DIFFERENCE' },
      ozonProductLinks: [{ offerId: '0000095-01', ozonProductId: '123', url: 'https://www.ozon.ru/product/123/', warnings: ['主图仍在处理'] }]
    } as unknown as OzonPublishJob;

    expect(ozonJobPlatformConsistency(job)).toEqual({
      differenceStages: ['图片读回', '产品介绍视频'],
      warnings: ['OZON 读回图片数量不同', '主图仍在处理']
    });
  });
});

function offer(variantId: string, variantCode: string) {
  return {
    variantId,
    productVariantId: variantId,
    variantCode,
    offerId: `0000095-${variantCode}`,
    barcode: '',
    modelGroup: '0000095',
    price: 100,
    stock: 1,
    descriptionRu: '',
    descriptionWarnings: [],
    attributes: [],
    media: []
  };
}
