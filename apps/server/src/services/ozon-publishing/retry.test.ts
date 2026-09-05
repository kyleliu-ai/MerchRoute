import { describe, expect, it, vi } from 'vitest';
import { retryFixture } from '../../../../../tests/fixtures/ozon-retry.js';
import { retryHash } from '../../repositories/ozon-retry.js';
import { buildOzonRetryPlan, ozonRetryResume, OzonPublishRetryService } from './retry.js';

describe('OZON explicit single-store retry', () => {
  it('keeps a valid immutable product and original identity', () => {
    const s = retryFixture();
    expect(buildOzonRetryPlan(s)).toMatchObject({ canRetry: true, mode: 'RESUME', requiresConfirmation: false, sourceJobId: s.job.id });
    expect(ozonRetryResume(s)).toEqual({ state: 'READY', payload: {} });
  });
  it('hashes durable JSON dates identically before and after restart', () => {
    const s = retryFixture();
    expect(retryHash(s)).toBe(retryHash(JSON.parse(JSON.stringify(s))));
  });
  it('blocks stale frozen credentials and jobs the executor would never claim', () => {
    for (const mutate of [
      (s: any) => { s.credentials[0].validated_at = new Date(0); },
      (s: any) => { s.credentials[0].status = 'REVOKED'; },
      (s: any) => { delete s.job.payload.planHash; },
      (s: any) => { s.job.payload.presetRowVersion = 2; },
      (s: any) => { s.job.credential_version_id = 'different'; }
    ]) { const s = retryFixture(); mutate(s); expect(buildOzonRetryPlan(s).canRetry).toBe(false); }
  });
  it.each(['missing', 'invalid'])('requires confirmation to rebuild %s store product', variant => {
    const s = retryFixture(); s.preset = { row_version: 2 };
    s.publication!.materialized_product_snapshot = variant === 'missing' ? {} : { titleRu: 'invalid' };
    expect(buildOzonRetryPlan(s)).toMatchObject({ canRetry: true, mode: 'REBUILD', requiresConfirmation: true });
  });
  it.each(['import_task_id', 'ozon_product_id', 'UNKNOWN', 'RESPONDED', 'intent', 'directory', 'mapping'])('never returns %s remote evidence to first-publish', evidence => {
    const s = retryFixture();
    if (evidence === 'UNKNOWN' || evidence === 'RESPONDED') s.gateways = [{ operation: 'importProduct', delivery_state: evidence }];
    else if (evidence === 'intent') s.job.payload.importIntent = { offerIds: s.job.offer_ids };
    else if (evidence === 'directory') s.job.directory_stage = 'PROCESSING';
    else if (evidence === 'mapping') s.publication!.product_ids = ['501'];
    else s.job[evidence] = '123';
    expect(buildOzonRetryPlan(s)).toMatchObject({ mode: 'READBACK', canRetry: true });
    expect(ozonRetryResume(s).state).toBe('IMPORTING');
    s.publication!.materialized_product_snapshot = {};
    expect(buildOzonRetryPlan(s)).toMatchObject({ canRetry: false, mode: 'READBACK' });
  });
  it('preserves succeeded offers and retries only classified transient failures', () => {
    const s = retryFixture(); s.job.import_task_id = '123';
    const [a, b] = s.job.offer_ids;
    s.job.payload.priceStockWriteProgress = {
      pricesWrite: { succeededOfferIds: [a], pendingOfferIds: [], failedOfferIds: [b], errorsByOffer: { [b]: [{ code: 'TOO_MANY_REQUESTS' }] } },
      stocksWrite: { succeededOfferIds: [a, b], pendingOfferIds: [], failedOfferIds: [], errorsByOffer: {} }
    };
    const before = structuredClone(s);
    const resume = ozonRetryResume(s);
    expect(resume.payload.priceStockWriteProgress.pricesWrite).toMatchObject({ succeededOfferIds: [a], pendingOfferIds: [b], failedOfferIds: [] });
    expect(resume.payload.priceStockWriteProgress.stocksWrite).toEqual(s.job.payload.priceStockWriteProgress.stocksWrite);
    expect(s).toEqual(before);
    s.job.payload.priceStockWriteProgress.pricesWrite.errorsByOffer[b] = [{ code: 'INVALID_PRICE' }];
    expect(buildOzonRetryPlan(s).canRetry).toBe(false);
    expect(() => ozonRetryResume(s)).toThrow('明确拒绝');
  });
  it('resumes image repair instead of recreating the product', () => {
    const s = retryFixture(); s.job.import_task_id = '123'; s.job.payload.imageRecovery = { phase: 'REUPLOAD_PENDING' };
    expect(ozonRetryResume(s)).toEqual({ state: 'MODERATING', payload: {} });
  });
  it.each(['SUCCEEDED', 'CANCELLED', 'IMPORTING', 'READY'])('does not offer retry for %s', state => {
    const s = retryFixture(); s.job.state = state;
    expect(buildOzonRetryPlan(s).canRetry).toBe(false);
  });
  it('blocks configuration drift, active lease, stale preflight and superseded tasks', () => {
    for (const mutate of [
      (s: any) => { s.store.config_version++; },
      (s: any) => { s.job.lease_expires_at = new Date(Date.now() + 60_000); },
      (s: any) => { s.store.preflight_expires_at = new Date(0); },
      (s: any) => { s.job.payload.replanReplacement = { replacementJobId: 'next' }; }
    ]) { const s = retryFixture(); mutate(s); expect(buildOzonRetryPlan(s).canRetry).toBe(false); }
  });
  it('hands an existing failed import to the readback executor and records progress, not success', async () => {
    const s = retryFixture(); s.job.import_task_id = '123';
    const r = { id: 'retry', source_job_id: s.job.id, store_id: s.store.id, status: 'CHECKING', mode: 'READBACK', snapshot: structuredClone(s) };
    s.job.payload.recoveryHold = { retryId: r.id, active: true };
    const repo = { claim: vi.fn(async () => r), snapshot: vi.fn(async () => s), releaseToRuntime: vi.fn(), settle: vi.fn() };
    const stores = { repository: { isFleetCapabilityReady: () => true }, validateRetryPackage: vi.fn(), recheckPublication: vi.fn(), automaticPublicationPlan: vi.fn() };
    const gateway = { proveStoreOfferAbsence: vi.fn() };
    await new OzonPublishRetryService(repo as any, stores as any, gateway).runPending();
    expect(repo.releaseToRuntime).toHaveBeenCalledWith(r, s.job.id, 'IMPORTING', {});
    expect(stores.recheckPublication).not.toHaveBeenCalled();
    expect(stores.automaticPublicationPlan).not.toHaveBeenCalled();
    expect(gateway.proveStoreOfferAbsence).not.toHaveBeenCalled();
    expect(repo.settle).not.toHaveBeenCalled();
  });
  it('marks failed checks explicitly without dispatching', async () => {
    const s = retryFixture(); const r = { id: 'retry', source_job_id: s.job.id, store_id: s.store.id, status: 'CHECKING', mode: 'RESUME', snapshot: structuredClone(s) };
    s.store.config_version++;
    const repo = { claim: vi.fn(async () => r), snapshot: vi.fn(async () => s), releaseToRuntime: vi.fn(), settle: vi.fn() };
    await new OzonPublishRetryService(repo as any, { repository: { isFleetCapabilityReady: () => true } } as any, {} as any).runPending();
    expect(repo.settle).toHaveBeenCalledWith(r, 'BLOCKED', expect.stringContaining('已变化'), 'VERSION_CONFLICT');
    expect(repo.releaseToRuntime).not.toHaveBeenCalled();
  });
  it('checks absence before resuming and refuses a manually published offer', async () => {
    for (const alreadyExists of [false, true]) {
      const s = retryFixture();
      const r = { id: 'retry', lease_token: 'lease', source_job_id: s.job.id, store_id: s.store.id, status: 'CHECKING', mode: 'RESUME', snapshot: structuredClone(s) };
      s.job.payload.recoveryHold = { retryId: r.id, active: true };
      const repo = { claim: vi.fn(async () => r), snapshot: vi.fn(async () => s), checkpoint: vi.fn(), releaseToRuntime: vi.fn(), settle: vi.fn() };
      const stores = { repository: { isFleetCapabilityReady: () => true }, validateRetryPackage: vi.fn(), recheckPublication: vi.fn(), automaticPublicationPlan: vi.fn() };
      const gateway = { proveStoreOfferAbsence: vi.fn(async () => { if (alreadyExists) throw new Error('Offer 已存在'); }) };
      await new OzonPublishRetryService(repo as any, stores as any, gateway).runPending();
      expect(gateway.proveStoreOfferAbsence).toHaveBeenCalledWith({ storeId: s.store.id, expectedStoreConfigVersion: 1, expectedCredentialVersionId: s.publication!.credential_version_id, offerIds: s.job.offer_ids });
      if (alreadyExists) {
        expect(repo.releaseToRuntime).not.toHaveBeenCalled(); expect(stores.recheckPublication).not.toHaveBeenCalled();
        expect(repo.settle).toHaveBeenCalledWith(r, 'BLOCKED', 'Offer 已存在', 'OZON_RETRY_CHECK_FAILED');
      } else {
        expect(stores.recheckPublication).toHaveBeenCalledWith(s.publication!.id, expect.objectContaining({ rowVersion: 1 }), r.id, r.lease_token);
        expect(repo.releaseToRuntime).toHaveBeenCalledWith(r, s.job.id, 'READY', {});
      }
      expect(stores.automaticPublicationPlan).not.toHaveBeenCalled();
    }
  });
  it('rebuilds exactly one selected store and resumes the durable frozen plan after restart', async () => {
    const s = retryFixture(); const nextJobId = 'next-job';
    const frozen = { generatedVersionId: 'new-version', items: [{ storeId: s.store.id, ready: true, offerIds: s.job.offer_ids, plannedJobId: nextJobId, credentialVersionId: s.job.credential_version_id, storeConfigVersion: 1 }] };
    for (const restarting of [false, true]) {
      const r = { id: 'retry', lease_token: 'lease', sku: s.job.sku, source_job_id: s.job.id, store_id: s.store.id, status: 'CHECKING', mode: 'REBUILD', snapshot: structuredClone(s), checkpoint: restarting ? { frozenPlan: frozen } : {} };
      s.job.payload.recoveryHold = { retryId: r.id, active: true };
      const repo = { claim: vi.fn(async () => r), snapshot: vi.fn(async () => s), checkpoint: vi.fn(), reserveVersion: vi.fn(async () => ({ versionId: 'new-version', draftVersion: 2 })), releaseToRuntime: vi.fn(), settle: vi.fn() };
      const stores = { repository: { isFleetCapabilityReady: () => true }, assertRetrySourceAvailable: vi.fn(), automaticPublicationPlan: vi.fn(async () => frozen), createRetryPublicationFromFrozenPlan: vi.fn(async () => ({ failed: 0, publications: [{ id: 'new-publication' }] })) };
      const gateway = { proveStoreOfferAbsence: vi.fn() };
      await new OzonPublishRetryService(repo as any, stores as any, gateway).runPending();
      if (restarting) expect(stores.automaticPublicationPlan).not.toHaveBeenCalled();
      else expect(stores.automaticPublicationPlan).toHaveBeenCalledWith(s.job.sku, 2, [s.store.id], { prepareSharedSource: true });
      expect(stores.createRetryPublicationFromFrozenPlan).toHaveBeenCalledWith(frozen, r.id, r.lease_token);
      expect(repo.releaseToRuntime).toHaveBeenCalledWith(r, nextJobId); expect(repo.settle).not.toHaveBeenCalled();
    }
  });
});
