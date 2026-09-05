import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, OZON_DEFAULT_STORE_ID } from '@n8n-media-review/shared';
import { registerOzonRoutes } from './ozon.js';

const apps: ReturnType<typeof Fastify>[] = [];
const originalRuntimeKey = process.env.MERCHROUTE_RUNTIME_KEY;

beforeEach(() => {
  process.env.MERCHROUTE_RUNTIME_KEY = 'ozon-runtime-test-key';
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  if (originalRuntimeKey === undefined) delete process.env.MERCHROUTE_RUNTIME_KEY;
  else process.env.MERCHROUTE_RUNTIME_KEY = originalRuntimeKey;
});

async function runtimeApp() {
  const app = Fastify();
  apps.push(app);
  const recordRuntimeUpdate = vi.fn(async (_id: string, input: unknown) => ({ job: input, mappings: [] }));
  const claimRuntimeJob = vi.fn(async (input: unknown) => ({ items: [{ id: 'job-claim', ...input as object }] }));
  const renewRuntimeLease = vi.fn(async (id: string, input: unknown) => ({ job: { id, ...input as object } }));
  const releaseRuntimeLease = vi.fn(async (id: string, input: unknown) => ({ job: { id, ...input as object } }));
  const listHistoricalNetworkRecoveryCandidates = vi.fn(async (limit?: number) => ({ items: [{ id: 'historical-network', limit }] }));
  const recoverHistoricalNetworkJob = vi.fn(async (id: string, rowVersion: number) => ({ job: { id, rowVersion } }));
  const recoverKnownPrePlatformFailure = vi.fn(async (id: string, input: unknown) => ({ id, ...input as object }));
  const recoverKnownPostPlatformMinPriceFailure = vi.fn(async (id: string, input: unknown) => ({ id, ...input as object }));
  const refreshPlatformStatus = vi.fn(async (sku: string, rowVersion: number) => ({ sku, rowVersion }));
  const initializeMissing = vi.fn(async (sku: string, rowVersion: number) => ({ sku, rowVersion }));
  const takeOverAutomaticPreparationForManual = vi.fn(async (input: unknown) => ({ job: input, listing: input }));
  const assertRuntimeBinding = vi.fn(async () => undefined);
  const assertLegacySkuRefreshAllowed = vi.fn(async () => undefined);
  const assertLegacyJobRouteAllowed = vi.fn(async () => undefined);
  const assertLegacyRecoveryAllowed = vi.fn(async () => undefined);
  const automaticListingSnapshot = vi.fn(async (jobId: string, storeId: string) => ({
    mode: 'AUTO_TASK_SNAPSHOT', readOnly: true, jobId, storeId
  }));
  const getAutomaticJob = vi.fn(async (id: string) => ({ id, storeId: OZON_DEFAULT_STORE_ID }));
  const cancelAutomaticJob = vi.fn(async (id: string) => ({ id, storeId: OZON_DEFAULT_STORE_ID, state: 'CANCELED' }));
  const recheckAutomaticJob = vi.fn(async (id: string, expectedRowVersion?: number) => ({
    id, storeId: OZON_DEFAULT_STORE_ID, state: 'READY', expectedRowVersion
  }));
  const preparationManualSuccessReconcilePlan = vi.fn(async (id: string, input: unknown) => ({ plan: { id, ...input as object } }));
  const reconcilePreparationToManualSuccess = vi.fn(async (id: string, input: unknown) => ({ job: { id }, reconciliation: input }));
  const listAutomaticJobs = vi.fn(async (input: unknown) => ({ items: [], total: 0, page: 1, pageSize: 20, input }));
  const claimRuntimeJobs = vi.fn(async (input: unknown) => {
    const body = input as { limit?: number } & Record<string, unknown>;
    const legacyInput = { ...body };
    delete legacyInput.limit;
    await claimRuntimeJob(legacyInput);
    return { items: [{ id: 'job-claim', ...body }] };
  });
  await registerOzonRoutes(app, {
    ozon: {} as any,
    ozonStores: {
      repository: { assertRuntimeBinding, assertLegacySkuRefreshAllowed, assertLegacyJobRouteAllowed, retries: { assertLegacyRecoveryAllowed } },
      claimRuntimeJobs,
      automaticListingSnapshot
    } as any,
    ozonPublishing: {
      recordRuntimeUpdate,
      claimRuntimeJob,
      renewRuntimeLease,
      releaseRuntimeLease,
      listHistoricalNetworkRecoveryCandidates,
      recoverHistoricalNetworkJob,
      recoverKnownPrePlatformFailure,
      recoverKnownPostPlatformMinPriceFailure,
      refreshPlatformStatus,
      initializeMissing,
      takeOverAutomaticPreparationForManual
    } as any,
    ozonAutoPublishing: {
      list: listAutomaticJobs,
      get: getAutomaticJob,
      cancel: cancelAutomaticJob,
      recheck: recheckAutomaticJob,
      preparationManualSuccessReconcilePlan,
      reconcilePreparationToManualSuccess
    } as any,
    ozonCatalog: {} as any,
    pricing: {} as any,
    shipping: {} as any,
    config: {} as any
  });
  return {
    app,
    recordRuntimeUpdate,
    claimRuntimeJob,
    renewRuntimeLease,
    releaseRuntimeLease,
    listHistoricalNetworkRecoveryCandidates,
    recoverHistoricalNetworkJob,
    recoverKnownPrePlatformFailure,
    recoverKnownPostPlatformMinPriceFailure,
    refreshPlatformStatus,
    initializeMissing,
    takeOverAutomaticPreparationForManual,
    assertRuntimeBinding,
    assertLegacySkuRefreshAllowed,
    assertLegacyJobRouteAllowed,
    assertLegacyRecoveryAllowed,
    automaticListingSnapshot,
    getAutomaticJob,
    cancelAutomaticJob,
    recheckAutomaticJob,
    preparationManualSuccessReconcilePlan,
    reconcilePreparationToManualSuccess,
    listAutomaticJobs,
    claimRuntimeJobs
  };
}

