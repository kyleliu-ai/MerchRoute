import { describe, expect, it } from 'vitest';
import {
  ozonGatewayRequestSchema,
  ozonGatewayLegacyReceiptSchema,
  ozonIntakeVerifySchema,
  ozonPublicationCreateInputSchema,
  ozonPublicationCreateResultSchema,
  ozonPublicationRecheckInputSchema,
  ozonPublicationPlanInputSchema,
  ozonPublicationPlanItemAttemptIdentitySchema,
  ozonFrozenContentBindingSchema,
  ozonRuntimeClaimJobSchema,
  ozonRuntimeClaimResultSchema,
  ozonRuntimeTransitionBindingSchema,
  ozonStoreCreateSchema,
  ozonStorePreflightReportSchema,
  ozonStoreUpdateSchema,
  ozonStorePreflightDispatchSchema
} from './ozon-multistore.js';
import { ozonPreparationFanoutSummarySchema } from './ozon.js';

const storeId = '11111111-1111-4111-8111-111111111111';
const publicationId = '22222222-2222-4222-8222-222222222222';
const credentialVersionId = '33333333-3333-4333-8333-333333333333';
const requestId = '77777777-7777-4777-8777-777777777777';
const hash = `sha256:${'a'.repeat(64)}`;
const frozenContent = {
  contentPolicyVersion: 'merchroute-ozon-content-v3' as const,
  materialHash: `sha256:${'b'.repeat(64)}`,
  materialHashVersion: 'ozon-shared-material-v1' as const
};

describe('OZON store account currency contracts', () => {
  it('accepts CNY/RUB, preserves the legacy API default, and rejects other currencies', () => {
    const base = { storeAlias: 'tek-plus', displayName: 'Tek+' };
    expect(ozonStoreCreateSchema.parse({ ...base, accountCurrency: 'CNY' }).accountCurrency).toBe('CNY');
    expect(ozonStoreCreateSchema.parse({ ...base, accountCurrency: 'RUB' }).accountCurrency).toBe('RUB');
    expect(ozonStoreCreateSchema.parse(base).accountCurrency).toBe('RUB');
    expect(ozonStoreCreateSchema.safeParse({ ...base, accountCurrency: 'USD' }).success).toBe(false);
    expect(ozonStoreUpdateSchema.safeParse({ accountCurrency: 'CNY', rowVersion: 1 }).success).toBe(true);
    expect(ozonStoreUpdateSchema.safeParse({ accountCurrency: 'RUB', rowVersion: 1 }).success).toBe(true);
    expect(ozonStoreUpdateSchema.safeParse({ accountCurrency: 'USD', rowVersion: 1 }).success).toBe(false);
  });

  it('requires the observed account currency whenever preflight claims VERIFIED', () => {
    const report = {
      storeId, storeConfigVersion: 2, credentialVersionId,
      sellerId: 'seller-1', checks: [], warehouses: [], permissions: [], limits: {},
      currencyVerified: true,
      currencyVerification: { status: 'VERIFIED' as const, currency: 'CNY' as const, evidence: {} },
      observedAt: '2026-08-11T00:00:00.000Z', ok: true
    };
    expect(ozonStorePreflightReportSchema.safeParse(report).success).toBe(true);
    expect(ozonStorePreflightReportSchema.safeParse({
      ...report, currencyVerification: { status: 'VERIFIED', evidence: {} }
    }).success).toBe(false);
  });
});

describe('OZON publication request contracts', () => {
  it('accepts draft/store scope for planning and requires an idempotent request identity for create', () => {
    expect(ozonPublicationPlanInputSchema.parse({ draftVersion: 7, storeIds: [storeId] }))
      .toEqual({ draftVersion: 7, storeIds: [storeId] });
    expect(ozonPublicationCreateInputSchema.parse({ draftVersion: 7, storeIds: [storeId], planHash: hash, requestId }))
      .toEqual({ draftVersion: 7, storeIds: [storeId], planHash: hash, requestId });

    expect(ozonPublicationPlanInputSchema.safeParse({
      draftVersion: 7,
      sku: '0000110',
      storeIds: [storeId]
    }).success).toBe(false);
    expect(ozonPublicationPlanInputSchema.safeParse({
      draftVersion: 7,
      storeIds: [storeId],
      stores: [{ storeId, presetId: publicationId }]
    }).success).toBe(false);
    expect(ozonPublicationCreateInputSchema.safeParse({
      draftVersion: 7,
      storeIds: [storeId],
      planHash: hash,
      requestId,
      presetId: publicationId
    }).success).toBe(false);
    expect(ozonPublicationCreateInputSchema.safeParse({ draftVersion: 7, storeIds: [storeId], planHash: hash }).success)
      .toBe(false);
    expect(ozonPublicationRecheckInputSchema.safeParse({ rowVersion: 3, planHash: hash, requestId }).success)
      .toBe(true);
  });
});

