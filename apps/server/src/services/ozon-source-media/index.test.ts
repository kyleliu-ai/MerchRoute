import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { OzonSourceMediaCleanupEvidence } from '../../repositories/ozon-source-media-cleanup.js';
import {
  OzonSourceMediaCleanupService,
  ozonSourceMediaCleanupDatabaseBlockers,
  sourceMediaIdentityHashFromSnapshot,
  validateRawManifest
} from './index.js';

const versionId = '11111111-1111-4111-8111-111111111111';
const storeA = '22222222-2222-4222-8222-222222222222';
const storeB = '33333333-3333-4333-8333-333333333333';
const hash = `sha256:${'a'.repeat(64)}`;

describe('OzonSourceMediaCleanupService gates', () => {
  it('只允许冻结的 2/2 publication 和 STORE_PUBLICATION job 全部成功', () => {
    expect(ozonSourceMediaCleanupDatabaseBlockers(evidence())).toEqual([]);

    const partial = evidence();
    partial.targets = partial.targets.slice(0, 1);
    expect(ozonSourceMediaCleanupDatabaseBlockers(partial)).toEqual(expect.arrayContaining([
      'TARGET_SET_MISMATCH',
      'PUBLICATION_SET_MISMATCH'
    ]));

    const failed = evidence();
    failed.targets[1]!.publicationStatus = 'NEEDS_ATTENTION';
    expect(ozonSourceMediaCleanupDatabaseBlockers(failed)).toContain(`PUBLICATION_NEEDS_ATTENTION:${storeB}`);
  });

  it('UNKNOWN、活动任务和自动父任务/媒体未完成时全部 fail closed', () => {
    const current = evidence('AUTOMATION');
    current.activeJobCount = 1;
    current.activeSlotCount = 1;
    current.unsafeGatewayCount = 1;
    current.preparationState = 'NEEDS_ATTENTION';
    current.automaticMediaDecisions = ['FANNED_OUT', 'ACCEPTED'];
    expect(ozonSourceMediaCleanupDatabaseBlockers(current)).toEqual(expect.arrayContaining([
      'ACTIVE_JOB_PRESENT',
      'ACTIVE_SLOT_PRESENT',
      'REMOTE_STATE_UNPROVEN',
      'PREPARATION_NOT_SUCCEEDED',
      'MEDIA_NOT_FANNED_OUT'
    ]));
  });

  it('历史 AUTO 批次仍重新校验父协调任务与媒体账本', () => {
    const current = evidence('HISTORICAL');
    current.batch.triggerIdentity = { historicalSource: 'AUTOMATION' };
    current.preparationState = 'NEEDS_ATTENTION';
    current.preparationTaskKind = 'SHARED_PREPARATION';
    current.automaticMediaDecisions = ['FANNED_OUT', 'ACCEPTED'];
    expect(ozonSourceMediaCleanupDatabaseBlockers(current)).toEqual(expect.arrayContaining([
      'PREPARATION_NOT_SUCCEEDED',
      'MEDIA_NOT_FANNED_OUT'
    ]));
  });

  it('隔离前并发出现更新 delivery 时只把 RAW 标记为 SUPERSEDED', async () => {
    const current = evidence();
    current.batch.leaseToken = '99999999-9999-4999-8999-999999999999';
    current.newerMediaDeliveryCount = 1;
    const repository = {
      evidence: vi.fn(async () => current),
      markArtifactState: vi.fn(async () => undefined)
    };
    const service = new OzonSourceMediaCleanupService(repository as any, {} as any, { warn: vi.fn() } as any);
    await expect((service as any).markRawInboxSuperseded(current.batch, ['QUARANTINING'])).resolves.toBe(true);
    expect(repository.markArtifactState).toHaveBeenCalledWith(expect.objectContaining({
      cleanupId: current.batch.id,
      kind: 'RAW_INBOX',
      expected: ['QUARANTINING'],
      state: 'SUPERSEDED'
    }));
  });

  it('历史 DB 批次的旧根只在文件系统检查时映射，不改写原对象', async () => {
    const legacyRoot = 'G:\\01_n8n-global';
    const currentRoot = 'G:\\01_MerchRoute';
    const current = evidence('HISTORICAL');
    current.versionSnapshot = {
      sharedMaterial: {
        mediaAssets: [{
          assetId: 'asset-1', relativePath: 'variants/01/image.png', kind: 'IMAGE', sizeBytes: 12,
          sha256: 'abc', productVariantId: 'variant-1', sourceStageId: 'E005',
          sourceSubmissionId: 'submission-1', deliveredAt: '2026-08-14T00:00:00.000Z'
        }],
        variants: [{ productVariantId: 'variant-1', media: [{ assetId: 'asset-1', sortOrder: 0 }] }]
      }
    };
    const sourceMediaIdentityHash = sourceMediaIdentityHashFromSnapshot(current.versionSnapshot);
    current.versionSourceMediaIdentityHash = sourceMediaIdentityHash;
    current.batch = Object.freeze({
      ...current.batch,
      rootDirectory: legacyRoot,
      sourceMediaIdentityHash
    });
    current.targets = [];
    current.actualPublicationIds = [];
    current.artifacts = [{
      cleanupId: current.batch.id,
      kind: 'RAW_INBOX',
      state: 'READY',
      sourceRelPath: 'inbox/0000123',
      mediaIdentityHash: sourceMediaIdentityHash,
      fileCount: 0,
      totalBytes: 0,
      reclaimedBytes: 0,
      updatedAt: '2026-08-14T00:00:00.000Z'
    }];
    const persistedBatch = current.batch;
    const repository = {
      evidence: vi.fn(async () => current),
      getByGeneratedVersion: vi.fn(async () => ({ id: current.batch.id }))
    };
    const files = { snapshot: vi.fn(async () => ({
      exists: false,
      absolutePath: currentRoot,
      directorySignature: '',
      fileCount: 0,
      totalBytes: 0,
      files: [],
      stagingEmpty: true
    })) };
    const canonicalizePath = vi.fn((value: string) => value === legacyRoot ? currentRoot : value);
    const service = new OzonSourceMediaCleanupService(
      repository as any,
      files as any,
      { warn: vi.fn() } as any,
      60_000,
      5,
      canonicalizePath
    );

    await expect(service.inspect(current.batch.id)).resolves.toMatchObject({
      artifacts: [expect.objectContaining({ kind: 'RAW_INBOX', exists: false })]
    });

    expect(files.snapshot).toHaveBeenCalledWith(expect.objectContaining({
      rootDirectory: currentRoot,
      sourceRelPath: 'inbox/0000123'
    }));
    expect(current.batch).toBe(persistedBatch);
    expect(current.batch.rootDirectory).toBe(legacyRoot);
  });

  it('媒体身份哈希冻结路径、类型、大小、SHA、变体归属和顺序', () => {
    const snapshot = {
      sharedMaterial: {
        mediaAssets: [{
          assetId: 'asset-1', relativePath: 'variants/01/image.png', kind: 'IMAGE', sizeBytes: 12,
          sha256: 'abc', productVariantId: 'variant-1', sourceStageId: 'E005',
          sourceSubmissionId: 'submission-1', deliveredAt: '2026-08-14T00:00:00.000Z'
        }],
        variants: [{ productVariantId: 'variant-1', media: [{ assetId: 'asset-1', sortOrder: 0 }] }]
      }
    };
    const first = sourceMediaIdentityHashFromSnapshot(snapshot);
    const second = sourceMediaIdentityHashFromSnapshot({
      sharedMaterial: {
        ...snapshot.sharedMaterial,
        variants: [{ productVariantId: 'variant-1', media: [{ assetId: 'asset-1', sortOrder: 1 }] }]
      }
    });
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
  });

  it('严格按真实 E004/E005 manifest 验证图片、视频和变体身份', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ozon-cleanup-manifest-'));
    try {
      await mkdir(path.join(root, 'variants'), { recursive: true });
      const assets = [{
        assetId: 'video-1', submissionId: 'delivery-video', sourceSubmissionId: 'source-video',
        sourceStageId: 'E004', variantId: 'variant-1', kind: 'video', sortOrder: 0,
        relativePath: 'variants/red/videos/delivery-video/demo.mp4', sizeBytes: 21,
        sha256: 'a'.repeat(64), deliveredAt: '2026-08-14T01:00:00.000Z'
      }, {
        assetId: 'image-1', submissionId: 'delivery-image', sourceSubmissionId: 'source-image',
        sourceStageId: 'E005', variantId: 'variant-1', kind: 'image', sortOrder: 0,
        relativePath: 'variants/red/images/delivery-image/demo.png', sizeBytes: 12,
        sha256: 'b'.repeat(64), deliveredAt: '2026-08-14T01:00:01.000Z'
      }];
      const manifestPath = path.join(root, 'variants', 'variant-media-manifest.json');
      await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, SKU: '0000141', assets }));
      const frozen = assets.map((asset) => ({
        assetId: asset.assetId,
        relativePath: asset.relativePath,
        kind: asset.kind === 'video' ? 'VIDEO' as const : 'IMAGE' as const,
        sizeBytes: asset.sizeBytes,
        sha256: `sha256:${asset.sha256}`,
        productVariantId: asset.variantId,
        sourceStageId: asset.sourceStageId,
        sourceSubmissionId: asset.submissionId,
        deliveredAt: asset.deliveredAt
      }));
      const snapshot = {
        absolutePath: root, directorySignature: 'sha256:test', fileCount: 3,
        byteCount: 33, files: [], stagingEmpty: true
      };
      await expect(validateRawManifest({ id: 'cleanup-1', sku: '0000141' }, snapshot, frozen)).resolves.toBeUndefined();

      assets[0]!.kind = 'image';
      await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, SKU: '0000141', assets }));
      await expect(validateRawManifest({ id: 'cleanup-1', sku: '0000141' }, snapshot, frozen))
        .rejects.toMatchObject({ code: 'OZON_SOURCE_MEDIA_CLEANUP_BLOCKED' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function evidence(source: 'MANUAL' | 'AUTOMATION' | 'HISTORICAL' = 'MANUAL'): OzonSourceMediaCleanupEvidence {
  const targets = [target(storeA, '44444444-4444-4444-8444-444444444444', '66666666-6666-4666-8666-666666666666'),
    target(storeB, '55555555-5555-4555-8555-555555555555', '77777777-7777-4777-8777-777777777777')];
  return {
    batch: {
      id: '88888888-8888-4888-8888-888888888888', generatedVersionId: versionId, sku: '0000123', revision: 3,
      source, rootDirectory: 'G:/ozon', materialHash: hash, sourceMediaIdentityHash: hash,
      expectedTargetHash: targetHash(targets), expectedTargetCount: 2, triggerIdentity: {}, state: 'READY',
      rowVersion: 1, attemptCount: 0, nextAttemptAt: '2026-08-14T00:00:00.000Z', reclaimedBytes: 0,
      createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z'
    },
    artifacts: [],
    targets,
    versionSnapshot: {}, versionMaterialHash: hash, versionSourceMediaIdentityHash: hash,
    actualPublicationIds: targets.map((item) => item.publicationId), activeJobCount: 0, unsafeGatewayCount: 0,
    activeSlotCount: 0,
    ...(source === 'AUTOMATION' ? {
      preparationState: 'SUCCEEDED', preparationTaskKind: 'SHARED_PREPARATION',
      automaticMediaDecisions: ['FANNED_OUT', 'FANNED_OUT']
    } : { automaticMediaDecisions: [] }),
    newerMediaDeliveryCount: 0
  };
}

function target(storeId: string, publicationId: string, jobId: string) {
  return {
    storeId, publicationId, jobId, taskId: `task-${storeId}`,
    publicationStatus: 'SUCCEEDED', publicationGeneratedVersionId: versionId,
    runtimeState: 'SUCCEEDED', runtimeTaskId: `task-${storeId}`, runtimeTaskKind: 'STORE_PUBLICATION',
    runtimeWorkRelPath: `success/2026-08-14/task-${storeId}`,
    runtimeDirectoryStage: 'SUCCESS', runtimeDirectorySignature: hash
  };
}

function targetHash(targets: ReturnType<typeof target>[]): string {
  const normalized = targets.map(({ storeId, publicationId, jobId, taskId }) => ({ storeId, publicationId, jobId, taskId }))
    .sort((left, right) => left.storeId.localeCompare(right.storeId));
  return `sha256:${createHash('sha256').update(JSON.stringify({ generatedVersionId: versionId, targets: normalized })).digest('hex')}`;
}
