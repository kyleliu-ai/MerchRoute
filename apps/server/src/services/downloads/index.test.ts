import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PurchaseRepository, WorkflowInput } from '../../repositories/purchases.js';
import { DownloadWorker, isDownloadProfileBusyResult, isE007ProfileBusyResult } from './index.js';

const cleanupPaths: string[] = [];
const LEASE_TOKEN = '11111111-1111-4111-8111-111111111111';
const DOWNLOAD_JOB_ID = 'job-0000089';
const IDEMPOTENCY_PROTOCOL_FIELDS = {
  idempotencyReplay: false,
  ownerN8nExecutionId: 'owner-execution-101',
  requestN8nExecutionId: 'request-execution-102'
} as const;

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(cleanupPaths.splice(0).reverse().map((item) => rm(item, { recursive: true, force: true })));
});

describe('E006/E007 download resource classification', () => {
  it('treats only the explicit E007 profile_busy result as retryable', () => {
    expect(isE007ProfileBusyResult('E007', {
      status: 'profile_busy', httpStatus: 409, browserProfileBusy: true
    })).toBe(true);
    expect(isE007ProfileBusyResult('E006', {
      status: 'profile_busy', httpStatus: 409, browserProfileBusy: true
    })).toBe(false);
    expect(isDownloadProfileBusyResult('E006', {
      status: 'profile_busy', httpStatus: 409, browserProfileBusy: true
    })).toBe(true);
    expect(isE007ProfileBusyResult('E007', {
      status: 'login_required', httpStatus: 409, browserProfileBusy: false
    })).toBe(false);
    expect(isE007ProfileBusyResult('E007', {
      status: 'validation_error', httpStatus: 409, browserProfileBusy: false
    })).toBe(false);
  });

  it('puts an E006 profile_busy response into the same persistent resource wait path', async () => {
    const fixture = await createFixture();
    const parentOutputDir = path.join(fixture, 'downloads');
    await mkdir(parentOutputDir, { recursive: true });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: false,
      status: 'profile_busy',
      httpStatus: 409,
      browserProfileBusy: true,
      idempotencyState: 'retryable',
      downloadJobId: DOWNLOAD_JOB_ID,
      ...IDEMPOTENCY_PROTOCOL_FIELDS
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
    const harness = createWorkerHarness(parentOutputDir, fetchMock);

    harness.worker.start();
    try {
      await vi.waitFor(() => expect(harness.deferResourceJob).toHaveBeenCalledTimes(1));
    } finally {
      harness.worker.stop();
    }

    expect(harness.deferResourceJob).toHaveBeenCalledWith('job-0000089', expect.objectContaining({ status: 'profile_busy' }), LEASE_TOKEN);
    expect(harness.completeJob).not.toHaveBeenCalled();
  });
});

describe('download worker destination protection', () => {
  it.each([
    ['system temp directory', path.join(os.tmpdir(), 'unsafe-e006-downloads')],
    ['n8n-review test directory', safeLookingTestDirectory()]
  ])('blocks an already queued job targeting a %s before calling its webhook', async (_label, parentOutputDir) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const harness = createWorkerHarness(parentOutputDir, fetchMock);

    await runWorker(harness.worker, harness.completeJob);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(harness.completeJob).toHaveBeenCalledWith('job-0000089', expect.objectContaining({
      success: false,
      status: 'unsafe_download_destination',
      httpStatus: 409,
      parentOutputDir
    }), LEASE_TOKEN);
    expect(harness.failJob).not.toHaveBeenCalled();
  });
});