const runtimeHeaders = { 'x-merchroute-runtime-key': 'ozon-runtime-test-key' };
const leaseToken = '00000000-0000-4000-8000-000000000091';
const baseTransition = {
  storeId: OZON_DEFAULT_STORE_ID,
  publicationId: '10000000-0000-4000-8000-000000000001',
  credentialVersionId: '20000000-0000-4000-8000-000000000001',
  credentialBindingMode: 'VAULT',
  storeConfigVersion: 1,
  warehouseId: '123',
  offerContractHash: `sha256:${'1'.repeat(64)}`,
  materializationHash: `sha256:${'2'.repeat(64)}`,
  contentPolicyVersion: 'merchroute-ozon-content-v3',
  materialHash: `sha256:${'3'.repeat(64)}`,
  materialHashVersion: 'ozon-shared-material-v1',
  rowVersion: 6,
  leaseOwner: 'ozon-p002:execution-41',
  leaseToken,
  state: 'IMPORTING',
  eventType: 'OZON_PRICE_STOCK_WRITE_DEFERRED',
  message: '等待平台审核完成后重试库存'
};

describe('OZON automatic business-list HTTP contract', () => {
  it('blocks the old recheck while a single-store retry owns the job', async () => {
    const { app, assertLegacyRecoveryAllowed, getAutomaticJob, recheckAutomaticJob } = await runtimeApp();
    assertLegacyRecoveryAllowed.mockRejectedValueOnce(new AppError('VERSION_CONFLICT', '任务已由单店重试接管', undefined, 409));
    const response = await app.inject({ method: 'POST', url: '/api/v1/ozon/automation/jobs/owned-job/recheck', payload: { storeId: OZON_DEFAULT_STORE_ID } });
    expect(response.statusCode).toBe(409);
    expect(assertLegacyRecoveryAllowed).toHaveBeenCalledWith('owned-job');
    expect(getAutomaticJob).not.toHaveBeenCalled(); expect(recheckAutomaticJob).not.toHaveBeenCalled();
  });
  it('forwards the explicit businessOnly filter and rejects malformed values', async () => {
    const { app, listAutomaticJobs } = await runtimeApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/ozon/automation/jobs?query=0000120&businessOnly=true'
    });
    expect(response.statusCode).toBe(200);
    expect(listAutomaticJobs).toHaveBeenCalledWith(expect.objectContaining({
      query: '0000120',
      businessOnly: true
    }));

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/v1/ozon/automation/jobs?businessOnly=yes'
    });
    expect(invalid.statusCode).toBe(400);
    expect(listAutomaticJobs).toHaveBeenCalledTimes(1);
  });

  it('registers the store-scoped automatic listing snapshot route and returns the shared envelope', async () => {
    const { app, automaticListingSnapshot } = await runtimeApp();
    const jobId = '50000000-0000-4000-8000-000000000041';
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/ozon/automation/jobs/${jobId}/listing-snapshot?storeId=${OZON_DEFAULT_STORE_ID}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ snapshot: {
      mode: 'AUTO_TASK_SNAPSHOT', readOnly: true, jobId, storeId: OZON_DEFAULT_STORE_ID
    } });
    expect(automaticListingSnapshot).toHaveBeenCalledWith(jobId, OZON_DEFAULT_STORE_ID);

    const invalid = await app.inject({
      method: 'GET',
      url: `/api/v1/ozon/automation/jobs/${jobId}/listing-snapshot?storeId=not-a-uuid`
    });
    expect(invalid.statusCode).toBe(400);
    expect(automaticListingSnapshot).toHaveBeenCalledTimes(1);
  });

  it('forwards the read-only manual-success plan and the CAS reconciliation request', async () => {
    const {
      app,
      preparationManualSuccessReconcilePlan,
      reconcilePreparationToManualSuccess
    } = await runtimeApp();
    const jobId = '50000000-0000-4000-8000-000000000099';
    const plan = await app.inject({
      method: 'GET',
      url: `/api/v1/ozon/automation/jobs/${jobId}/manual-success-reconcile-plan?rowVersion=34`
    });
    expect(plan.statusCode).toBe(200);
    expect(preparationManualSuccessReconcilePlan).toHaveBeenCalledWith(jobId, { rowVersion: 34 });

    const input = {
      rowVersion: 34,
      planHash: `sha256:${'a'.repeat(64)}`,
      requestId: '00000000-0000-5000-8000-000000000099'
    };
    const applied = await app.inject({
      method: 'POST',
      url: `/api/v1/ozon/automation/jobs/${jobId}/manual-success-reconcile`,
      payload: input
    });
    expect(applied.statusCode).toBe(200);
    expect(reconcilePreparationToManualSuccess).toHaveBeenCalledWith(jobId, input);
  });

  it('preserves the stable no-fallback artifact error as HTTP 409', async () => {
    const { app, automaticListingSnapshot } = await runtimeApp();
    automaticListingSnapshot.mockRejectedValueOnce(new AppError(
      'OZON_FROZEN_ARTIFACT_UNAVAILABLE',
      'OZON 自动任务冻结资料不可用，请刷新任务状态后重试',
      { noFallback: true },
      409
    ));
    app.setErrorHandler((error, _request, reply) => {
      const appError = error instanceof AppError
        ? error
        : new AppError('INTERNAL_ERROR', error.message, undefined, 500);
      void reply.status(appError.statusCode).send({
        error: { code: appError.code, message: appError.message, details: appError.details }
      });
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/ozon/automation/jobs/50000000-0000-4000-8000-000000000041/listing-snapshot?storeId=${OZON_DEFAULT_STORE_ID}`
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: {
      code: 'OZON_FROZEN_ARTIFACT_UNAVAILABLE',
      details: { noFallback: true }
    } });
  });
});

describe('OZON runtime transition HTTP contract', () => {
  it('fails closed without the runtime key or immutable store/publication/lease binding', async () => {
    const { app, recordRuntimeUpdate, assertRuntimeBinding } = await runtimeApp();
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/job-auth/transition',
      payload: baseTransition
    });
    expect(unauthorized.statusCode).toBe(401);

    const invalidBinding = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/job-binding/transition',
      headers: runtimeHeaders,
      payload: { rowVersion: 1, state: 'READY', leaseOwner: 'worker', leaseToken }
    });
    expect(invalidBinding.statusCode).toBe(400);
    expect(assertRuntimeBinding).not.toHaveBeenCalled();
    expect(recordRuntimeUpdate).not.toHaveBeenCalled();
  });

  it('normalizes a retry date and forwards incrementRetry, while absent and null dates keep distinct meanings', async () => {
    const { app, recordRuntimeUpdate } = await runtimeApp();

    const scheduled = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/job-1/transition',
      headers: runtimeHeaders,
      payload: {
        ...baseTransition,
        nextAttemptAt: '2026-08-06T10:15:00+08:00',
        incrementRetry: true
      }
    });
    expect(scheduled.statusCode).toBe(200);
    expect(recordRuntimeUpdate).toHaveBeenNthCalledWith(1, 'job-1', expect.objectContaining({
      nextAttemptAt: '2026-08-06T02:15:00.000Z',
      incrementRetry: true
    }));

    const preserved = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/job-2/transition',
      headers: runtimeHeaders,
      payload: baseTransition
    });
    expect(preserved.statusCode).toBe(200);
    expect(recordRuntimeUpdate).toHaveBeenNthCalledWith(2, 'job-2', expect.objectContaining({
      nextAttemptAt: undefined,
      incrementRetry: undefined
    }));

    const cleared = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/job-3/transition',
      headers: runtimeHeaders,
      payload: { ...baseTransition, nextAttemptAt: null, incrementRetry: false }
    });
    expect(cleared.statusCode).toBe(200);
    expect(recordRuntimeUpdate).toHaveBeenNthCalledWith(3, 'job-3', expect.objectContaining({
      nextAttemptAt: null,
      incrementRetry: false
    }));
  });

  it('rejects an invalid retry date or a non-boolean incrementRetry', async () => {
    const { app, recordRuntimeUpdate } = await runtimeApp();

    const invalidDate = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/job-4/transition',
      headers: runtimeHeaders,
      payload: { ...baseTransition, nextAttemptAt: 'not-a-date' }
    });
    expect(invalidDate.statusCode).toBe(400);
    expect(invalidDate.json()).toMatchObject({ message: 'nextAttemptAt 必须是有效日期或 null' });

    const invalidBoolean = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/job-5/transition',
      headers: runtimeHeaders,
      payload: { ...baseTransition, incrementRetry: 'true' }
    });
    expect(invalidBoolean.statusCode).toBe(400);
    expect(invalidBoolean.json()).toMatchObject({ message: 'incrementRetry 必须是布尔值' });
    expect(recordRuntimeUpdate).not.toHaveBeenCalled();
  });

  it('forwards audit suppression and per-offer status snapshots without flattening them', async () => {
    const { app, recordRuntimeUpdate } = await runtimeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/job-status/transition',
      headers: runtimeHeaders,
      payload: {
        ...baseTransition,
        auditSuppressed: true,
        productMappings: [{
          offerId: '0000090-01',
          ozonProductId: '501',
          ozonSku: '9001',
          platformStatus: 'ON_SALE',
          statusSnapshot: {
            displayState: 'ON_SALE', businessState: 'PUBLISHED', readAt: '2026-08-06T02:15:00.000Z', missingConfirmationCount: 0
          }
        }]
      }
    });
    expect(response.statusCode).toBe(200);
    expect(recordRuntimeUpdate).toHaveBeenCalledWith('job-status', expect.objectContaining({
      auditSuppressed: true,
      productMappings: [expect.objectContaining({
        offerId: '0000090-01',
        statusSnapshot: expect.objectContaining({ displayState: 'ON_SALE', businessState: 'PUBLISHED' })
      })]
    }));
  });

  it('claims one platform write slot and forwards lease fencing plus network recovery transitions', async () => {
    const { app, claimRuntimeJob, renewRuntimeLease, releaseRuntimeLease, recordRuntimeUpdate } = await runtimeApp();
    const claim = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/claim',
      headers: runtimeHeaders,
      payload: { leaseOwner: 'ozon-p002:execution-41', limit: 1, leaseSeconds: 600, states: ['READY', 'IMPORTING'] }
    });
    expect(claim.statusCode).toBe(200);
    expect(claimRuntimeJob).toHaveBeenCalledWith({
      leaseOwner: 'ozon-p002:execution-41',
      leaseSeconds: 600,
      states: ['READY', 'IMPORTING']
    });

    const renew = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/job-claim/lease/renew',
      headers: runtimeHeaders,
      payload: { leaseOwner: 'ozon-p002:execution-41', leaseToken, rowVersion: 8, leaseSeconds: 600 }
    });
    expect(renew.statusCode).toBe(200);
    expect(renewRuntimeLease).toHaveBeenCalledWith('job-claim', {
      leaseOwner: 'ozon-p002:execution-41', leaseToken, rowVersion: 8, leaseSeconds: 600
    });

    const recovery = {
      schemaVersion: 1,
      status: 'WAITING_NETWORK',
      phase: 'IMPORT_READBACK',
      resumeState: 'IMPORTING',
      deliveryState: 'UNKNOWN',
      attempt: 4,
      firstFailureAt: '2026-08-07T01:00:00.000Z',
      lastFailureAt: '2026-08-07T01:06:00.000Z',
      nextAttemptAt: '2026-08-07T01:21:00.000Z',
      errorCode: 'ETIMEDOUT',
      errorMessage: 'OZON readback timed out'
    };
    const transition = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/job-claim/transition',
      headers: runtimeHeaders,
      payload: {
        ...baseTransition,
        rowVersion: 8,
        leaseOwner: 'ozon-p002:execution-41',
        leaseToken,
        clearLease: true,
        networkRecovery: recovery,
        nextAttemptAt: recovery.nextAttemptAt
      }
    });
    expect(transition.statusCode).toBe(200);
    expect(recordRuntimeUpdate).toHaveBeenCalledWith('job-claim', expect.objectContaining({
      leaseOwner: 'ozon-p002:execution-41',
      leaseToken,
      clearLease: true,
      networkRecovery: recovery,
      nextAttemptAt: recovery.nextAttemptAt
    }));

    const release = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/job-claim/lease/release',
      headers: runtimeHeaders,
      payload: { leaseOwner: 'ozon-p002:execution-41', leaseToken, rowVersion: 9 }
    });
    expect(release.statusCode).toBe(200);
    expect(releaseRuntimeLease).toHaveBeenCalledWith('job-claim', {
      leaseOwner: 'ozon-p002:execution-41', leaseToken, rowVersion: 9
    });
  });

  it('exposes a read-only historical candidate list and a row-version fenced recovery action', async () => {
    process.env.MERCHROUTE_RUNTIME_KEY = 'ozon-recovery-test-key';
    const { app, listHistoricalNetworkRecoveryCandidates, recoverHistoricalNetworkJob } = await runtimeApp();
    const candidates = await app.inject({
      method: 'GET',
      url: '/api/v1/ozon/runtime/network-recovery-candidates?limit=25',
      headers: { 'x-merchroute-runtime-key': 'ozon-recovery-test-key' }
    });
    expect(candidates.statusCode).toBe(200);
    expect(listHistoricalNetworkRecoveryCandidates).toHaveBeenCalledWith(25);

    const recovery = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/historical-network/recover-network',
      headers: { 'x-merchroute-runtime-key': 'ozon-recovery-test-key' },
      payload: { rowVersion: 17 }
    });
    expect(recovery.statusCode).toBe(200);
    expect(recoverHistoricalNetworkJob).toHaveBeenCalledWith('historical-network', 17);
  });

  it('protects known pre-platform recovery with the runtime key and defaults to dry-run', async () => {
    process.env.MERCHROUTE_RUNTIME_KEY = 'ozon-recovery-test-key';
    const { app, recoverKnownPrePlatformFailure } = await runtimeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/job-105/recover-known-pre-platform-failure',
      headers: { 'x-merchroute-runtime-key': 'ozon-recovery-test-key' },
      payload: {
        reason: 'DESCRIPTION_KEYWORD_STUFFING_FALSE_POSITIVE_V1_TO_V2',
        rowVersion: 22,
        listingRowVersion: 4
      }
    });

    expect(response.statusCode).toBe(200);
    expect(recoverKnownPrePlatformFailure).toHaveBeenCalledWith('job-105', {
      reason: 'DESCRIPTION_KEYWORD_STUFFING_FALSE_POSITIVE_V1_TO_V2',
      rowVersion: 22,
      listingRowVersion: 4,
      dryRun: true
    });
  });

  it('forwards an explicit title-recovery apply and rejects invalid reason or dryRun types', async () => {
    process.env.MERCHROUTE_RUNTIME_KEY = 'ozon-recovery-test-key';
    const { app, recoverKnownPrePlatformFailure } = await runtimeApp();
    const applied = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/job-107/recover-known-pre-platform-failure',
      headers: { 'x-merchroute-runtime-key': 'ozon-recovery-test-key' },
      payload: {
        reason: 'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200',
        rowVersion: 59,
        dryRun: false
      }
    });
    expect(applied.statusCode).toBe(200);
    expect(recoverKnownPrePlatformFailure).toHaveBeenCalledWith('job-107', {
      reason: 'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200',
      rowVersion: 59,
      dryRun: false
    });

    const invalidReason = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/job-107/recover-known-pre-platform-failure',
      headers: { 'x-merchroute-runtime-key': 'ozon-recovery-test-key' },
      payload: { reason: 'UNKNOWN_REASON', rowVersion: 59 }
    });
    const invalidDryRun = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/job-107/recover-known-pre-platform-failure',
      headers: { 'x-merchroute-runtime-key': 'ozon-recovery-test-key' },
      payload: { reason: 'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200', rowVersion: 59, dryRun: 'false' }
    });
    expect(invalidReason.statusCode).toBe(400);
    expect(invalidDryRun.statusCode).toBe(400);
    expect(recoverKnownPrePlatformFailure).toHaveBeenCalledTimes(1);
  });

  it('blocks known pre-platform recovery when the runtime key is unconfigured or invalid', async () => {
    delete process.env.MERCHROUTE_RUNTIME_KEY;
    const unconfigured = await runtimeApp();
    const unavailable = await unconfigured.app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/job-105/recover-known-pre-platform-failure',
      payload: { reason: 'IMPORT_INTENT_URL_MISSING', rowVersion: 22, listingRowVersion: 4 }
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unconfigured.recoverKnownPrePlatformFailure).not.toHaveBeenCalled();

    process.env.MERCHROUTE_RUNTIME_KEY = 'ozon-recovery-test-key';
    const invalid = await runtimeApp();
    const unauthorized = await invalid.app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/job-105/recover-known-pre-platform-failure',
      headers: { 'x-merchroute-runtime-key': 'wrong-key' },
      payload: { reason: 'IMPORT_INTENT_URL_MISSING', rowVersion: 22, listingRowVersion: 4 }
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(invalid.recoverKnownPrePlatformFailure).not.toHaveBeenCalled();
  });

  it('protects the known post-platform min-price recovery route and defaults to dry-run', async () => {
    process.env.MERCHROUTE_RUNTIME_KEY = 'ozon-recovery-test-key';
    const { app, recoverKnownPostPlatformMinPriceFailure } = await runtimeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/50bff6f2-9801-4080-8183-2b37b4953d13/recover-known-post-platform-min-price-failure',
      headers: { 'x-merchroute-runtime-key': 'ozon-recovery-test-key' },
      payload: {
        reason: 'MIN_PRICE_WRITE_OMITTED_V1',
        rowVersion: 45,
        listingRowVersion: 12
      }
    });
    expect(response.statusCode).toBe(200);
    expect(recoverKnownPostPlatformMinPriceFailure).toHaveBeenCalledWith(
      '50bff6f2-9801-4080-8183-2b37b4953d13',
      {
        reason: 'MIN_PRICE_WRITE_OMITTED_V1',
        rowVersion: 45,
        listingRowVersion: 12,
        dryRun: true
      }
    );

    const invalidReason = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/50bff6f2-9801-4080-8183-2b37b4953d13/recover-known-post-platform-min-price-failure',
      headers: { 'x-merchroute-runtime-key': 'ozon-recovery-test-key' },
      payload: { reason: 'IMPORT_INTENT_URL_MISSING', rowVersion: 45, listingRowVersion: 12 }
    });
    expect(invalidReason.statusCode).toBe(400);
    expect(recoverKnownPostPlatformMinPriceFailure).toHaveBeenCalledTimes(1);
  });

  it('rejects missing/invalid runtime keys for known post-platform min-price recovery', async () => {
    delete process.env.MERCHROUTE_RUNTIME_KEY;
    const unavailable = await runtimeApp();
    const unavailableResponse = await unavailable.app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/d7938c88-500d-4b75-914c-4602e1640ca3/recover-known-post-platform-min-price-failure',
      payload: { reason: 'MIN_PRICE_WRITE_OMITTED_V1', rowVersion: 37, listingRowVersion: 10 }
    });
    expect(unavailableResponse.statusCode).toBe(503);
    expect(unavailable.recoverKnownPostPlatformMinPriceFailure).not.toHaveBeenCalled();

    process.env.MERCHROUTE_RUNTIME_KEY = 'ozon-recovery-test-key';
    const unauthorized = await runtimeApp();
    const unauthorizedResponse = await unauthorized.app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/7c525f2c-a52c-475c-b8f5-a99ab61b348f/recover-known-post-platform-min-price-failure',
      headers: { 'x-merchroute-runtime-key': 'wrong-key' },
      payload: { reason: 'MIN_PRICE_WRITE_OMITTED_V1', rowVersion: 72, listingRowVersion: 6 }
    });
    expect(unauthorizedResponse.statusCode).toBe(401);
    expect(unauthorized.recoverKnownPostPlatformMinPriceFailure).not.toHaveBeenCalled();
  });

  it('returns 503 for both historical recovery endpoints when the runtime key is not configured', async () => {
    delete process.env.MERCHROUTE_RUNTIME_KEY;
    const { app, listHistoricalNetworkRecoveryCandidates, recoverHistoricalNetworkJob } = await runtimeApp();

    const candidates = await app.inject({
      method: 'GET',
      url: '/api/v1/ozon/runtime/network-recovery-candidates'
    });
    expect(candidates.statusCode).toBe(503);

    const recovery = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/historical-network/recover-network',
      payload: { rowVersion: 17 }
    });
    expect(recovery.statusCode).toBe(503);
    expect(listHistoricalNetworkRecoveryCandidates).not.toHaveBeenCalled();
    expect(recoverHistoricalNetworkJob).not.toHaveBeenCalled();
  });

  it('returns 401 for both historical recovery endpoints when the runtime key is missing or invalid', async () => {
    process.env.MERCHROUTE_RUNTIME_KEY = 'ozon-recovery-test-key';
    const { app, listHistoricalNetworkRecoveryCandidates, recoverHistoricalNetworkJob } = await runtimeApp();

    const candidates = await app.inject({
      method: 'GET',
      url: '/api/v1/ozon/runtime/network-recovery-candidates'
    });
    expect(candidates.statusCode).toBe(401);

    const recovery = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/runtime/jobs/historical-network/recover-network',
      headers: { 'x-merchroute-runtime-key': 'wrong-key' },
      payload: { rowVersion: 17 }
    });
    expect(recovery.statusCode).toBe(401);
    expect(listHistoricalNetworkRecoveryCandidates).not.toHaveBeenCalled();
    expect(recoverHistoricalNetworkJob).not.toHaveBeenCalled();
  });

  it('validates the refresh rowVersion and forwards the SKU unchanged', async () => {
    const { app, refreshPlatformStatus, assertLegacySkuRefreshAllowed } = await runtimeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/listings/0000090/platform-status/refresh',
      payload: { rowVersion: 8 }
    });
    expect(response.statusCode).toBe(200);
    expect(assertLegacySkuRefreshAllowed).toHaveBeenCalledWith('0000090');
    expect(refreshPlatformStatus).toHaveBeenCalledWith('0000090', 8);

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/listings/0000090/platform-status/refresh',
      payload: { rowVersion: 0 }
    });
    expect(invalid.statusCode).toBe(400);
    expect(refreshPlatformStatus).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the storeless SKU refresh targets a multistore publication', async () => {
    const { app, refreshPlatformStatus, assertLegacySkuRefreshAllowed } = await runtimeApp();
    assertLegacySkuRefreshAllowed.mockRejectedValueOnce(new AppError(
      'CONFIG_INVALID',
      '多店铺 publication 必须按 publicationId 同步',
      undefined,
      409
    ));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/listings/0000090/platform-status/refresh',
      payload: { rowVersion: 8 }
    });
    expect(response.statusCode).toBe(409);
    expect(refreshPlatformStatus).not.toHaveBeenCalled();
  });

  it('retires the legacy SKU write routes in favor of store-scoped publication APIs', async () => {
    const { app } = await runtimeApp();
    for (const [method, suffix] of [
      ['POST', 'generate'], ['POST', 'submit'], ['GET', 'compatible-append-plan'], ['POST', 'compatible-append']
    ] as const) {
      const response = await app.inject({
        method,
        url: `/api/v1/ozon/listings/0000090/${suffix}`,
        ...(method === 'POST' ? { payload: { rowVersion: 1 } } : {})
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'OZON_PUBLICATION_REQUIRED' });
    }
  });

  it('blocks publication/Vault jobs from all legacy SKU job detail/action routes', async () => {
    const { app, assertLegacyJobRouteAllowed } = await runtimeApp();
    assertLegacyJobRouteAllowed.mockRejectedValue(new AppError(
      'OZON_PUBLICATION_REQUIRED', '必须使用 publication API', undefined, 409
    ));
    for (const [method, suffix, action] of [
      ['GET', '', 'DETAIL'], ['POST', '/cancel', 'CANCEL'], ['POST', '/recheck', 'RECHECK'],
      ['POST', '/return-to-edit', 'RETURN_TO_EDIT']
    ] as const) {
      const response = await app.inject({
        method,
        url: `/api/v1/ozon/listings/0000090/jobs/job-publication${suffix}`,
        ...(method === 'POST' ? { payload: { rowVersion: 1, jobRowVersion: 1, listingRowVersion: 1 } } : {})
      });
      expect(response.statusCode).toBe(409);
      expect(assertLegacyJobRouteAllowed).toHaveBeenCalledWith('job-publication', action);
    }
  });

  it('blocks publication-backed AUTO jobs from the legacy automatic cancel/recheck routes', async () => {
    const { app, assertLegacyJobRouteAllowed, cancelAutomaticJob, recheckAutomaticJob } = await runtimeApp();
    assertLegacyJobRouteAllowed.mockRejectedValue(new AppError(
      'OZON_PUBLICATION_REQUIRED', '必须使用 publication API', { publicationWorkflowRequired: true }, 409
    ));
    for (const [suffix, action] of [['cancel', 'CANCEL'], ['recheck', 'RECHECK']] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/ozon/automation/jobs/job-auto-publication/${suffix}`,
        payload: { storeId: OZON_DEFAULT_STORE_ID }
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'OZON_PUBLICATION_REQUIRED' });
      expect(assertLegacyJobRouteAllowed).toHaveBeenCalledWith('job-auto-publication', action);
    }
    expect(cancelAutomaticJob).not.toHaveBeenCalled();
    expect(recheckAutomaticJob).not.toHaveBeenCalled();
  });

  it('passes the repository rowVersion authorization into an exact preparation recheck', async () => {
    const { app, assertLegacyJobRouteAllowed, recheckAutomaticJob } = await runtimeApp();
    assertLegacyJobRouteAllowed.mockResolvedValueOnce({ expectedRowVersion: 12 });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/automation/jobs/c3ac35ed-0000-4000-8000-000000000001/recheck',
      payload: { storeId: OZON_DEFAULT_STORE_ID }
    });

    expect(response.statusCode).toBe(200);
    expect(assertLegacyJobRouteAllowed).toHaveBeenCalledWith(
      'c3ac35ed-0000-4000-8000-000000000001',
      'RECHECK'
    );
    expect(recheckAutomaticJob).toHaveBeenCalledWith(
      'c3ac35ed-0000-4000-8000-000000000001',
      12
    );
  });

  it('forwards initialize-missing with the rowVersion and returns a listing envelope', async () => {
    const { app, initializeMissing } = await runtimeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/listings/0000094/initialize-missing',
      payload: { rowVersion: 3 }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ listing: { sku: '0000094', rowVersion: 3 } });
    expect(initializeMissing).toHaveBeenCalledWith('0000094', 3);

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/listings/0000094/initialize-missing',
      payload: { rowVersion: 0 }
    });
    expect(invalid.statusCode).toBe(400);
    expect(initializeMissing).toHaveBeenCalledTimes(1);
  });

  it('forwards an explicit preparation manual-takeover with both CAS versions', async () => {
    const { app, takeOverAutomaticPreparationForManual } = await runtimeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/listings/0000121/preparations/096f4dec-b56b-43f8-bfba-8bed0c8392a9/manual-takeover',
      payload: { jobRowVersion: 7, listingRowVersion: 3 }
    });
    expect(response.statusCode).toBe(200);
    expect(takeOverAutomaticPreparationForManual).toHaveBeenCalledWith({
      sku: '0000121',
      jobId: '096f4dec-b56b-43f8-bfba-8bed0c8392a9',
      jobRowVersion: 7,
      listingRowVersion: 3
    });

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/listings/0000121/preparations/096f4dec-b56b-43f8-bfba-8bed0c8392a9/manual-takeover',
      payload: { jobRowVersion: 0, listingRowVersion: 3 }
    });
    expect(invalid.statusCode).toBe(400);
    expect(takeOverAutomaticPreparationForManual).toHaveBeenCalledTimes(1);
  });
});
