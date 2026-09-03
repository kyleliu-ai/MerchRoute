import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import {
  AppError,
  type OzonPublicationPlan,
  type OzonSourceMediaCleanupArtifactKind,
  type OzonSourceMediaCleanupSummary
} from '@n8n-media-review/shared';
import {
  OzonSourceMediaCleanupRepository,
  type OzonSourceMediaCleanupBatch,
  type OzonSourceMediaCleanupEvidence,
  type OzonSourceMediaCleanupTargetRegistration
} from '../../repositories/ozon-source-media-cleanup.js';
import {
  OzonSourceMediaFiles,
  type OzonFrozenMediaFile,
  type OzonQuarantineResult,
  type OzonSourceMediaFileSnapshot
} from './source-files.js';
import { safeOzonSignatureEqual, signIntakeTicket, signSharedSourceMarker } from '../ozon-stores/integrity.js';

export type OzonSourceMediaCleanupRunResult = {
  checked: number;
  waiting: number;
  cleaned: number;
  retried: number;
  blocked: number;
  supersededArtifacts: number;
};

export type OzonSourceMediaHistoricalPlanItem = {
  generatedVersionId: string;
  sku: string;
  revision: number;
  source: 'MANUAL' | 'AUTOMATION';
  eligible: boolean;
  reasons: string[];
  targetCount: number;
  rawBytes: number;
  sharedBytes: number;
  sourceMediaIdentityHash: string;
};

export class OzonSourceMediaCleanupService {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly owner = `ozon-source-cleanup:${process.pid}:${randomUUID()}`;

  constructor(
    readonly repository: OzonSourceMediaCleanupRepository,
    readonly files: OzonSourceMediaFiles,
    private readonly logger: FastifyBaseLogger,
    private readonly intervalMs = 60_000,
    private readonly batchSize = 5,
    private readonly canonicalizePath: (value: string) => string = (value) => value
  ) {}