describe('download worker output verification', () => {
  it('turns a successful webhook response with a missing output directory into download_output_unavailable', async () => {
    const fixture = await createFixture();
    const parentOutputDir = path.join(fixture, 'downloads');
    await mkdir(parentOutputDir);
    const outputDir = path.join(parentOutputDir, '0000089-missing');
    const fetchMock = successfulWebhook({ success: true, status: 'success', outputDir });
    const harness = createWorkerHarness(parentOutputDir, fetchMock);

    await runWorker(harness.worker, harness.completeJob);

    expect(harness.completeJob).toHaveBeenCalledWith('job-0000089', expect.objectContaining({
      success: false,
      status: 'download_output_unavailable',
      httpStatus: 500,
      outputDir
    }), LEASE_TOKEN);
    expect(harness.failJob).not.toHaveBeenCalled();
  });

  it('turns a successful webhook response outside the configured parent into download_output_unavailable', async () => {
    const fixture = await createFixture();
    const parentOutputDir = path.join(fixture, 'downloads');
    const outputDir = path.join(fixture, 'outside');
    await Promise.all([mkdir(parentOutputDir), mkdir(outputDir)]);
    await writeFile(path.join(outputDir, 'main.jpg'), 'image');
    const fetchMock = successfulWebhook({ success: true, status: 'success', outputDir });
    const harness = createWorkerHarness(parentOutputDir, fetchMock);

    await runWorker(harness.worker, harness.completeJob);

    expect(harness.completeJob).toHaveBeenCalledWith('job-0000089', expect.objectContaining({
      success: false,
      status: 'download_output_unavailable',
      httpStatus: 500,
      outputDir
    }), LEASE_TOKEN);
    expect(harness.failJob).not.toHaveBeenCalled();
  });

  it('turns an existing child directory without images into download_output_unavailable', async () => {
    const fixture = await createFixture();
    const parentOutputDir = path.join(fixture, 'downloads');
    const outputDir = path.join(parentOutputDir, '0000089-no-images');
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'metadata.json'), '{}');
    const fetchMock = successfulWebhook({ success: true, status: 'success', outputDir });
    const harness = createWorkerHarness(parentOutputDir, fetchMock);

    await runWorker(harness.worker, harness.completeJob);

    expect(harness.completeJob).toHaveBeenCalledWith('job-0000089', expect.objectContaining({
      success: false,
      status: 'download_output_unavailable',
      httpStatus: 500,
      outputDir
    }), LEASE_TOKEN);
    expect(harness.failJob).not.toHaveBeenCalled();
  });

  it('keeps a successful result for a real child directory containing at least one image', async () => {
    const fixture = await createFixture();
    const parentOutputDir = path.join(fixture, 'downloads');
    const outputDir = path.join(parentOutputDir, '0000089-valid');
    const nestedImages = path.join(outputDir, 'detail-images');
    await mkdir(nestedImages, { recursive: true });
    await writeFile(path.join(nestedImages, 'detail_01.jpg'), 'image');
    const fetchMock = successfulWebhook({ success: true, status: 'success', outputDir, imageCount: 1 });
    const harness = createWorkerHarness(parentOutputDir, fetchMock);

    await runWorker(harness.worker, harness.completeJob);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.completeJob).toHaveBeenCalledWith('job-0000089', {
      downloadJobId: DOWNLOAD_JOB_ID,
      idempotencyState: 'succeeded',
      ...IDEMPOTENCY_PROTOCOL_FIELDS,
      success: true,
      status: 'success',
      outputDir,
      imageCount: 1
    }, LEASE_TOKEN);
    expect(harness.failJob).not.toHaveBeenCalled();
  });
});