describe('OZON frozen content and preparation summary contracts', () => {
  it('accepts only executable policy versions and complete hash bindings', () => {
    expect(ozonFrozenContentBindingSchema.parse(frozenContent)).toEqual(frozenContent);
    expect(ozonFrozenContentBindingSchema.safeParse({ ...frozenContent, contentPolicyVersion: 'LEGACY_UNKNOWN' }).success)
      .toBe(false);
    expect(ozonFrozenContentBindingSchema.safeParse({ ...frozenContent, materialHash: 'bad' }).success).toBe(false);
  });

  it('freezes one publication/job identity and keeps plannedJobId equal to jobId', () => {
    const jobId = '88888888-8888-4888-8888-888888888888';
    const identity = { publicationId, jobId, plannedJobId: jobId, taskId: 'tek-plus__0000132__r2' };
    expect(ozonPublicationPlanItemAttemptIdentitySchema.parse(identity)).toEqual(identity);
    expect(ozonPublicationPlanItemAttemptIdentitySchema.safeParse({
      ...identity,
      plannedJobId: '99999999-9999-4999-8999-999999999999'
    }).success).toBe(false);

    expect(ozonPublicationCreateResultSchema.safeParse({
      publications: [{ id: publicationId, storeId, status: 'NEEDS_ATTENTION', errorCode: 'CONFIG_INVALID' }],
      results: [{ storeId, publicationId, status: 'NEEDS_ATTENTION', errorCode: 'CONFIG_INVALID', errorMessage: '店铺预设无效' }],
      accepted: 0,
      failed: 1
    }).success).toBe(true);
    expect(ozonPublicationCreateResultSchema.safeParse({
      publications: [{ id: publicationId, storeId, status: 'QUEUED' }],
      results: [{ storeId, publicationId, status: 'QUEUED' }],
      accepted: 0,
      failed: 0
    }).success).toBe(false);
  });

  it('keeps fan-out counts coherent and prevents direct replay while readback is required', () => {
    expect(ozonPreparationFanoutSummarySchema.safeParse({
      phase: 'COMPLETED', targetStoreCount: 2, publicationCount: 2, failureCount: 0,
      canRecheck: false, canManualTakeover: false, recoveryMode: 'NONE'
    }).success).toBe(true);
    expect(ozonPreparationFanoutSummarySchema.safeParse({
      phase: 'COMPLETED', targetStoreCount: 2, publicationCount: 1, failureCount: 1,
      canRecheck: true, canManualTakeover: true, recoveryMode: 'RECHECK'
    }).success).toBe(false);
    expect(ozonPreparationFanoutSummarySchema.safeParse({
      phase: 'NEEDS_ATTENTION', targetStoreCount: 2, publicationCount: 1, failureCount: 1,
      canRecheck: true, canManualTakeover: false, recoveryMode: 'READBACK_REQUIRED'
    }).success).toBe(false);
  });
});

describe('OZON store preflight dispatch contract', () => {
  const dispatch = {
    action: 'preflight' as const,
    storeId,
    storeAlias: 'tek-plus',
    rowVersion: 9,
    storeConfigVersion: 4,
    credentialVersionId,
    requestRef: `ozon-preflight:${storeId}:4:${credentialVersionId}:run-1`
  };

  it('locks the cross-layer action literal to preflight', () => {
    expect(ozonStorePreflightDispatchSchema.parse(dispatch)).toEqual(dispatch);
    expect(ozonStorePreflightDispatchSchema.safeParse({ ...dispatch, action: 'storePreflight' }).success).toBe(false);
    expect(ozonStorePreflightDispatchSchema.safeParse({ ...dispatch, apiKey: 'forbidden' }).success).toBe(false);
  });
});

