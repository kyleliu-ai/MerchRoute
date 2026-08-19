import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type {
  WbSourceMediaCleanupBatch,
  WbSourceMediaCleanupRepository,
  WbSourceMediaCleanupTarget
} from '../../repositories/wb-source-media-cleanup.js';
import { WbSourceMediaCleanupService } from './index.js';
import type { WbSourceMediaFiles } from './source-files.js';

const STORE_A = '00000000-0000-4000-8000-000000000001';
const STORE_B = '00000000-0000-4000-8000-000000000002';

describe('WbSourceMediaCleanupService worker gates', () => {
  it('rejects an automatic cleanup registration with zero persisted target jobs', async () => {
    const repository = { configured: true, registerAutomationBatch: vi.fn() };
    const files = { snapshot: vi.fn() };
    const service = new WbSourceMediaCleanupService(
      repository as unknown as WbSourceMediaCleanupRepository,
      files as unknown as WbSourceMediaFiles,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );

    await expect(service.registerAutomaticBatch({
      sku: '0000123', rootDirectory: 'G:\\wb-root', deliveredAt: '2026-08-14T00:00:00.000Z',
      submissionId: 'submission-a', targets: []
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(files.snapshot).not.toHaveBeenCalled();
    expect(repository.registerAutomationBatch).not.toHaveBeenCalled();
  });

  it('requires unchanged idle source media before an orphan automatic batch can be superseded', async () => {
    const batch = { ...cleanupBatch(), source: 'AUTOMATION' as const, mediaBatchId: 'batch-a', deliveredAt: '2026-08-14T00:00:00.000Z' };
    const repository = {
      configured: true,
      inspectOrphanAutomationBatch: vi.fn(async () => ({ batch, targets: [], reasons: [] })),
      hasNewerOrActiveWork: vi.fn(async () => ({ blocked: false, reasons: [] }))
    };
    const files = { snapshot: vi.fn(async () => ({
      exists: true, stagingEmpty: false, mediaSignature: batch.mediaSignature, files: []
    })) };
    const service = new WbSourceMediaCleanupService(
      repository as unknown as WbSourceMediaCleanupRepository,
      files as unknown as WbSourceMediaFiles,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );

    await expect(service.inspectOrphanAutomaticBatch(batch.id)).resolves.toMatchObject({
      eligible: false,
      reasons: ['STAGING_NOT_EMPTY']
    });
  });

  it.each([
    ['RUNNING', 'SUCCEEDED'],
    ['FAILED', 'SUCCEEDED'],
    ['UNKNOWN', 'SUCCEEDED'],
    ['SUCCEEDED', 'RUNNING']
  ])('keeps the shared source while publication=%s or runtime=%s', async (publicationStatus, runtimeState) => {
    const batch = cleanupBatch();
    const repository = repositoryMock(batch, [
      successfulTarget(STORE_A),
      { ...successfulTarget(STORE_B), publicationStatus, runtimeState }
    ]);
    const files = { snapshot: vi.fn(), quarantine: vi.fn(), deleteQuarantine: vi.fn() };
    const service = new WbSourceMediaCleanupService(
      repository as unknown as WbSourceMediaCleanupRepository,
      files as unknown as WbSourceMediaFiles,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );

    await expect(service.runDue()).resolves.toMatchObject({ checked: 1, waiting: 1, cleaned: 0, retried: 0 });
    expect(repository.releaseWaiting).toHaveBeenCalledOnce();
    expect(files.snapshot).not.toHaveBeenCalled();
    expect(files.quarantine).not.toHaveBeenCalled();
  });

  it('keeps the batch when one expected store has not produced a publication yet', async () => {
    const batch = cleanupBatch();
    const repository = repositoryMock(batch, [successfulTarget(STORE_A)]);
    const service = new WbSourceMediaCleanupService(
      repository as unknown as WbSourceMediaCleanupRepository,
      {} as WbSourceMediaFiles,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );

    await expect(service.runDue()).resolves.toMatchObject({ checked: 1, waiting: 1 });
    expect(repository.releaseWaiting).toHaveBeenCalledOnce();
  });

  it('does not delete when newer work appears after the frozen batch', async () => {
    const batch = cleanupBatch();
    const repository = repositoryMock(batch, [successfulTarget(STORE_A), successfulTarget(STORE_B)]);
    repository.hasNewerOrActiveWork.mockResolvedValue({ blocked: true, reasons: ['NEWER_MEDIA_BATCH'] });
    const files = { snapshot: vi.fn(), quarantine: vi.fn() };
    const service = new WbSourceMediaCleanupService(
      repository as unknown as WbSourceMediaCleanupRepository,
      files as unknown as WbSourceMediaFiles,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );

    await expect(service.runDue()).resolves.toMatchObject({ checked: 1, waiting: 1 });
    expect(repository.releaseWaiting).toHaveBeenCalledOnce();
    expect(files.snapshot).not.toHaveBeenCalled();
  });

  it('persists a retry without changing publication success when the success archive cannot be verified', async () => {
    const batch = cleanupBatch();
    const repository = repositoryMock(batch, [successfulTarget(STORE_A), successfulTarget(STORE_B)]);
    const service = new WbSourceMediaCleanupService(
      repository as unknown as WbSourceMediaCleanupRepository,
      {} as WbSourceMediaFiles,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );

    await expect(service.runDue()).resolves.toMatchObject({ checked: 1, retried: 1, cleaned: 0 });
    expect(repository.markRetry).toHaveBeenCalledWith(
      batch,
      'WB_SOURCE_MEDIA_CLEANUP_FAILED',
      expect.any(String),
      30_000
    );
    expect(repository.markCleaned).not.toHaveBeenCalled();
  });

  it('reports an incomplete historical store set per SKU without creating a candidate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wb-cleanup-plan-'));
    await mkdir(path.join(root, 'inbox', '0000123'), { recursive: true });
    const repository = {
      configured: true,
      discoverHistoricalGroup: vi.fn().mockResolvedValue({
        sku: '0000123',
        source: 'MANUAL',
        groupCreatedAt: '2026-08-14T00:00:00.000Z',
        completedAt: '2026-08-14T00:00:00.000Z',
        expectedStoreIds: [STORE_A, STORE_B],
        planHash: `sha256:${'b'.repeat(64)}`,
        draftVersion: 3,
        targets: [{ storeId: STORE_A, publicationId: '33333333-3333-4333-8333-333333333333' }]
      }),
      registerBatch: vi.fn(),
      supersedeCandidates: vi.fn().mockResolvedValue(undefined)
    };
    const files = {
      snapshot: vi.fn().mockResolvedValue({
        exists: true,
        sku: '0000123',
        productRoot: 'G:\\wb-root\\inbox\\0000123',
        mediaSignature: `sha256:${'a'.repeat(64)}`,
        fileCount: 4,
        totalBytes: 1024,
        stagingEmpty: true,
        files: []
      })
    };
    const service = new WbSourceMediaCleanupService(
      repository as unknown as WbSourceMediaCleanupRepository,
      files as unknown as WbSourceMediaFiles,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );
    try {
      await expect(service.planHistorical(root)).resolves.toEqual([
        expect.objectContaining({ sku: '0000123', eligible: false, reasons: ['EXPECTED_STORES_INCOMPLETE'] })
      ]);
      expect(repository.registerBatch).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips a historical source when media was delivered after the publication batch completed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wb-cleanup-late-media-'));
    await mkdir(path.join(root, 'inbox', '0000123'), { recursive: true });
    const repository = {
      configured: true,
      discoverHistoricalGroup: vi.fn().mockResolvedValue({
        sku: '0000123', source: 'AUTOMATION', groupCreatedAt: '2026-08-14T00:00:00.000Z',
        completedAt: '2026-08-14T00:05:00.000Z', expectedStoreIds: [STORE_A],
        mediaBatchId: 'historical-0000123', deliveredAt: '2026-08-14T00:00:00.000Z',
        targets: [{ storeId: STORE_A, automationJobId: '55555555-5555-4555-8555-555555555555', automationRunId: '66666666-6666-4666-8666-666666666666' }]
      }),
      supersedeCandidates: vi.fn().mockResolvedValue(undefined),
      registerBatch: vi.fn()
    };
    const files = { snapshot: vi.fn().mockResolvedValue({
      exists: true, sku: '0000123', productRoot: path.join(root, 'inbox', '0000123'),
      mediaSignature: `sha256:${'a'.repeat(64)}`, lastDeliveredAt: '2026-08-14T00:06:00.000Z',
      fileCount: 3, totalBytes: 1024, stagingEmpty: true, files: []
    }) };
    const service = new WbSourceMediaCleanupService(
      repository as unknown as WbSourceMediaCleanupRepository,
      files as unknown as WbSourceMediaFiles,
      { warn: vi.fn() } as unknown as FastifyBaseLogger
    );
    try {
      await expect(service.planHistorical(root)).resolves.toEqual([
        expect.objectContaining({ sku: '0000123', eligible: false, reasons: ['SOURCE_MEDIA_DELIVERED_AFTER_SUCCESS'] })
      ]);
      expect(repository.supersedeCandidates).toHaveBeenCalledWith(
        '0000123', 'HISTORICAL_CANDIDATE_SKIPPED', 'SOURCE_MEDIA_DELIVERED_AFTER_SUCCESS'
      );
      expect(repository.registerBatch).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts a signed immutable success package that contains only product.json and referenced media', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wb-cleanup-slim-package-'));
    const sku = '0000123';
    const publicationId = '33333333-3333-4333-8333-333333333333';
    const taskId = 'default__0000123__r1';
    const relativeMedia = 'variants/red/images/submission-a/01.png';
    const sourceRoot = path.join(root, 'inbox', sku);
    const archiveRoot = path.join(root, 'success', '2026-08-14', taskId);
    const media = Buffer.from('verified-image');
    const mediaSha = createHash('sha256').update(media).digest('hex');
    const manifest = {
      schemaVersion: 2,
      SKU: sku,
      assets: [{ relativePath: relativeMedia, sizeBytes: media.length, sha256: mediaSha, kind: 'image', submissionId: 'submission-a', sortOrder: 0, deliveredAt: '2026-08-14T00:00:00.000Z' }]
    };
    const product = { schemaVersion: 1, productCode: sku, variants: [{ images: [relativeMedia] }] };
    try {
      await mkdir(path.join(sourceRoot, path.dirname(relativeMedia)), { recursive: true });
      await writeFile(path.join(sourceRoot, relativeMedia), media);
      await writeFile(path.join(sourceRoot, 'variants', 'variant-media-manifest.json'), JSON.stringify(manifest));
      await mkdir(path.join(archiveRoot, path.dirname(relativeMedia)), { recursive: true });
      await mkdir(path.join(archiveRoot, '.store-ready'), { recursive: true });
      const productBytes = Buffer.from(JSON.stringify(product));
      await writeFile(path.join(archiveRoot, 'product.json'), productBytes);
      await writeFile(path.join(archiveRoot, relativeMedia), media);
      await writeFile(path.join(archiveRoot, '.intake.json'), JSON.stringify({ taskId, productCode: sku, publicationId }));
      const packageRows = [
        { relativePath: 'product.json', size: productBytes.length, sha256: `sha256:${createHash('sha256').update(productBytes).digest('hex')}` },
        { relativePath: relativeMedia, size: media.length, sha256: `sha256:${mediaSha}` }
      ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
      const packageSignature = `sha256:${createHash('sha256').update(JSON.stringify(packageRows)).digest('hex')}`;
      const materializationHash = `sha256:${'c'.repeat(64)}`;
      await writeFile(path.join(archiveRoot, '.store-ready', `${publicationId}.json`), JSON.stringify({
        sku, taskId, publicationId, packageSignature, materializationHash
      }));
      const files = new (await import('./source-files.js')).WbSourceMediaFiles();
      const snapshot = await files.snapshot(root, sku);
      const batch = {
        ...cleanupBatch(),
        sku,
        rootDirectory: root,
        expectedStoreIds: [STORE_A],
        mediaSignature: snapshot.mediaSignature!
      };
      const repository = {
        configured: true,
        targets: vi.fn().mockResolvedValue([{ ...successfulTarget(STORE_A), cleanupId: batch.id, publicationId,
          publicationTaskId: taskId, publicationPackageSignature: packageSignature,
          publicationMaterializationHash: materializationHash, runtimeTaskId: taskId,
          runtimePublicationId: publicationId, runtimeWorkRelpath: `success/2026-08-14/${taskId}` }]),
        hasNewerOrActiveWork: vi.fn().mockResolvedValue({ blocked: false, reasons: [] })
      };
      const service = new WbSourceMediaCleanupService(
        repository as unknown as WbSourceMediaCleanupRepository,
        files,
        { warn: vi.fn() } as unknown as FastifyBaseLogger
      );

      await expect(service.validateHistoricalCandidate({ batch, snapshot })).resolves.toMatchObject({ eligible: true, reasons: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function cleanupBatch(): WbSourceMediaCleanupBatch {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    sku: '0000123',
    source: 'MANUAL',
    batchKey: 'manual:0000123:plan-a',
    expectedStoreIds: [STORE_A, STORE_B],
    rootDirectory: 'Z:\\missing-wb-root',
    mediaSignature: `sha256:${'a'.repeat(64)}`,
    planHash: `sha256:${'b'.repeat(64)}`,
    draftVersion: 3,
    status: 'PENDING',
    rowVersion: 2,
    attemptCount: 0,
    nextAttemptAt: '2026-08-14T00:00:00.000Z',
    leaseOwner: 'worker-a',
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-08-14T00:01:00.000Z',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z'
  };
}

function successfulTarget(storeId: string): WbSourceMediaCleanupTarget {
  const suffix = storeId === STORE_A ? 'a' : 'b';
  const publicationId = suffix === 'a'
    ? '33333333-3333-4333-8333-333333333333'
    : '44444444-4444-4444-8444-444444444444';
  const taskId = `${suffix}__0000123__r1`;
  return {
    cleanupId: '11111111-1111-4111-8111-111111111111',
    storeId,
    publicationId,
    publicationSource: 'MANUAL',
    publicationStatus: 'SUCCEEDED',
    publicationTaskId: taskId,
    publicationPlanHash: `sha256:${'b'.repeat(64)}`,
    runtimeTaskId: taskId,
    runtimeState: 'SUCCEEDED',
    runtimeWorkRelpath: `success/2026-08-14/${taskId}`,
    runtimePublicationId: publicationId
  };
}

function repositoryMock(batch: WbSourceMediaCleanupBatch, targets: WbSourceMediaCleanupTarget[]) {
  return {
    configured: true,
    claimDue: vi.fn().mockResolvedValue([batch]),
    targets: vi.fn().mockResolvedValue(targets),
    hasNewerOrActiveWork: vi.fn().mockResolvedValue({ blocked: false, reasons: [] }),
    releaseWaiting: vi.fn().mockResolvedValue(undefined),
    markRetry: vi.fn().mockResolvedValue(undefined),
    markQuarantined: vi.fn(),
    markCleaned: vi.fn(),
    markSuperseded: vi.fn()
  };
}