describe('download worker idempotent recovery', () => {
  it('polls HTTP 202 with the same downloadJobId and settles the cached success once', async () => {
    const fixture = await createFixture();
    const parentOutputDir = path.join(fixture, 'downloads');
    const outputDir = path.join(parentOutputDir, '0000089-idempotent');
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'main.jpg'), 'image');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: false,
        status: 'idempotency_in_progress',
        idempotencyState: 'running',
        downloadJobId: DOWNLOAD_JOB_ID,
        ...IDEMPOTENCY_PROTOCOL_FIELDS,
        retryAfterMs: 1
      }), { status: 202, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        status: 'success',
        idempotencyState: 'succeeded',
        idempotencyReplay: true,
        downloadJobId: DOWNLOAD_JOB_ID,
        ownerN8nExecutionId: IDEMPOTENCY_PROTOCOL_FIELDS.ownerN8nExecutionId,
        requestN8nExecutionId: IDEMPOTENCY_PROTOCOL_FIELDS.requestN8nExecutionId,
        outputDir
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const harness = createWorkerHarness(parentOutputDir, fetchMock, {
      recoveryRetryMinMs: 1,
      recoveryRetryMaxMs: 2,
      sleep
    });

    await runWorker(harness.worker, harness.completeJob);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)).downloadJobId)).toEqual([
      DOWNLOAD_JOB_ID,
      DOWNLOAD_JOB_ID
    ]);
    expect(harness.markJobRecovering).toHaveBeenCalledWith('job-0000089', expect.any(String), LEASE_TOKEN);
    expect(harness.completeJob).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1);
  });

  it('recovers an uncertain transport failure without claiming or creating another job', async () => {
    const fixture = await createFixture();
    const parentOutputDir = path.join(fixture, 'downloads');
    const outputDir = path.join(parentOutputDir, '0000089-recovered');
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'main.jpg'), 'image');
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed after request was sent'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true, status: 'success', idempotencyState: 'succeeded', downloadJobId: DOWNLOAD_JOB_ID,
        ...IDEMPOTENCY_PROTOCOL_FIELDS, outputDir
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }));
    const harness = createWorkerHarness(parentOutputDir, fetchMock, {
      recoveryRetryMinMs: 1,
      recoveryRetryMaxMs: 2,
      sleep: async () => undefined
    });

    await runWorker(harness.worker, harness.completeJob);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(harness.claimNextJob).toHaveBeenCalledTimes(2);
    expect(harness.markJobRecovering).toHaveBeenCalledTimes(1);
    expect(harness.completeJob).toHaveBeenCalledWith('job-0000089', expect.objectContaining({ success: true, outputDir }), LEASE_TOKEN);
  });

  it('drops a late response after recovery ownership has moved to another worker', async () => {
    const fixture = await createFixture();
    const parentOutputDir = path.join(fixture, 'downloads');
    await mkdir(parentOutputDir, { recursive: true });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: false,
      status: 'idempotency_in_progress',
      idempotencyState: 'running',
      downloadJobId: DOWNLOAD_JOB_ID,
      ...IDEMPOTENCY_PROTOCOL_FIELDS
    }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
    const harness = createWorkerHarness(parentOutputDir, fetchMock, { sleep: async () => undefined });
    harness.markJobRecovering.mockResolvedValue(false);

    harness.worker.start();
    try {
      await vi.waitFor(() => expect(harness.markJobRecovering).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      harness.worker.stop();
    }

    expect(harness.completeJob).not.toHaveBeenCalled();
    expect(harness.failJob).not.toHaveBeenCalled();
  });

  it('rejects a terminal idempotency receipt belonging to another download job', async () => {
    const fixture = await createFixture();
    const parentOutputDir = path.join(fixture, 'downloads');
    await mkdir(parentOutputDir, { recursive: true });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      status: 'success',
      idempotencyState: 'succeeded',
      downloadJobId: 'another-job-id',
      ...IDEMPOTENCY_PROTOCOL_FIELDS,
      outputDir: path.join(parentOutputDir, 'wrong-job')
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const harness = createWorkerHarness(parentOutputDir, fetchMock);

    await runWorker(harness.worker, harness.completeJob);

    expect(harness.completeJob).toHaveBeenCalledWith('job-0000089', expect.objectContaining({
      success: false,
      status: 'idempotency_protocol_error'
    }), LEASE_TOKEN);
  });

  it.each([
    ['missing state', { success: true, status: 'success', downloadJobId: DOWNLOAD_JOB_ID, ...IDEMPOTENCY_PROTOCOL_FIELDS }],
    ['contradictory state', { success: false, status: 'failed', idempotencyState: 'succeeded', downloadJobId: DOWNLOAD_JOB_ID, ...IDEMPOTENCY_PROTOCOL_FIELDS }],
    ['missing replay flag', { success: true, status: 'success', idempotencyState: 'succeeded', downloadJobId: DOWNLOAD_JOB_ID, ownerN8nExecutionId: 'owner', requestN8nExecutionId: 'request' }],
    ['missing owner execution', { success: true, status: 'success', idempotencyState: 'succeeded', downloadJobId: DOWNLOAD_JOB_ID, idempotencyReplay: false, requestN8nExecutionId: 'request' }],
    ['missing request execution', { success: true, status: 'success', idempotencyState: 'succeeded', downloadJobId: DOWNLOAD_JOB_ID, idempotencyReplay: false, ownerN8nExecutionId: 'owner' }]
  ])('rejects an idempotent terminal receipt with %s', async (_label, receipt) => {
    const fixture = await createFixture();
    const parentOutputDir = path.join(fixture, 'downloads');
    await mkdir(parentOutputDir, { recursive: true });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(receipt), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
    const harness = createWorkerHarness(parentOutputDir, fetchMock);

    await runWorker(harness.worker, harness.completeJob);

    expect(harness.completeJob).toHaveBeenCalledWith('job-0000089', expect.objectContaining({
      success: false,
      status: 'idempotency_protocol_error'
    }), LEASE_TOKEN);
  });

  it.each([
    ['succeeded on HTTP 409', { success: true, status: 'success', idempotencyState: 'succeeded' }, 409],
    ['failed on HTTP 200', { success: false, status: 'failed', idempotencyState: 'failed' }, 200],
    ['failed on HTTP 206', { success: false, status: 'failed', idempotencyState: 'failed' }, 206]
  ])('rejects an idempotent receipt mapped as %s', async (_label, receipt, httpStatus) => {
    const fixture = await createFixture();
    const parentOutputDir = path.join(fixture, 'downloads');
    await mkdir(parentOutputDir, { recursive: true });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...receipt,
      downloadJobId: DOWNLOAD_JOB_ID,
      ...IDEMPOTENCY_PROTOCOL_FIELDS
    }), { status: httpStatus, headers: { 'Content-Type': 'application/json' } }));
    const harness = createWorkerHarness(parentOutputDir, fetchMock);

    await runWorker(harness.worker, harness.completeJob);

    expect(harness.completeJob).toHaveBeenCalledWith('job-0000089', expect.objectContaining({
      success: false,
      status: 'idempotency_protocol_error'
    }), LEASE_TOKEN);
  });
});

