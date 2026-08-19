import Fastify from 'fastify';
import { AppError } from '@n8n-media-review/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleWbNetworkRecoveryRequest } from './wb-network-recovery.js';
import { registerWbRoutes } from './wb.js';

const apps: ReturnType<typeof Fastify>[] = [];
const originalRuntimeKey = process.env.MERCHROUTE_RUNTIME_KEY;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  if (originalRuntimeKey === undefined) delete process.env.MERCHROUTE_RUNTIME_KEY;
  else process.env.MERCHROUTE_RUNTIME_KEY = originalRuntimeKey;
});

const recovery = {
  phase: 'SUBMIT_READBACK',
  resumeState: 'SUBMITTING',
  deliveryState: 'UNKNOWN' as const,
  attempt: 1,
  firstFailureAt: '2026-08-07T00:00:00.000Z',
  lastFailureAt: '2026-08-07T00:00:00.000Z',
  nextAttemptAt: '2026-08-07T00:00:30.000Z',
  lastErrorCode: 'ECONNRESET',
  lastErrorMessage: 'socket hang up'
};

const runtimeIdentity = {
  taskId: '0000001__r1',
  idempotencyKey: 'wb:0000001__r1',
  productCode: '0000001',
  revision: 1,
  payloadSignature: 'sha256:runtime-candidate',
  workRelpath: 'processing/0000001__r1'
};

function dependencies() {
  return {
    wb: {
      listHistoricalRuntimeNetworkFailureCandidates: vi.fn(async () => [{
        kind: 'RUNTIME', identity: runtimeIdentity, rowVersion: 7,
        evidence: { recoverable: true, safeReadback: true, safeResumeState: 'CARD_SUBMITTING' }
      }]),
      recoverHistoricalRuntimeNetworkFailure: vi.fn(async () => ({
        job: { taskId: runtimeIdentity.taskId, state: 'RETRY_WAIT' }, rowVersion: 8,
        evidence: { transport: true, recoverable: true, safeReadback: true, safeResumeState: 'CARD_SUBMITTING' }
      })),
      listHistoricalNetworkListingCandidates: vi.fn(async () => [{
        kind: 'MANUAL', identity: { versionId: '11111111-1111-4111-8111-111111111111' }, proposedRecovery: recovery
      }]),
      recoverHistoricalNetworkListing: vi.fn(async () => ({ listing: { sku: '0000001', status: 'SUBMITTING' }, rowVersion: '12', evidence: { transport: true } }))
    },
    auto: {
      listHistoricalNetworkFailureCandidates: vi.fn(async () => [{ kind: 'AUTO', identity: { sku: '0000002' }, proposedRecovery: recovery }]),
      recoverHistoricalNetworkFailure: vi.fn(async () => { throw new AppError('VERSION_CONFLICT', 'row changed', { actualRowVersion: '22' }, 409); })
    }
  };
}