describe('OZON gateway identity contract', () => {
  it('requires strict taskId XOR storeId and binds task requests to publicationId', () => {
    const leaseToken = '00000000-0000-4000-8000-000000000091';
    expect(ozonGatewayRequestSchema.safeParse({
      taskId: 'default__0000110__r1', publicationId, leaseToken, requestRef: 'request-1', operation: 'SELLER_INFO', payload: {}
    }).success).toBe(true);
    expect(ozonGatewayRequestSchema.safeParse({
      storeId, requestRef: 'preflight-1', operation: 'SELLER_INFO', payload: {}
    }).success).toBe(true);
    expect(ozonGatewayRequestSchema.safeParse({
      requestRef: 'missing', operation: 'SELLER_INFO', payload: {}
    }).success).toBe(false);
    expect(ozonGatewayRequestSchema.safeParse({
      taskId: 'task', storeId, publicationId, requestRef: 'both', operation: 'SELLER_INFO', payload: {}
    }).success).toBe(false);
    expect(ozonGatewayRequestSchema.safeParse({
      taskId: 'task', requestRef: 'missing-publication', operation: 'SELLER_INFO', payload: {}
    }).success).toBe(false);
    expect(ozonGatewayRequestSchema.safeParse({
      taskId: 'task', publicationId, requestRef: 'write-without-lease', operation: 'importProduct', payload: { items: [] }
    }).success).toBe(false);
    expect(ozonGatewayRequestSchema.safeParse({
      storeId, publicationId, requestRef: 'preflight-publication', operation: 'SELLER_INFO', payload: {}
    }).success).toBe(false);
    expect(ozonGatewayRequestSchema.safeParse({
      storeId, leaseToken, requestRef: 'preflight-lease', operation: 'SELLER_INFO', payload: {}
    }).success).toBe(false);
  });
});

describe('OZON legacy gateway receipt state matrix', () => {
  const base = {
    requestRef: 'legacy-receipt-1', operation: 'infoList', payloadHash: hash, result: {}
  };

  it('accepts only authoritative response, unknown, and not-sent combinations', () => {
    expect(ozonGatewayLegacyReceiptSchema.safeParse({
      ...base, statusCode: 200, deliveryState: 'RESPONDED', retryClass: 'NONE'
    }).success).toBe(true);
    expect(ozonGatewayLegacyReceiptSchema.safeParse({
      ...base, statusCode: 401, deliveryState: 'RESPONDED', retryClass: 'PERMANENT'
    }).success).toBe(true);
    expect(ozonGatewayLegacyReceiptSchema.safeParse({
      ...base, statusCode: 0, deliveryState: 'UNKNOWN', retryClass: 'READBACK_REQUIRED'
    }).success).toBe(true);
    expect(ozonGatewayLegacyReceiptSchema.safeParse({
      ...base, statusCode: 500, deliveryState: 'UNKNOWN', retryClass: 'READBACK_REQUIRED'
    }).success).toBe(true);
    expect(ozonGatewayLegacyReceiptSchema.safeParse({
      ...base, statusCode: 0, deliveryState: 'NOT_SENT', retryClass: 'RETRYABLE', retryAfterMs: 1_000
    }).success).toBe(true);
    expect(ozonGatewayLegacyReceiptSchema.safeParse({
      ...base, statusCode: 429, deliveryState: 'NOT_SENT', retryClass: 'RETRYABLE', retryAfterMs: 2_000
    }).success).toBe(true);
  });

  it.each([
    [{ statusCode: 200, deliveryState: 'UNKNOWN', retryClass: 'READBACK_REQUIRED' }],
    [{ statusCode: 200, deliveryState: 'NOT_SENT', retryClass: 'RETRYABLE' }],
    [{ statusCode: 200, deliveryState: 'RESPONDED', retryClass: 'RETRYABLE' }],
    [{ statusCode: 500, deliveryState: 'RESPONDED', retryClass: 'PERMANENT' }],
    [{ statusCode: 429, deliveryState: 'RESPONDED', retryClass: 'PERMANENT' }],
    [{ statusCode: 0, deliveryState: 'NOT_SENT', retryClass: 'NONE' }]
  ])('rejects forged delivery/retry/status combination %#', (candidate) => {
    expect(ozonGatewayLegacyReceiptSchema.safeParse({ ...base, ...candidate }).success).toBe(false);
  });

  it('never classifies an ambiguous legacy write 408/5xx as NOT_SENT', () => {
    for (const statusCode of [408, 500, 503]) {
      expect(ozonGatewayLegacyReceiptSchema.safeParse({
        ...base,
        operation: 'importProduct',
        statusCode,
        deliveryState: 'NOT_SENT',
        retryClass: 'RETRYABLE'
      }).success).toBe(false);
      expect(ozonGatewayLegacyReceiptSchema.safeParse({
        ...base,
        operation: 'importProduct',
        statusCode,
        deliveryState: 'UNKNOWN',
        retryClass: 'READBACK_REQUIRED'
      }).success).toBe(true);
    }
    for (const statusCode of [0, 425, 429]) {
      expect(ozonGatewayLegacyReceiptSchema.safeParse({
        ...base,
        operation: 'importProduct',
        statusCode,
        deliveryState: 'NOT_SENT',
        retryClass: 'RETRYABLE'
      }).success).toBe(true);
    }
  });
});