function createWorkerHarness(parentOutputDir: string, fetchMock: ReturnType<typeof vi.fn>, options: ConstructorParameters<typeof DownloadWorker>[3] = {}) {
  const job = {
    id: 'job-0000089',
    sku: '0000089',
    workflowCode: 'E006',
    workflowSnapshot: {
      code: 'E006',
      displayName: 'PDD下载',
      webhookUrl: 'http://127.0.0.1:5678/webhook/pdd-image-download',
      parentOutputDir,
      timeoutMs: 900_000,
      enabled: true,
      isDefault: true,
      recoveryMode: 'IDEMPOTENT_REPLAY'
    },
    status: 'RUNNING',
    attempt: 1,
    recoveryMode: 'IDEMPOTENT_REPLAY',
    leaseToken: LEASE_TOKEN,
    leaseOwner: 'test-worker',
    startedAt: new Date().toISOString(),
    requestBody: {
      downloadJobId: DOWNLOAD_JOB_ID,
      productName: '软皮斜挎包',
      SKU: '0000089',
      productUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=1',
      parentOutputDir
    }
  };
  const claimNextJob = vi.fn()
    .mockResolvedValueOnce(job)
    .mockResolvedValue(undefined);
  const completeJob = vi.fn().mockResolvedValue(true);
  const failJob = vi.fn().mockResolvedValue(undefined);
  const deferResourceJob = vi.fn().mockResolvedValue({ status: 'WAITING_RESOURCE', nextAttemptAt: '', resourceRetryCount: 0 });
  const renewJobLease = vi.fn().mockResolvedValue(true);
  const markJobRecovering = vi.fn().mockResolvedValue(true);
  const purchases = {
    configured: true,
    claimNextJob,
    completeJob,
    failJob,
    deferResourceJob,
    renewJobLease,
    markJobRecovering
  } as unknown as PurchaseRepository;
  const logger = {
    error: vi.fn(),
    info: vi.fn()
  } as unknown as FastifyBaseLogger;
  const workflow: WorkflowInput = {
    code: 'E006',
    displayName: 'PDD下载',
    webhookUrl: 'http://127.0.0.1:5678/webhook/pdd-image-download',
    parentOutputDir,
    timeoutMs: 900_000,
    enabled: true,
    isDefault: true,
    recoveryMode: 'IDEMPOTENT_REPLAY'
  };
  const worker = new DownloadWorker(purchases, logger, () => [workflow], options);
  vi.stubGlobal('fetch', fetchMock);
  return { worker, claimNextJob, completeJob, failJob, deferResourceJob, renewJobLease, markJobRecovering };
}

async function runWorker(worker: DownloadWorker, completeJob: ReturnType<typeof vi.fn>): Promise<void> {
  worker.start();
  try {
    await vi.waitFor(() => expect(completeJob).toHaveBeenCalledTimes(1), { timeout: 2_000, interval: 10 });
  } finally {
    worker.stop();
  }
}

function successfulWebhook(payload: Record<string, unknown>) {
  const idempotencyState = payload.success === false ? 'failed' : 'succeeded';
  return vi.fn().mockResolvedValue(new Response(JSON.stringify({
    downloadJobId: DOWNLOAD_JOB_ID, idempotencyState, ...IDEMPOTENCY_PROTOCOL_FIELDS, ...payload
  }), {
    status: payload.success === false ? 409 : 200,
    headers: { 'Content-Type': 'application/json' }
  }));
}

async function createFixture(): Promise<string> {
  for (const parent of [process.cwd(), os.homedir()]) {
    if (isSystemTempPath(parent)) continue;
    try {
      const fixture = await mkdtemp(path.join(parent, '.download-worker-'));
      cleanupPaths.push(fixture);
      return fixture;
    } catch {
      // Try the next non-temporary, user-writable fixture parent.
    }
  }
  throw new Error('No writable fixture parent outside the system temporary directory');
}

function isSystemTempPath(value: string): boolean {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(value));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeLookingTestDirectory(): string {
  return process.platform === 'win32'
    ? 'G:\\media\\n8n-review-legacy-test\\E006\\candidate'
    : '/Volumes/media/n8n-review-legacy-test/E006/candidate';
}