  start(): void {
    if (this.timer || process.env.MERCHROUTE_DISABLE_BACKGROUND_WORKERS === 'true'
      || process.env.MERCHROUTE_OZON_SOURCE_MEDIA_CLEANUP_ENABLED !== 'true') return;
    this.timer = setInterval(() => { void this.runDue(); }, this.intervalMs);
    this.timer.unref?.();
    void this.runDue();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async registerPlan(input: {
    plan: OzonPublicationPlan;
    source: 'MANUAL' | 'AUTOMATION';
    rootDirectory: string;
    requestId?: string;
    preparationJobId?: string;
  }): Promise<OzonSourceMediaCleanupBatch> {
    const targets: OzonSourceMediaCleanupTargetRegistration[] = input.plan.items.map((item) => ({
      storeId: item.storeId,
      publicationId: item.publicationId,
      jobId: item.plannedJobId,
      taskId: item.taskId
    }));
    if (!targets.length) throw new AppError('CONFIG_INVALID', '零目标发布计划不创建 OZON 媒体清理批次', undefined, 409);
    const expectedTargetHash = targetHash(input.plan.generatedVersionId, targets);
    return this.repository.registerBatch({
      generatedVersionId: input.plan.generatedVersionId,
      sku: input.plan.sku,
      revision: input.plan.revision,
      source: input.source,
      rootDirectory: this.canonicalizePath(input.rootDirectory),
      materialHash: input.plan.materialHash,
      sourceMediaIdentityHash: input.plan.sourceMediaIdentityHash,
      expectedTargetHash,
      triggerIdentity: {
        schemaVersion: 1,
        planHash: input.plan.planHash,
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(input.preparationJobId ? { preparationJobId: input.preparationJobId } : {})
      },
      targets
    });
  }

  async summary(generatedVersionId: string): Promise<OzonSourceMediaCleanupSummary | undefined> {
    return this.repository.getByGeneratedVersion(generatedVersionId);
  }

  async assertVersionAvailable(generatedVersionId: string): Promise<void> {
    await this.repository.assertVersionAvailable(generatedVersionId);
  }

  async runDue(limit = this.batchSize): Promise<OzonSourceMediaCleanupRunResult> {
    if (this.running || !this.repository.configured) return emptyResult();
    this.running = true;
    const result = emptyResult();
    try {
      const batches = await this.repository.claimDue(this.owner, limit);
      for (const batch of batches) {
        result.checked += 1;
        try {
          const outcome = await this.process(batch, true);
          result[outcome] += 1;
        } catch (error) {
          const appError = error instanceof AppError ? error : undefined;
          if (appError?.code === 'OZON_SOURCE_MEDIA_BUSY') {
            await this.repository.retry(batch, appError.code, appError.message, retryDelay(batch.attemptCount));
            result.retried += 1;
          } else if (appError?.code === 'OZON_SOURCE_MEDIA_CLEANUP_BLOCKED'
            || appError?.code === 'PATH_TRAVERSAL_BLOCKED'
            || appError?.code === 'VERSION_CONFLICT') {
            await this.repository.block(batch, appError.code, appError.message);
            result.blocked += 1;
          } else {
            await this.repository.retry(
              batch,
              appError?.code || 'OZON_SOURCE_MEDIA_CLEANUP_FAILED',
              error instanceof Error ? error.message : 'OZON 媒体清理失败',
              retryDelay(batch.attemptCount)
            );
            result.retried += 1;
          }
          this.logger.warn({ err: error, cleanupId: batch.id, sku: batch.sku }, 'OZON 来源媒体清理批次处理失败');
        }
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  async inspect(cleanupId: string): Promise<{
    eligible: boolean;
    reasons: string[];
    summary: OzonSourceMediaCleanupSummary;
    artifacts: Array<{ kind: OzonSourceMediaCleanupArtifactKind; exists: boolean; fileCount: number; totalBytes: number; directorySignature: string }>;
  }> {
    const evidence = await this.repository.evidence(cleanupId);
    const runtimeBatch = this.withRuntimeRoot(evidence.batch);
    const frozenMedia = frozenMediaFromVersion(evidence);
    const reasons = ozonSourceMediaCleanupDatabaseBlockers(evidence);
    const artifacts: Array<{ kind: OzonSourceMediaCleanupArtifactKind; exists: boolean; fileCount: number; totalBytes: number; directorySignature: string }> = [];
    for (const artifact of evidence.artifacts) {
      try {
        const snapshot = await this.files.snapshot({
          rootDirectory: runtimeBatch.rootDirectory,
          sourceRelPath: artifact.sourceRelPath,
          mediaIdentityHash: evidence.batch.sourceMediaIdentityHash,
          frozenMedia
        });
        if (!snapshot.exists) reasons.push(`SOURCE_ABSENT:${artifact.kind}`);
        if (!snapshot.stagingEmpty) reasons.push(`STAGING_NOT_EMPTY:${artifact.kind}`);
        if (artifact.kind === 'RAW_INBOX' && snapshot.exists) {
          await validateRawManifest(evidence.batch, snapshot, frozenMedia);
        }
        if (artifact.kind === 'SHARED_VERSION' && snapshot.exists) {
          await validateSharedMarker(evidence.batch, snapshot);
        }
        artifacts.push({ kind: artifact.kind, exists: snapshot.exists, fileCount: snapshot.fileCount,
          totalBytes: snapshot.totalBytes, directorySignature: snapshot.directorySignature });
      } catch (error) {
        reasons.push(`${error instanceof AppError ? error.code : 'FILESYSTEM_INVALID'}:${artifact.kind}`);
      }
    }
    for (const target of evidence.targets) {
      try { await validateSuccessArchive(runtimeBatch, target); }
      catch (error) { reasons.push(error instanceof AppError ? error.code : 'OZON_SUCCESS_ARCHIVE_INVALID'); }
    }
    return {
      eligible: reasons.length === 0,
      reasons: [...new Set(reasons)],
      summary: (await this.repository.getByGeneratedVersion(evidence.batch.generatedVersionId))!,
      artifacts
    };
  }

  async runOne(cleanupId: string): Promise<OzonSourceMediaCleanupSummary> {
    const claimed = await this.repository.claimById(cleanupId, this.owner);
    await this.process(claimed, true);
    return (await this.repository.getByGeneratedVersion(claimed.generatedVersionId))!;
  }

  async planHistorical(rootDirectory: string, skus?: string[]): Promise<OzonSourceMediaHistoricalPlanItem[]> {
    rootDirectory = this.canonicalizePath(rootDirectory);
    const groups = await this.repository.listHistoricalGroups(skus);
    const output: OzonSourceMediaHistoricalPlanItem[] = [];
    for (const group of groups) {
      const reasons: string[] = [...group.databaseReasons];
      const versionSnapshot = await this.readVersionEvidence(group.generatedVersionId);
      const reconstructedHash = sourceMediaIdentityHashFromSnapshot(versionSnapshot);
      const sourceHash = group.sourceMediaIdentityHash || reconstructedHash;
      if (!/^sha256:[a-f0-9]{64}$/.test(sourceHash)) reasons.push('SOURCE_MEDIA_IDENTITY_UNPROVEN');
      else if (sourceHash !== reconstructedHash) reasons.push('SOURCE_MEDIA_IDENTITY_MISMATCH');
      let rawBytes = 0;
      let sharedBytes = 0;
      if (/^sha256:[a-f0-9]{64}$/.test(sourceHash)) {
        const frozenMedia = frozenMediaFromSnapshot(versionSnapshot);
        for (const [kind, sourceRelPath] of [
          ['RAW_INBOX', `inbox/${group.sku}`],
          ['SHARED_VERSION', `shared/${group.sku}/${group.generatedVersionId}`]
        ] as const) {
          try {
            const snapshot = await this.files.snapshot({ rootDirectory, sourceRelPath, mediaIdentityHash: sourceHash, frozenMedia });
            if (!snapshot.exists) reasons.push(`SOURCE_ABSENT:${kind}`);
            if (!snapshot.stagingEmpty) reasons.push(`STAGING_NOT_EMPTY:${kind}`);
            if (kind === 'RAW_INBOX' && snapshot.exists) {
              await validateRawManifest({
                id: `historical:${group.generatedVersionId}`,
                sku: group.sku
              }, snapshot, frozenMedia);
            }
            if (kind === 'SHARED_VERSION' && snapshot.exists) {
              await validateSharedMarker({
                id: `historical:${group.generatedVersionId}`,
                sku: group.sku,
                revision: group.revision,
                generatedVersionId: group.generatedVersionId
              }, snapshot);
            }
            if (kind === 'RAW_INBOX') rawBytes = snapshot.totalBytes;
            else sharedBytes = snapshot.totalBytes;
          } catch (error) {
            reasons.push(`${error instanceof AppError ? error.code : 'FILESYSTEM_INVALID'}:${kind}`);
          }
        }
        for (const target of group.targets) {
          try {
            await validateSuccessArchive({
              id: `historical:${group.generatedVersionId}`,
              rootDirectory,
              sku: group.sku,
              revision: group.revision
            }, target);
          } catch (error) {
            reasons.push(error instanceof AppError ? error.code : 'OZON_SUCCESS_ARCHIVE_INVALID');
          }
        }
      }
      output.push({
        generatedVersionId: group.generatedVersionId,
        sku: group.sku,
        revision: group.revision,
        source: group.source,
        eligible: reasons.length === 0,
        reasons: [...new Set(reasons)],
        targetCount: group.targets.length,
        rawBytes,
        sharedBytes,
        sourceMediaIdentityHash: sourceHash
      });
    }
    return output;
  }

  async registerHistorical(generatedVersionId: string, rootDirectory: string): Promise<OzonSourceMediaCleanupBatch> {
    rootDirectory = this.canonicalizePath(rootDirectory);
    const group = (await this.repository.listHistoricalGroups()).find((item) => item.generatedVersionId === generatedVersionId);
    if (!group) throw new AppError('NOT_FOUND', 'OZON 历史稳定版本不存在或已登记清理批次', { generatedVersionId }, 404);
    const snapshot = await this.readVersionEvidence(generatedVersionId);
    const sourceMediaIdentityHash = group.sourceMediaIdentityHash || sourceMediaIdentityHashFromSnapshot(snapshot);
    const plan = await this.planHistorical(rootDirectory, [group.sku]);
    const item = plan.find((candidate) => candidate.generatedVersionId === generatedVersionId);
    if (!item?.eligible) throw new AppError('OZON_SOURCE_MEDIA_CLEANUP_BLOCKED', 'OZON 历史媒体清理候选未通过 dry-run', {
      generatedVersionId,
      reasons: item?.reasons || ['CANDIDATE_NOT_FOUND']
    }, 409);
    const targets = group.targets;
    return this.repository.registerBatch({
      generatedVersionId,
      sku: group.sku,
      revision: group.revision,
      source: 'HISTORICAL',
      rootDirectory,
      materialHash: group.materialHash,
      sourceMediaIdentityHash,
      expectedTargetHash: targetHash(generatedVersionId, targets),
      triggerIdentity: { schemaVersion: 1, historicalSource: group.source, ...(group.preparationJobId ? { preparationJobId: group.preparationJobId } : {}) },
      targets
    });
  }

  private async process(batch: OzonSourceMediaCleanupBatch, mutate: boolean): Promise<'waiting' | 'cleaned' | 'supersededArtifacts'> {
    return this.repository.withSkuAdvisoryLock(batch.sku, () => this.processWithSkuLock(batch, mutate));
  }

  private async processWithSkuLock(batch: OzonSourceMediaCleanupBatch, mutate: boolean): Promise<'waiting' | 'cleaned' | 'supersededArtifacts'> {
    if (!batch.leaseToken) throw new AppError('TASK_LOCKED', 'OZON 媒体清理批次缺少 lease', { cleanupId: batch.id }, 409);
    const evidence = await this.repository.evidence(batch.id);
    const runtimeBatch = this.withRuntimeRoot(batch);
    const blockers = ozonSourceMediaCleanupDatabaseBlockers(evidence);
    if (blockers.length) {
      if (mutate) await this.repository.releaseWaiting(batch, blockers);
      return 'waiting';
    }
    const frozenMedia = frozenMediaFromVersion(evidence);
    for (const target of evidence.targets) await validateSuccessArchive(runtimeBatch, target);
    let superseded = false;
    for (const artifact of evidence.artifacts) {
      if (['CLEANED', 'SUPERSEDED'].includes(artifact.state)) continue;
      if (artifact.kind === 'RAW_INBOX' && evidence.newerMediaDeliveryCount > 0) {
        await this.repository.markArtifactState({
          cleanupId: batch.id,
          leaseToken: batch.leaseToken,
          kind: artifact.kind,
          expected: ['WAITING_TARGETS', 'READY', 'RETRY_WAIT'],
          state: 'SUPERSEDED',
          errorCode: 'SOURCE_MEDIA_SUPERSEDED',
          errorMessage: '原始 inbox 已出现更新的媒体投递，旧清理批次保留该目录'
        });
        superseded = true;
        continue;
      }
      await this.processArtifact(runtimeBatch, evidence, artifact.kind, frozenMedia);
    }
    await this.repository.finalize(batch);
    return superseded ? 'supersededArtifacts' : 'cleaned';
  }

  private async processArtifact(
    batch: OzonSourceMediaCleanupBatch,
    evidence: OzonSourceMediaCleanupEvidence,
    kind: OzonSourceMediaCleanupArtifactKind,
    frozenMedia: OzonFrozenMediaFile[]
  ): Promise<void> {
    const artifact = evidence.artifacts.find((item) => item.kind === kind);
    if (!artifact || !batch.leaseToken) throw new AppError('VERSION_CONFLICT', 'OZON 媒体清理 artifact 缺失', { cleanupId: batch.id, kind }, 409);
    if (artifact.state === 'QUARANTINED') {
      await this.files.deleteQuarantine({
        rootDirectory: batch.rootDirectory, cleanupId: batch.id, sku: batch.sku, kind,
        sourceRelPath: artifact.sourceRelPath, quarantineRelPath: artifact.quarantineRelPath!,
        mediaIdentityHash: batch.sourceMediaIdentityHash, directorySignature: artifact.directorySignature!
      });
      await this.repository.markArtifactState({
        cleanupId: batch.id, leaseToken: batch.leaseToken, kind,
        expected: ['QUARANTINED'], state: 'CLEANED', reclaimedBytes: artifact.totalBytes
      });
      return;
    }
    if (artifact.state === 'QUARANTINING' && artifact.quarantineRelPath) {
      const resumed = await this.files.quarantine({
        rootDirectory: batch.rootDirectory, cleanupId: batch.id, sku: batch.sku, kind,
        sourceRelPath: artifact.sourceRelPath, mediaIdentityHash: batch.sourceMediaIdentityHash,
        expectedDirectorySignature: artifact.directorySignature, frozenMedia,
        expectedQuarantineRelPath: artifact.quarantineRelPath
      });
      if (resumed.state === 'SOURCE_ABSENT') throw new AppError('OZON_SOURCE_MEDIA_CLEANUP_BLOCKED', 'QUARANTINING 状态缺少源目录和隔离目录，禁止推断已删除', { cleanupId: batch.id, kind }, 409);
      await this.repository.markArtifactState({
        cleanupId: batch.id, leaseToken: batch.leaseToken, kind,
        expected: ['QUARANTINING'], state: 'QUARANTINED'
      });
      await this.files.deleteQuarantine({
        rootDirectory: batch.rootDirectory, cleanupId: batch.id, sku: batch.sku, kind,
        sourceRelPath: artifact.sourceRelPath, quarantineRelPath: artifact.quarantineRelPath,
        mediaIdentityHash: batch.sourceMediaIdentityHash, directorySignature: artifact.directorySignature!
      });
      await this.repository.markArtifactState({
        cleanupId: batch.id, leaseToken: batch.leaseToken, kind,
        expected: ['QUARANTINED'], state: 'CLEANED', reclaimedBytes: artifact.totalBytes
      });
      return;
    }
    let snapshot: OzonSourceMediaFileSnapshot;
    try {
      snapshot = await this.files.snapshot({
        rootDirectory: batch.rootDirectory,
        sourceRelPath: artifact.sourceRelPath,
        mediaIdentityHash: batch.sourceMediaIdentityHash,
        frozenMedia
      });
    } catch (error) {
      if (kind === 'RAW_INBOX' && await this.markRawInboxSuperseded(batch, ['WAITING_TARGETS', 'READY', 'RETRY_WAIT'])) return;
      throw error;
    }
    if (!snapshot.exists) throw new AppError('OZON_SOURCE_MEDIA_CLEANUP_BLOCKED', 'OZON 媒体源目录在首次隔离前不存在', { cleanupId: batch.id, kind }, 409);
    if (!snapshot.stagingEmpty) throw new AppError('OZON_SOURCE_MEDIA_BUSY', 'OZON 媒体目录仍包含 staging，稍后重试', { cleanupId: batch.id, kind }, 409);
    if (kind === 'RAW_INBOX') await validateRawManifest(batch, snapshot, frozenMedia);
    if (kind === 'SHARED_VERSION') await validateSharedMarker(evidence.batch, snapshot);
    const quarantineRelPath = `.cleanup/${batch.id}/${kind}`;
    await this.repository.markArtifactState({
      cleanupId: batch.id, leaseToken: batch.leaseToken, kind,
      expected: ['WAITING_TARGETS', 'READY', 'RETRY_WAIT'], state: 'QUARANTINING',
      quarantineRelPath, directorySignature: snapshot.directorySignature,
      fileCount: snapshot.fileCount, totalBytes: snapshot.totalBytes
    });
    let moved: OzonQuarantineResult;
    try {
      moved = await this.files.quarantine({
        rootDirectory: batch.rootDirectory, cleanupId: batch.id, sku: batch.sku, kind,
        sourceRelPath: artifact.sourceRelPath, mediaIdentityHash: batch.sourceMediaIdentityHash,
        expectedDirectorySignature: snapshot.directorySignature, frozenMedia,
        expectedQuarantineRelPath: quarantineRelPath
      });
    } catch (error) {
      const quarantineExists = kind === 'RAW_INBOX'
        ? await this.files.quarantineExists(batch.rootDirectory, quarantineRelPath)
        : true;
      if (kind === 'RAW_INBOX' && !quarantineExists
        && await this.markRawInboxSuperseded(batch, ['QUARANTINING'])) return;
      throw error;
    }
    if (moved.state === 'SOURCE_ABSENT') {
      throw new AppError('OZON_SOURCE_MEDIA_CLEANUP_BLOCKED', 'OZON 媒体目录在隔离提交前消失', { cleanupId: batch.id, kind }, 409);
    }
    await this.repository.markArtifactState({
      cleanupId: batch.id, leaseToken: batch.leaseToken, kind,
      expected: ['QUARANTINING'], state: 'QUARANTINED'
    });
    await this.files.deleteQuarantine({
      rootDirectory: batch.rootDirectory, cleanupId: batch.id, sku: batch.sku, kind,
      sourceRelPath: artifact.sourceRelPath, quarantineRelPath,
      mediaIdentityHash: batch.sourceMediaIdentityHash, directorySignature: snapshot.directorySignature
    });
    await this.repository.markArtifactState({
      cleanupId: batch.id, leaseToken: batch.leaseToken, kind,
      expected: ['QUARANTINED'], state: 'CLEANED', reclaimedBytes: snapshot.totalBytes
    });
  }

  private async markRawInboxSuperseded(
    batch: OzonSourceMediaCleanupBatch,
    expected: Array<'WAITING_TARGETS' | 'READY' | 'RETRY_WAIT' | 'QUARANTINING'>
  ): Promise<boolean> {
    if (!batch.leaseToken) return false;
    const fresh = await this.repository.evidence(batch.id);
    if (fresh.newerMediaDeliveryCount < 1) return false;
    await this.repository.markArtifactState({
      cleanupId: batch.id,
      leaseToken: batch.leaseToken,
      kind: 'RAW_INBOX',
      expected,
      state: 'SUPERSEDED',
      errorCode: 'SOURCE_MEDIA_SUPERSEDED',
      errorMessage: '原始 inbox 已出现更新的媒体投递，旧清理批次保留新素材'
    });
    return true;
  }

  private async readVersionEvidence(generatedVersionId: string): Promise<Record<string, unknown>> {
    const evidence = await this.repository.evidenceForVersionSnapshot?.(generatedVersionId);
    if (evidence) return evidence;
    throw new AppError('NOT_FOUND', 'OZON 稳定版本快照不可读取', { generatedVersionId }, 404);
  }

  private withRuntimeRoot<T extends OzonSourceMediaCleanupBatch>(batch: T): T {
    return { ...batch, rootDirectory: this.canonicalizePath(batch.rootDirectory) };
  }
}

export function ozonSourceMediaCleanupDatabaseBlockers(evidence: OzonSourceMediaCleanupEvidence): string[] {
  const reasons: string[] = [];
  const batch = evidence.batch;
  const expectedPublicationIds = evidence.targets.map((target) => target.publicationId).sort();
  if (evidence.targets.length !== batch.expectedTargetCount
    || targetHash(batch.generatedVersionId, evidence.targets) !== batch.expectedTargetHash) reasons.push('TARGET_SET_MISMATCH');
  if (JSON.stringify(expectedPublicationIds) !== JSON.stringify([...evidence.actualPublicationIds].sort())) reasons.push('PUBLICATION_SET_MISMATCH');
  if (evidence.versionMaterialHash !== batch.materialHash
    || evidence.versionSourceMediaIdentityHash !== batch.sourceMediaIdentityHash) reasons.push('VERSION_IDENTITY_MISMATCH');
  if (evidence.activeJobCount > 0) reasons.push('ACTIVE_JOB_PRESENT');
  if (evidence.activeSlotCount > 0) reasons.push('ACTIVE_SLOT_PRESENT');
  if (evidence.unsafeGatewayCount > 0) reasons.push('REMOTE_STATE_UNPROVEN');
  for (const target of evidence.targets) {
    if (target.publicationGeneratedVersionId !== batch.generatedVersionId) reasons.push(`PUBLICATION_VERSION_MISMATCH:${target.storeId}`);
    if (target.publicationStatus !== 'SUCCEEDED') reasons.push(`PUBLICATION_${target.publicationStatus || 'MISSING'}:${target.storeId}`);
    if (target.runtimeState !== 'SUCCEEDED') reasons.push(`JOB_${target.runtimeState || 'MISSING'}:${target.storeId}`);
    if (target.runtimeTaskKind !== 'STORE_PUBLICATION') reasons.push(`TASK_KIND_MISMATCH:${target.storeId}`);
    if (target.runtimeTaskId !== target.taskId) reasons.push(`TASK_ID_MISMATCH:${target.storeId}`);
    if (target.runtimeDirectoryStage !== 'SUCCESS' || !target.runtimeWorkRelPath?.match(/^success\/\d{4}-\d{2}-\d{2}\//)) {
      reasons.push(`SUCCESS_ARCHIVE_MISSING:${target.storeId}`);
    }
    if (!target.runtimeDirectorySignature) reasons.push(`DIRECTORY_SIGNATURE_MISSING:${target.storeId}`);
    if (target.runtimeLeaseOwner || (target.runtimeLeaseExpiresAt && Date.parse(target.runtimeLeaseExpiresAt) > Date.now())) {
      reasons.push(`LEASE_ACTIVE:${target.storeId}`);
    }
  }
  if (batch.source === 'AUTOMATION' || batch.triggerIdentity.historicalSource === 'AUTOMATION') {
    if (evidence.preparationTaskKind !== 'SHARED_PREPARATION' || evidence.preparationState !== 'SUCCEEDED') reasons.push('PREPARATION_NOT_SUCCEEDED');
    if (!evidence.automaticMediaDecisions.length || evidence.automaticMediaDecisions.some((decision) => decision !== 'FANNED_OUT')) {
      reasons.push('MEDIA_NOT_FANNED_OUT');
    }
  }
  return [...new Set(reasons)];
}

function frozenMediaFromVersion(evidence: OzonSourceMediaCleanupEvidence): OzonFrozenMediaFile[] {
  const files = frozenMediaFromSnapshot(evidence.versionSnapshot);
  if (sourceMediaIdentityHashFromSnapshot(evidence.versionSnapshot) !== evidence.batch.sourceMediaIdentityHash) {
    throw new AppError('VERSION_CONFLICT', 'OZON 稳定版本媒体身份哈希无法重现', { cleanupId: evidence.batch.id }, 409);
  }
  return files;
}

function frozenMediaFromSnapshot(snapshot: Record<string, unknown>): OzonFrozenMediaFile[] {
  const shared = object(snapshot.sharedMaterial);
  const assets = Array.isArray(shared.mediaAssets) ? shared.mediaAssets.map(object) : [];
  return assets.map((asset) => ({
    assetId: String(asset.assetId || ''),
    relativePath: portable(String(asset.relativePath || '')),
    kind: String(asset.kind || '').toLocaleLowerCase('en-US') === 'video' ? 'VIDEO' : 'IMAGE',
    sizeBytes: Number(asset.sizeBytes || 0),
    sha256: String(asset.sha256 || ''),
    ...(asset.productVariantId ? { productVariantId: String(asset.productVariantId) } : {}),
    ...(asset.sourceStageId ? { sourceStageId: String(asset.sourceStageId) } : {}),
    ...(asset.sourceSubmissionId ? { sourceSubmissionId: String(asset.sourceSubmissionId) } : {}),
    ...(asset.deliveredAt ? { deliveredAt: String(asset.deliveredAt) } : {})
  }));
}

export function sourceMediaIdentityHashFromSnapshot(snapshot: Record<string, unknown> | undefined): string {
  if (!snapshot) return '';
  const shared = object(snapshot.sharedMaterial);
  const mediaAssets = Array.isArray(shared.mediaAssets) ? shared.mediaAssets.map(object) : [];
  const variants = Array.isArray(shared.variants) ? shared.variants.map(object) : [];
  if (!mediaAssets.length) return '';
  const identity = {
    schemaVersion: 1,
    mediaAssets: mediaAssets.map((asset) => ({
      assetId: asset.assetId,
      relativePath: asset.relativePath,
      kind: asset.kind,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
      productVariantId: asset.productVariantId || null,
      sourceStageId: asset.sourceStageId || null,
      sourceSubmissionId: asset.sourceSubmissionId || null,
      deliveredAt: asset.deliveredAt || null
    })),
    variants: variants.map((variant) => ({
      productVariantId: variant.productVariantId,
      media: Array.isArray(variant.media) ? variant.media.map((entry) => {
        const media = object(entry);
        return { assetId: media.assetId, sortOrder: media.sortOrder };
      }) : []
    }))
  };
  return `sha256:${createHash('sha256').update(stableJson(identity)).digest('hex')}`;
}

export async function validateRawManifest(
  batch: Pick<OzonSourceMediaCleanupBatch, 'id' | 'sku'>,
  snapshot: OzonSourceMediaFileSnapshot,
  frozenMedia: OzonFrozenMediaFile[]
): Promise<void> {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await readFile(path.join(snapshot.absolutePath, 'variants', 'variant-media-manifest.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    throw new AppError('OZON_SOURCE_MEDIA_CLEANUP_BLOCKED', 'OZON 原始 inbox 缺少有效媒体清单', { cleanupId: batch.id }, 409);
  }
  const assets = Array.isArray(manifest.assets) ? manifest.assets.map(object) : [];
  const byPath = new Map<string, Record<string, any>>();
  for (const asset of assets) {
    const relativePath = portable(String(asset.relativePath || ''));
    if (!relativePath || byPath.has(relativePath)) {
      throw new AppError('OZON_SOURCE_MEDIA_CLEANUP_BLOCKED', 'OZON 原始媒体清单包含空路径或重复路径', { cleanupId: batch.id, relativePath }, 409);
    }
    byPath.set(relativePath, asset);
  }
  const expectedPaths = new Set(frozenMedia.map((asset) => portable(asset.relativePath)));
  if (![1, 2].includes(Number(manifest.schemaVersion)) || String(manifest.SKU || '') !== batch.sku
    || byPath.size !== expectedPaths.size || [...byPath].some(([relativePath]) => !expectedPaths.has(relativePath))) {
    throw new AppError('OZON_SOURCE_MEDIA_CLEANUP_BLOCKED', 'OZON 原始媒体清单与稳定版本文件集合不一致', {
      cleanupId: batch.id,
      manifestAssetCount: byPath.size,
      frozenAssetCount: expectedPaths.size
    }, 409);
  }
  for (const frozen of frozenMedia) {
    const current = byPath.get(portable(frozen.relativePath));
    const mismatches = !current ? ['relativePath'] : [
      current.assetId && frozen.assetId && String(current.assetId) !== frozen.assetId ? 'assetId' : '',
      String(current.kind || '').toLocaleUpperCase('en-US') !== frozen.kind ? 'kind' : '',
      Number(current.sizeBytes || 0) !== frozen.sizeBytes ? 'sizeBytes' : '',
      normalizeHash(String(current.sha256 || '')) !== normalizeHash(frozen.sha256) ? 'sha256' : '',
      frozen.productVariantId && String(current.variantId || '') !== frozen.productVariantId ? 'productVariantId' : '',
      frozen.sourceStageId && String(current.sourceStageId || '') !== frozen.sourceStageId ? 'sourceStageId' : '',
      frozen.sourceSubmissionId && String(current.submissionId || '') !== frozen.sourceSubmissionId ? 'sourceSubmissionId' : '',
      frozen.deliveredAt && String(current.deliveredAt || '') !== frozen.deliveredAt ? 'deliveredAt' : ''
    ].filter(Boolean);
    if (mismatches.length) {
      throw new AppError('OZON_SOURCE_MEDIA_CLEANUP_BLOCKED', 'OZON 原始媒体清单身份已漂移', {
        cleanupId: batch.id,
        relativePath: frozen.relativePath,
        mismatches
      }, 409);
    }
  }
}

async function validateSharedMarker(
  batch: Pick<OzonSourceMediaCleanupBatch, 'id' | 'sku' | 'revision' | 'generatedVersionId'>,
  snapshot: OzonSourceMediaFileSnapshot
): Promise<void> {
  let marker: Record<string, unknown>;
  try { marker = JSON.parse(await readFile(path.join(snapshot.absolutePath, '.ozon-shared-source.json'), 'utf8')) as Record<string, unknown>; }
  catch { throw new AppError('OZON_SOURCE_MEDIA_CLEANUP_BLOCKED', 'OZON shared 稳定版本缺少完整性 marker', { cleanupId: batch.id }, 409); }
  const product = await readFile(path.join(snapshot.absolutePath, 'product.json'));
  const productHash = `sha256:${createHash('sha256').update(product).digest('hex')}`;
  const signedMarker = {
    schemaVersion: Number(marker.schemaVersion || 0),
    sku: String(marker.sku || ''),
    revision: Number(marker.revision || 0),
    generatedVersionId: String(marker.generatedVersionId || ''),
    productContentHash: String(marker.productContentHash || ''),
    importedFrom: String(marker.importedFrom || '')
  };
  const markerSignature = String(marker.integritySignature || '');
  if (String(marker.sku || '') !== batch.sku
    || Number(marker.revision || 0) !== batch.revision
    || String(marker.generatedVersionId || '') !== batch.generatedVersionId
    || String(marker.productContentHash || '') !== productHash
    || String(marker.importedFrom || '') !== 'GENERATED_VERSION_SNAPSHOT'
    || !markerSignature
    || !safeOzonSignatureEqual(signSharedSourceMarker(signedMarker), markerSignature)) {
    throw new AppError('OZON_SOURCE_MEDIA_CLEANUP_BLOCKED', 'OZON shared 稳定版本 marker 身份不一致', {
      cleanupId: batch.id,
      generatedVersionId: batch.generatedVersionId
    }, 409);
  }
}

async function validateSuccessArchive(
  batch: Pick<OzonSourceMediaCleanupBatch, 'id' | 'rootDirectory' | 'sku' | 'revision'>,
  target: OzonSourceMediaCleanupEvidence['targets'][number]
): Promise<void> {
  const relPath = portable(target.runtimeWorkRelPath || '');
  if (!/^success\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9._-]+$/.test(relPath)) throw archiveError('OZON 成功归档路径无效', { relPath });
  const root = await realpath(batch.rootDirectory);
  const directory = path.resolve(root, ...relPath.split('/'));
  assertInside(root, directory);
  const info = await lstat(directory).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw archiveError('OZON 成功归档目录不存在或不安全', { relPath });
  const markerInfo = await lstat(path.join(directory, '.ozon-intake.json')).catch(() => undefined);
  const productInfo = await lstat(path.join(directory, 'product.json')).catch(() => undefined);
  if (!markerInfo?.isFile() || markerInfo.isSymbolicLink() || !productInfo?.isFile() || productInfo.isSymbolicLink()) {
    throw archiveError('OZON 成功归档缺少安全 marker 或 product.json', { relPath });
  }
  const marker = JSON.parse(await readFile(path.join(directory, '.ozon-intake.json'), 'utf8')) as Record<string, unknown>;
  const productHash = `sha256:${await hashFile(path.join(directory, 'product.json'))}`;
  const ticket = String(marker.ticket || '');
  const signedTicket = { ...marker };
  delete signedTicket.ticket;
  if (String(marker.jobId || '') !== target.jobId || String(marker.taskId || '') !== target.taskId
    || String(marker.storeId || '') !== target.storeId || String(marker.publicationId || '') !== target.publicationId
    || String(marker.sku || '') !== batch.sku || Number(marker.revision || 0) !== batch.revision
    || String(marker.productContentHash || '') !== target.runtimeDirectorySignature
    || productHash !== target.runtimeDirectorySignature
    || !ticket
    || !safeOzonSignatureEqual(signIntakeTicket(signedTicket), ticket)) {
    throw archiveError('OZON 成功归档身份或 product.json 签名不一致', { relPath, cleanupId: batch.id });
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function targetHash(generatedVersionId: string, targets: OzonSourceMediaCleanupTargetRegistration[]): string {
  const normalized = [...targets].map((target) => ({
    storeId: target.storeId, publicationId: target.publicationId, jobId: target.jobId, taskId: target.taskId
  })).sort((left, right) => left.storeId.localeCompare(right.storeId));
  return `sha256:${createHash('sha256').update(JSON.stringify({ generatedVersionId, targets: normalized })).digest('hex')}`;
}

function archiveError(message: string, details: Record<string, unknown>): AppError {
  return new AppError('OZON_SUCCESS_ARCHIVE_INVALID', message, details, 409);
}
function object(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function portable(value: string): string { return String(value || '').replaceAll('\\', '/').replace(/^\.\//, ''); }
function normalizeHash(value: string): string { return String(value || '').replace(/^sha256:/, '').toLocaleLowerCase('en-US'); }
function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON 成功归档路径越过根目录', { target }, 403);
  }
}
function retryDelay(attempt: number): number { return Math.min(900, Math.max(30, 30 * 2 ** Math.min(attempt, 5))); }
function emptyResult(): OzonSourceMediaCleanupRunResult {
  return { checked: 0, waiting: 0, cleaned: 0, retried: 0, blocked: 0, supersededArtifacts: 0 };
}