describe('OZON runtime transition binding contract', () => {
  const binding = {
    storeId,
    publicationId,
    credentialVersionId,
    credentialBindingMode: 'VAULT' as const,
    storeConfigVersion: 2,
    warehouseId: 'warehouse-1',
    offerContractHash: hash,
    materializationHash: hash,
    ...frozenContent,
    rowVersion: 9,
    leaseOwner: 'ozon-p002',
    leaseToken: '44444444-4444-4444-8444-444444444444'
  };

  it('requires CAS and lease fields and rejects unrecognized bypass fields', () => {
    expect(ozonRuntimeTransitionBindingSchema.parse(binding)).toEqual(binding);
    for (const field of ['rowVersion', 'leaseOwner', 'leaseToken'] as const) {
      const incomplete = { ...binding };
      delete incomplete[field];
      expect(ozonRuntimeTransitionBindingSchema.safeParse(incomplete).success, field).toBe(false);
    }
    expect(ozonRuntimeTransitionBindingSchema.safeParse({ ...binding, url: 'https://api-seller.ozon.ru' }).success)
      .toBe(false);
  });
});

describe('OZON runtime claim result contract', () => {
  const claimedJob = {
    id: '55555555-5555-4555-8555-555555555555',
    sku: '0000119', state: 'READY' as const, source: 'AUTO' as const,
    taskKind: 'STORE_PUBLICATION' as const,
    taskId: 'default__0000119__r2', storeId, storeAlias: 'default', publicationId, credentialVersionId,
    credentialBindingMode: 'VAULT' as const, storeConfigVersion: 4, warehouseId: '1020002456503000',
    offerContractHash: hash, materializationHash: hash, revision: 2, offerIds: ['0000119-01'],
    ...frozenContent,
    publicationContentPolicyVersion: frozenContent.contentPolicyVersion,
    publicationMaterialHash: frozenContent.materialHash,
    publicationMaterialHashVersion: frozenContent.materialHashVersion,
    planHash: `sha256:${'d'.repeat(64)}`,
    presetRowVersion: 7,
    publicationMode: 'COMPATIBLE_UPSERT' as const,
    payload: { productJsonPath: 'stores/default/inbox/0000119/product.json' }, stageStates: {},
    ozonProductLinks: [], taskFolder: '0000119__r2', workRelPath: 'stores/default/inbox/0000119',
    directoryStage: 'INBOX' as const, directorySignature: hash,
    rowVersion: 6, leaseOwner: 'ozon-p002:claim', leaseToken: '44444444-4444-4444-8444-444444444444',
    leaseExpiresAt: '2026-08-11T08:23:30.000Z', retryCount: 0
  };

  it('requires the exact frozen P002 snapshot including a positive top-level revision', () => {
    expect(ozonRuntimeClaimJobSchema.parse(claimedJob)).toEqual(claimedJob);
    expect(ozonRuntimeClaimResultSchema.parse({
      items: [claimedJob], globalConcurrency: 2, perStoreConcurrency: 1
    }).items[0]?.revision).toBe(2);

    const missingRevision: Partial<typeof claimedJob> = { ...claimedJob };
    delete missingRevision.revision;
    expect(ozonRuntimeClaimJobSchema.safeParse(missingRevision).success).toBe(false);
    expect(ozonRuntimeClaimJobSchema.safeParse({ ...claimedJob, revision: 0 }).success).toBe(false);
    expect(ozonRuntimeClaimJobSchema.safeParse({ ...claimedJob, taskId: 'default__0000119__r0' }).success).toBe(false);
    expect(ozonRuntimeClaimJobSchema.safeParse({ ...claimedJob, listing_revision: 2 }).success).toBe(false);
    expect(ozonRuntimeClaimJobSchema.safeParse({ ...claimedJob, offerIds: [] }).success).toBe(false);
    expect(ozonRuntimeClaimJobSchema.safeParse({ ...claimedJob, taskKind: 'SHARED_PREPARATION' }).success).toBe(false);
    expect(ozonRuntimeClaimJobSchema.safeParse({ ...claimedJob, contentPolicyVersion: 'LEGACY_UNKNOWN' }).success).toBe(false);
    expect(ozonRuntimeClaimJobSchema.safeParse({ ...claimedJob, publicationContentPolicyVersion: undefined }).success).toBe(false);
    expect(ozonRuntimeClaimJobSchema.safeParse({
      ...claimedJob,
      publicationContentPolicyVersion: 'merchroute-ozon-content-v2'
    }).success).toBe(false);
    expect(ozonRuntimeClaimJobSchema.safeParse({ ...claimedJob, publicationMaterialHash: undefined }).success).toBe(false);
    expect(ozonRuntimeClaimJobSchema.safeParse({
      ...claimedJob,
      publicationMaterialHash: `sha256:${'c'.repeat(64)}`
    }).success).toBe(false);
    expect(ozonRuntimeClaimJobSchema.safeParse({ ...claimedJob, publicationMaterialHashVersion: undefined }).success).toBe(false);
    expect(ozonRuntimeClaimJobSchema.safeParse({ ...claimedJob, planHash: undefined }).success).toBe(false);
    expect(ozonRuntimeClaimJobSchema.safeParse({ ...claimedJob, presetRowVersion: undefined }).success).toBe(false);
    expect(ozonRuntimeClaimJobSchema.safeParse({ ...claimedJob, publicationMode: undefined }).success).toBe(false);
    expect(ozonRuntimeClaimJobSchema.safeParse({
      ...claimedJob,
      payload: { ...claimedJob.payload, offerContractHash: `sha256:${'b'.repeat(64)}` }
    }).success).toBe(false);
    expect(ozonRuntimeClaimJobSchema.safeParse({
      ...claimedJob,
      payload: { ...claimedJob.payload, offerIds: ['0000119-02'] }
    }).success).toBe(false);
  });

  it('allows the schema-v3 binding hash alone but rejects a partial semantic dual-set projection', () => {
    expect(ozonRuntimeClaimJobSchema.safeParse({
      ...claimedJob,
      payload: {
        ...claimedJob.payload,
        schemaVersion: 3,
        mode: 'MULTISTORE_PUBLICATION',
        offerContractHash: claimedJob.offerContractHash
      }
    }).success).toBe(true);
    expect(ozonRuntimeClaimJobSchema.safeParse({
      ...claimedJob,
      payload: {
        ...claimedJob.payload,
        schemaVersion: 3,
        mode: 'MULTISTORE_PUBLICATION',
        offerContractHash: claimedJob.offerContractHash,
        expectedOfferIds: claimedJob.offerIds
      }
    }).success).toBe(false);
    expect(ozonRuntimeClaimJobSchema.safeParse({
      ...claimedJob,
      payload: { ...claimedJob.payload, offerContractHash: claimedJob.offerContractHash }
    }).success).toBe(false);
  });

  it('locks global two/per-store one and rejects duplicate-store batches', () => {
    expect(ozonRuntimeClaimResultSchema.safeParse({
      items: [claimedJob, { ...claimedJob, id: '66666666-6666-4666-8666-666666666666' }],
      globalConcurrency: 2,
      perStoreConcurrency: 1
    }).success).toBe(false);
    expect(ozonRuntimeClaimResultSchema.safeParse({
      items: [claimedJob], globalConcurrency: 3, perStoreConcurrency: 1
    }).success).toBe(false);
  });
});

describe('OZON intake signed marker contract', () => {
  it('requires all 17 frozen marker/job identity fields', () => {
    const intake = {
      jobId: '55555555-5555-4555-8555-555555555555',
      taskId: 'default__0000110__r1', storeId, storeAlias: 'default', publicationId,
      credentialVersionId, credentialBindingMode: 'VAULT', storeConfigVersion: 2, warehouseId: '123',
      sku: '0000110', revision: 1,
      productContentHash: hash, materializationHash: hash, offerContractHash: hash,
      ...frozenContent,
      planHash: hash, presetRowVersion: 4, publicationMode: 'CREATE_ONLY' as const,
      ticket: `hmac-sha256:${'b'.repeat(64)}`, rowVersion: 9,
      leaseToken: '44444444-4444-4444-8444-444444444444'
    };
    expect(ozonIntakeVerifySchema.safeParse(intake).success).toBe(true);
    const missingAlias = { ...intake } as Partial<typeof intake>;
    delete missingAlias.storeAlias;
    expect(ozonIntakeVerifySchema.safeParse(missingAlias).success).toBe(false);
    expect(ozonIntakeVerifySchema.safeParse({ ...intake, url: 'https://api-seller.ozon.ru' }).success).toBe(false);
  });
});