describe('WB historical network recovery boundary', () => {
  it('defaults to a read-only candidate scan and never calls apply methods', async () => {
    const deps = dependencies();
    const result = await handleWbNetworkRecoveryRequest(deps as any, {});
    expect(result).toMatchObject({ dryRun: true, applied: false, candidateCount: 3 });
    expect(deps.wb.listHistoricalRuntimeNetworkFailureCandidates).toHaveBeenCalledWith(100);
    expect(deps.wb.listHistoricalNetworkListingCandidates).toHaveBeenCalledWith(100);
    expect(deps.auto.listHistoricalNetworkFailureCandidates).toHaveBeenCalledWith(100);
    expect(deps.wb.recoverHistoricalRuntimeNetworkFailure).not.toHaveBeenCalled();
    expect(deps.wb.recoverHistoricalNetworkListing).not.toHaveBeenCalled();
    expect(deps.auto.recoverHistoricalNetworkFailure).not.toHaveBeenCalled();
  });

  it('requires explicit per-item identity and rowVersion, and returns CAS conflicts item by item', async () => {
    const deps = dependencies();
    await expect(handleWbNetworkRecoveryRequest(deps as any, { apply: true, items: [] }))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    const result = await handleWbNetworkRecoveryRequest(deps as any, {
      dryRun: false,
      apply: true,
      items: [
        {
          kind: 'MANUAL',
          identity: { versionId: '11111111-1111-4111-8111-111111111111', taskId: '0000001__r1' },
          rowVersion: '11',
          proposedRecovery: { ...recovery, checkpoint: 'taskId:0000001__r1' }
        },
        {
          kind: 'RUNTIME',
          identity: runtimeIdentity,
          rowVersion: 7
        },
        {
          kind: 'AUTO',
          identity: {
            sku: '0000002',
            runId: '22222222-2222-4222-8222-222222222222',
            runNo: 3,
            taskId: '0000002__r3'
          },
          rowVersion: '21',
          proposedRecovery: { ...recovery, checkpoint: 'taskId:0000002__r3' }
        }
      ]
    });
    expect(result).toMatchObject({
      dryRun: false,
      applied: true,
      requestedCount: 3,
      recoveredCount: 2,
      conflictCount: 1,
      errorCount: 0,
      results: [
        { kind: 'RUNTIME', status: 'RECOVERED', previousRowVersion: 7, rowVersion: 8 },
        { kind: 'MANUAL', status: 'RECOVERED', previousRowVersion: '11', rowVersion: '12' },
        { kind: 'AUTO', status: 'CONFLICT', code: 'VERSION_CONFLICT', details: { actualRowVersion: '22' } }
      ]
    });
    expect(deps.wb.listHistoricalNetworkListingCandidates).not.toHaveBeenCalled();
    expect(deps.auto.listHistoricalNetworkFailureCandidates).not.toHaveBeenCalled();
    expect(deps.wb.recoverHistoricalRuntimeNetworkFailure).toHaveBeenCalledWith(runtimeIdentity.taskId, {
      ...runtimeIdentity,
      rowVersion: 7
    });
    expect(deps.wb.recoverHistoricalNetworkListing).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      '0000001__r1',
      '11',
      expect.objectContaining({ attempt: 1 })
    );
    expect(deps.wb.recoverHistoricalRuntimeNetworkFailure.mock.invocationCallOrder[0])
      .toBeLessThan(deps.wb.recoverHistoricalNetworkListing.mock.invocationCallOrder[0]!);
  });

  it('protects the HTTP route with the runtime key', async () => {
    process.env.MERCHROUTE_RUNTIME_KEY = 'recovery-test-key';
    const deps = dependencies();
    const app = Fastify();
    apps.push(app);
    await registerWbRoutes(app, {
      wb: deps.wb as any,
      wbPublishing: {} as any,
      wbCatalog: {} as any,
      wbPresets: {} as any,
      wbAutoPublishing: { repository: deps.auto } as any
    });

    const unauthorized = await app.inject({ method: 'POST', url: '/api/v1/wb/runtime/recovery/network', payload: {} });
    expect(unauthorized.statusCode).toBe(401);
    expect(deps.wb.listHistoricalRuntimeNetworkFailureCandidates).not.toHaveBeenCalled();
    expect(deps.wb.listHistoricalNetworkListingCandidates).not.toHaveBeenCalled();

    const dryRun = await app.inject({
      method: 'POST',
      url: '/api/v1/wb/runtime/recovery/network',
      headers: { 'x-merchroute-runtime-key': 'recovery-test-key' },
      payload: { limit: 5 }
    });
    expect(dryRun.statusCode).toBe(200);
    expect(dryRun.json()).toMatchObject({ dryRun: true, applied: false, candidateCount: 3 });
    expect(deps.wb.listHistoricalRuntimeNetworkFailureCandidates).toHaveBeenCalledWith(5);
    expect(deps.wb.listHistoricalNetworkListingCandidates).toHaveBeenCalledWith(5);
  });
});
