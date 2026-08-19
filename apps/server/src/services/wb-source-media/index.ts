import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '@n8n-media-review/shared';
import {
  WbSourceMediaCleanupRepository,
  type WbSourceMediaCleanupBatch,
  type WbSourceMediaCleanupAutomationTargetRegistration,
  type WbSourceMediaCleanupTarget
} from '../../repositories/wb-source-media-cleanup.js';
import { isPathInside, secureResolve } from '../../utils/paths.js';
import { WbSourceMediaFiles, type WbSourceMediaFileSnapshot } from './source-files.js';

type ManualTarget = { storeId: string; publicationId: string };

export type WbSourceMediaCleanupRunResult = {
  checked: number;
  waiting: number;
  quarantined: number;
  cleaned: number;
  retried: number;
  superseded: number;
};

export type WbHistoricalSourceMediaPlanItem = {
  sku: string;
  eligible: boolean;
  candidateId?: string;
  rowVersion?: number;
  source?: 'MANUAL' | 'AUTOMATION';
  fileCount: number;
  totalBytes: number;
  mediaSignature?: string;
  reasons: string[];
};

export type WbOrphanAutomaticCleanupInspection = {
  eligible: boolean;
  batch: WbSourceMediaCleanupBatch;
  reasons: string[];
};

const RETRY_DELAYS_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export class WbSourceMediaCleanupService {
  private readonly workerId = randomUUID();

  constructor(
    readonly repository: WbSourceMediaCleanupRepository,
    private readonly files: WbSourceMediaFiles,
    private readonly logger: FastifyBaseLogger
  ) {}

  async noteMediaDelivered(sku: string): Promise<void> {
    if (!this.repository.configured) return;
    await this.repository.markSourceAvailable(sku);
  }

  async registerAutomaticBatch(input: {
    sku: string;
    rootDirectory: string;
    deliveredAt: string;
    submissionId: string;
    targets: WbSourceMediaCleanupAutomationTargetRegistration[];
  }): Promise<WbSourceMediaCleanupBatch> {
    if (!input.targets.length) throw new AppError('CONFIG_INVALID', 'WB 自动媒体清理批次不能登记零目标');
    const snapshot = await this.requireSnapshot(input.rootDirectory, input.sku);
    const expectedStoreIds = input.targets.map((target) => target.storeId).sort();
    const mediaBatchId = automaticMediaBatchId({ ...input, mediaSignature: snapshot.mediaSignature!, expectedStoreIds });
    return this.repository.registerAutomationBatch({
      sku: input.sku,
      source: 'AUTOMATION',
      batchKey: `automation:${mediaBatchId}`,
      expectedStoreIds,
      rootDirectory: input.rootDirectory,
      mediaSignature: snapshot.mediaSignature!,
      mediaBatchId,
      deliveredAt: input.deliveredAt
    }, input.targets);
  }

  async discardIncompleteAutomaticBatch(input: {
    sku: string;
    rootDirectory: string;
    deliveredAt: string;
    submissionId: string;
    expectedStoreIds: string[];
  }): Promise<boolean> {
    const snapshot = await this.files.snapshot(input.rootDirectory, input.sku);
    if (!snapshot.exists || !snapshot.mediaSignature) return false;
    const mediaBatchId = automaticMediaBatchId({ ...input, mediaSignature: snapshot.mediaSignature });
    return this.repository.supersedeIncompleteAutomationBatch(
      `automation:${mediaBatchId}`,
      'AUTOMATION_BATCH_REGISTRATION_INCOMPLETE',
      '自动任务未按冻结目标集合完整登记，清理批次已安全废止'
    );
  }

  async registerManualBatch(input: {
    sku: string;
    rootDirectory: string;
    planHash: string;
    draftVersion: number;
    expectedStoreIds: string[];
  }): Promise<WbSourceMediaCleanupBatch> {
    const snapshot = await this.requireSnapshot(input.rootDirectory, input.sku);
    return this.repository.registerBatch({
      sku: input.sku,
      source: 'MANUAL',
      batchKey: `manual:${input.sku}:${input.planHash}`,
      expectedStoreIds: input.expectedStoreIds,
      rootDirectory: input.rootDirectory,
      mediaSignature: snapshot.mediaSignature!,
      planHash: input.planHash,
      draftVersion: input.draftVersion
    });
  }

  async linkManualTarget(batch: WbSourceMediaCleanupBatch, target: ManualTarget): Promise<void> {
    await this.repository.linkManualPublication(batch.id, target.storeId, target.publicationId);
  }

  async sourceState(sku: string): Promise<{ state: 'AVAILABLE' | 'CLEANUP_PENDING' | 'CLEANED'; cleanedAt?: string }> {
    return this.repository.sourceState(sku);
  }

  async runDue(limit = 10): Promise<WbSourceMediaCleanupRunResult> {
    if (!this.repository.configured) return emptyRunResult();
    const batches = await this.repository.claimDue(this.workerId, limit);
    const summary = emptyRunResult();
    for (const batch of batches) {
      summary.checked += 1;
      try {
        const outcome = await this.process(batch);
        summary[outcome] += 1;
      } catch (error) {
        const code = error instanceof AppError ? error.code : 'WB_SOURCE_MEDIA_CLEANUP_FAILED';
        const message = error instanceof Error ? error.message : 'WB 来源媒体清理失败';
        if (code === 'WB_SOURCE_MEDIA_CHANGED') {
          await this.repository.markSuperseded(batch, code, message).catch((markError) => {
            this.logger.warn({ err: markError, cleanupId: batch.id, sku: batch.sku }, 'WB 来源媒体清理候选失效状态保存失败');
          });
          summary.superseded += 1;
          this.logger.warn({ cleanupId: batch.id, sku: batch.sku, err: error }, 'WB 来源媒体已变化，旧清理候选已废止');
        } else {
          const delay = RETRY_DELAYS_MS[Math.min(batch.attemptCount, RETRY_DELAYS_MS.length - 1)]!;
          await this.repository.markRetry(batch, code, message, delay).catch((markError) => {
            this.logger.warn({ err: markError, cleanupId: batch.id, sku: batch.sku }, 'WB 来源媒体清理重试状态保存失败');
          });
          summary.retried += 1;
          this.logger.warn({ cleanupId: batch.id, sku: batch.sku, err: error, delay }, 'WB 来源媒体清理失败，将后台重试');
        }
      }
    }
    return summary;
  }

  async planHistorical(rootDirectory: string, requestedSkus?: string[]): Promise<WbHistoricalSourceMediaPlanItem[]> {
    const inbox = path.join(rootDirectory, 'inbox');
    const entries = await readdir(inbox, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error));
    const allowed = requestedSkus?.length ? new Set(requestedSkus) : undefined;
    const skus = entries.filter((entry) => entry.isDirectory() && /^\d{7}$/.test(entry.name) && (!allowed || allowed.has(entry.name)))
      .map((entry) => entry.name).sort();
    const output: WbHistoricalSourceMediaPlanItem[] = [];
    for (const sku of skus) {
      let snapshot: WbSourceMediaFileSnapshot;
      try { snapshot = await this.files.snapshot(rootDirectory, sku); }
      catch (error) {
        output.push({ sku, eligible: false, fileCount: 0, totalBytes: 0, reasons: [error instanceof AppError ? error.code : 'SOURCE_INSPECTION_FAILED'] });
        continue;
      }
      const group = await this.repository.discoverHistoricalGroup(sku);
      if (!group || !snapshot.exists || !snapshot.mediaSignature) {
        output.push({ sku, eligible: false, fileCount: snapshot.fileCount, totalBytes: snapshot.totalBytes, reasons: [group ? 'SOURCE_ABSENT' : 'PUBLICATION_BATCH_NOT_FOUND'] });
        continue;
      }
      const expectedStores = [...new Set(group.expectedStoreIds)].sort();
      const targetStores = [...new Set(group.targets.map((target) => target.storeId))].sort();
      const identityReasons: string[] = [];
      if (!expectedStores.length) identityReasons.push('EXPECTED_STORES_MISSING');
      if (stableJson(expectedStores) !== stableJson(targetStores)) identityReasons.push('EXPECTED_STORES_INCOMPLETE');
      if (group.source === 'MANUAL' && (!group.planHash || !Number.isInteger(group.draftVersion) || Number(group.draftVersion) < 1)) {
        identityReasons.push('MANUAL_BATCH_IDENTITY_MISSING');
      }
      if (group.source === 'AUTOMATION' && (!group.mediaBatchId || !group.deliveredAt)) {
        identityReasons.push('AUTOMATION_BATCH_IDENTITY_MISSING');
      }
      if (!group.completedAt) identityReasons.push('BATCH_COMPLETION_MISSING');
      if (snapshot.lastDeliveredAt && group.completedAt
        && Date.parse(snapshot.lastDeliveredAt) > Date.parse(group.completedAt)) {
        identityReasons.push('SOURCE_MEDIA_DELIVERED_AFTER_SUCCESS');
      }
      if (identityReasons.length) {
        await this.repository.supersedeCandidates(sku, 'HISTORICAL_CANDIDATE_SKIPPED', identityReasons.join(','));
        output.push({ sku, eligible: false, source: group.source, fileCount: snapshot.fileCount, totalBytes: snapshot.totalBytes,
          mediaSignature: snapshot.mediaSignature, reasons: identityReasons });
        continue;
      }
      if (!snapshot.stagingEmpty) {
        output.push({ sku, eligible: false, source: group.source, fileCount: snapshot.fileCount, totalBytes: snapshot.totalBytes,
          mediaSignature: snapshot.mediaSignature, reasons: ['STAGING_NOT_EMPTY'] });
        continue;
      }
      const batchKey = `historical:${group.source.toLocaleLowerCase('en-US')}:${sku}:${group.planHash || group.mediaBatchId}:${snapshot.mediaSignature}:${randomUUID()}`;
      let candidate: WbSourceMediaCleanupBatch | undefined;
      try {
        candidate = await this.repository.registerBatch({
          sku,
          source: group.source,
          batchKey,
          expectedStoreIds: expectedStores,
          rootDirectory,
          mediaSignature: snapshot.mediaSignature,
          ...(group.source === 'MANUAL'
            ? { planHash: group.planHash!, draftVersion: group.draftVersion! }
            : { mediaBatchId: group.mediaBatchId!, deliveredAt: group.deliveredAt! }),
          initialStatus: 'CANDIDATE'
        });
        for (const target of group.targets) {
          if (group.source === 'MANUAL' && target.publicationId) {
            await this.repository.linkManualPublication(candidate.id, target.storeId, target.publicationId);
          } else if (group.source === 'AUTOMATION' && target.automationJobId && target.automationRunId) {
            await this.repository.linkAutomationJob(candidate.id, target.storeId, target.automationJobId, target.automationRunId);
          }
        }
      } catch (error) {
        if (candidate?.status === 'CANDIDATE') {
          await this.repository.discardCandidate(candidate.id, candidate.rowVersion, 'HISTORICAL_CANDIDATE_INVALID',
            error instanceof Error ? error.message : '历史清理候选身份无效').catch(() => undefined);
        }
        output.push({ sku, eligible: false, source: group.source, fileCount: snapshot.fileCount, totalBytes: snapshot.totalBytes,
          mediaSignature: snapshot.mediaSignature, reasons: [error instanceof AppError ? error.code : 'CANDIDATE_REGISTRATION_FAILED'] });
        continue;
      }
      const validation = await this.validateHistoricalCandidate({ batch: candidate, snapshot });
      if (!validation.eligible) {
        await this.repository.discardCandidate(candidate.id, candidate.rowVersion, 'HISTORICAL_CANDIDATE_SKIPPED', validation.reasons.join(','));
        output.push({ sku, eligible: false, source: group.source, fileCount: snapshot.fileCount, totalBytes: snapshot.totalBytes,
          mediaSignature: snapshot.mediaSignature, reasons: validation.reasons });
        continue;
      }
      output.push({ sku, eligible: true, candidateId: candidate.id, rowVersion: candidate.rowVersion, source: group.source,
        fileCount: snapshot.fileCount, totalBytes: snapshot.totalBytes, mediaSignature: snapshot.mediaSignature, reasons: [] });
    }
    return output;
  }

  async applyHistorical(candidateId: string, rowVersion: number): Promise<WbSourceMediaCleanupBatch> {
    const candidate = await this.repository.get(candidateId);
    if (candidate.status !== 'CANDIDATE' || candidate.rowVersion !== rowVersion) {
      throw new AppError('VERSION_CONFLICT', 'WB 历史清理候选已变化，请重新 dry-run', { candidateId, rowVersion }, 409);
    }
    const snapshot = await this.files.snapshot(candidate.rootDirectory, candidate.sku);
    const validation = await this.validateHistoricalCandidate({ batch: candidate, snapshot });
    if (!validation.eligible) {
      throw new AppError('WB_SOURCE_MEDIA_CLEANUP_BLOCKED', 'WB 历史清理候选二次校验未通过', {
        candidateId,
        sku: candidate.sku,
        reasons: validation.reasons
      }, 409);
    }
    return this.repository.activateCandidate(candidateId, rowVersion);
  }

  async inspectOrphanAutomaticBatch(id: string): Promise<WbOrphanAutomaticCleanupInspection> {
    const evidence = await this.repository.inspectOrphanAutomationBatch(id);
    const reasons = [...evidence.reasons];
    const snapshot = await this.files.snapshot(evidence.batch.rootDirectory, evidence.batch.sku);
    if (!snapshot.exists) reasons.push('SOURCE_ABSENT');
    if (!snapshot.stagingEmpty) reasons.push('STAGING_NOT_EMPTY');
    if (snapshot.mediaSignature !== evidence.batch.mediaSignature) reasons.push('SOURCE_CHANGED');
    const newer = await this.repository.hasNewerOrActiveWork(evidence.batch);
    reasons.push(...newer.reasons);
    return { eligible: reasons.length === 0, batch: evidence.batch, reasons: [...new Set(reasons)] };
  }

  async supersedeOrphanAutomaticBatch(id: string, rowVersion: number): Promise<WbSourceMediaCleanupBatch> {
    const inspection = await this.inspectOrphanAutomaticBatch(id);
    if (!inspection.eligible || inspection.batch.rowVersion !== rowVersion) {
      throw new AppError('WB_SOURCE_MEDIA_CLEANUP_BLOCKED', 'WB 孤儿自动清理批次二次校验未通过', {
        id, rowVersion, currentRowVersion: inspection.batch.rowVersion, reasons: inspection.reasons
      }, 409);
    }
    await this.repository.supersedeOrphanAutomationBatch(
      id,
      rowVersion,
      'AUTOMATION_BATCH_WITHOUT_JOBS',
      '媒体投递早于自动上品启用时间，且未登记任何自动任务；孤儿清理批次已安全废止'
    );
    return this.repository.get(id);
  }

  async validateHistoricalCandidate(input: {
    batch: WbSourceMediaCleanupBatch;
    snapshot: WbSourceMediaFileSnapshot;
  }): Promise<{ eligible: boolean; reasons: string[]; targets: WbSourceMediaCleanupTarget[] }> {
    const targets = await this.repository.targets(input.batch.id);
    const reasons = this.targetBlockers(input.batch, targets);
    const newer = await this.repository.hasNewerOrActiveWork(input.batch);
    reasons.push(...newer.reasons);
    if (!input.snapshot.exists) reasons.push('SOURCE_ABSENT');
    if (!input.snapshot.stagingEmpty) reasons.push('STAGING_NOT_EMPTY');
    if (input.snapshot.mediaSignature !== input.batch.mediaSignature) reasons.push('SOURCE_CHANGED');
    if (!reasons.length) {
      for (const target of targets) {
        try { await this.validateSuccessArchive(input.batch, target, input.snapshot); }
        catch (error) { reasons.push(error instanceof AppError ? error.code : 'SUCCESS_ARCHIVE_INVALID'); }
      }
    }
    return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], targets };
  }

  private async process(batch: WbSourceMediaCleanupBatch): Promise<keyof Omit<WbSourceMediaCleanupRunResult, 'checked'>> {
    const targets = await this.repository.targets(batch.id);
    const blockers = this.targetBlockers(batch, targets);
    if (blockers.length) {
      await this.repository.releaseWaiting(batch);
      return 'waiting';
    }
    const newer = await this.repository.hasNewerOrActiveWork(batch);
    if (newer.blocked) {
      await this.repository.releaseWaiting(batch);
      return 'waiting';
    }
    const snapshot = await this.files.snapshot(batch.rootDirectory, batch.sku);
    if (snapshot.exists && !snapshot.stagingEmpty) {
      await this.repository.releaseWaiting(batch);
      return 'waiting';
    }
    if (snapshot.exists && snapshot.mediaSignature !== batch.mediaSignature) {
      throw new AppError('WB_SOURCE_MEDIA_CHANGED', '公共媒体已在成功批次后变化，拒绝清理', {
        expected: batch.mediaSignature,
        actual: snapshot.mediaSignature
      }, 409);
    }
    for (const target of targets) await this.validateSuccessArchive(batch, target, snapshot);
    const quarantine = await this.files.quarantine({
      rootDirectory: batch.rootDirectory,
      cleanupId: batch.id,
      sku: batch.sku,
      batchKey: batch.batchKey,
      rowVersion: batch.rowVersion,
      mediaSignature: batch.mediaSignature,
      expectedQuarantineRelPath: batch.quarantineRelPath
    });
    if (quarantine.state === 'SOURCE_ABSENT') {
      await this.repository.markCleaned(batch);
      return 'cleaned';
    }
    const quarantined = await this.repository.markQuarantined(batch, quarantine.quarantineRelPath);
    await this.files.deleteQuarantine({
      rootDirectory: quarantined.rootDirectory,
      cleanupId: quarantined.id,
      sku: quarantined.sku,
      batchKey: quarantined.batchKey,
      rowVersion: quarantined.rowVersion,
      mediaSignature: quarantined.mediaSignature,
      quarantineRelPath: quarantine.quarantineRelPath
    });
    await this.repository.markCleaned(quarantined);
    return quarantine.state === 'QUARANTINED' ? 'cleaned' : 'cleaned';
  }

  private targetBlockers(batch: WbSourceMediaCleanupBatch, targets: WbSourceMediaCleanupTarget[]): string[] {
    const reasons: string[] = [];
    const expected = [...batch.expectedStoreIds].sort();
    const actual = targets.map((target) => target.storeId).sort();
    if (stableJson(expected) !== stableJson(actual)) reasons.push('EXPECTED_STORES_INCOMPLETE');
    for (const target of targets) {
      if (!target.publicationId) reasons.push(`PUBLICATION_MISSING:${target.storeId}`);
      if (target.publicationSource !== batch.source) reasons.push(`PUBLICATION_SOURCE_MISMATCH:${target.storeId}`);
      if (target.publicationStatus !== 'SUCCEEDED') reasons.push(`PUBLICATION_${target.publicationStatus || 'MISSING'}:${target.storeId}`);
      if (!target.publicationTaskId || target.publicationTaskId !== target.runtimeTaskId) reasons.push(`RUNTIME_IDENTITY_MISMATCH:${target.storeId}`);
      if (target.runtimePublicationId !== target.publicationId) reasons.push(`RUNTIME_PUBLICATION_MISMATCH:${target.storeId}`);
      if (target.runtimeState !== 'SUCCEEDED') reasons.push(`RUNTIME_${target.runtimeState || 'MISSING'}:${target.storeId}`);
      if (!target.runtimeWorkRelpath?.replaceAll('\\', '/').match(/^success\/\d{4}-\d{2}-\d{2}\//)) reasons.push(`SUCCESS_ARCHIVE_MISSING:${target.storeId}`);
      if (batch.source === 'MANUAL' && target.publicationPlanHash !== batch.planHash) reasons.push(`PLAN_HASH_MISMATCH:${target.storeId}`);
      if (batch.source === 'AUTOMATION') {
        if (!target.automationJobId || !target.automationRunId) reasons.push(`AUTOMATION_IDENTITY_MISSING:${target.storeId}`);
        if (target.automationState !== 'SUCCEEDED') reasons.push(`AUTOMATION_${target.automationState || 'MISSING'}:${target.storeId}`);
      }
    }
    return reasons;
  }

  private async validateSuccessArchive(
    batch: WbSourceMediaCleanupBatch,
    target: WbSourceMediaCleanupTarget,
    sourceSnapshot?: WbSourceMediaFileSnapshot
  ): Promise<void> {
    const relPath = String(target.runtimeWorkRelpath || '').replaceAll('\\', '/');
    const expectedPrefix = `success/`;
    if (!relPath.startsWith(expectedPrefix) || relPath.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw archiveError('WB 成功归档路径无效', { cleanupId: batch.id, relPath });
    }
    const archiveRoot = path.resolve(batch.rootDirectory, ...relPath.split('/'));
    const rootReal = await realpath(batch.rootDirectory);
    if (!isPathInside(rootReal, archiveRoot)) throw archiveError('WB 成功归档路径超出根目录', { archiveRoot });
    const archiveInfo = await lstat(archiveRoot).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (!archiveInfo || !archiveInfo.isDirectory() || archiveInfo.isSymbolicLink()) throw archiveError('WB 成功归档目录不存在或不安全', { archiveRoot });
    const archiveReal = await realpath(archiveRoot);
    if (!isPathInside(rootReal, archiveReal)) throw archiveError('WB 成功归档真实路径超出根目录', { archiveReal });
    const intake = parseObject(await readFile(path.join(archiveRoot, '.intake.json'), 'utf8'));
    if (String(intake.taskId || '') !== target.publicationTaskId || String(intake.productCode || intake.folderName || '') !== batch.sku
      || String(intake.publicationId || '') !== target.publicationId) {
      throw archiveError('WB 成功归档 intake 身份不一致', { archiveRoot });
    }
    if (target.publicationPackageSignature) {
      if (sourceSnapshot?.exists) await validateArchiveMediaSubset(archiveRoot, sourceSnapshot);
      const markerPath = path.join(archiveRoot, '.store-ready', `${target.publicationId}.json`);
      const marker = parseObject(await readFile(markerPath, 'utf8'));
      const packageSignature = await calculatePackageSignature(archiveRoot);
      if (String(marker.sku || '') !== batch.sku || String(marker.taskId || '') !== target.publicationTaskId
        || String(marker.publicationId || '') !== target.publicationId
        || String(marker.packageSignature || marker.sourceContentSignature || '') !== target.publicationPackageSignature
        || packageSignature !== target.publicationPackageSignature
        || (target.publicationMaterializationHash
          && String(marker.materializationHash || '') !== target.publicationMaterializationHash)) {
        throw archiveError('WB 成功归档包身份或内容签名不一致', { archiveRoot });
      }
    } else {
      const archiveSnapshot = await this.files.snapshotDirectory(archiveRoot, batch.sku, rootReal);
      if (!archiveSnapshot.exists || archiveSnapshot.mediaSignature !== batch.mediaSignature) {
        throw archiveError('WB 旧兼容成功包媒体与清理批次签名不一致', {
          archiveRoot,
          expected: batch.mediaSignature,
          actual: archiveSnapshot.mediaSignature
        });
      }
    }
  }

  private async requireSnapshot(rootDirectory: string, sku: string): Promise<WbSourceMediaFileSnapshot> {
    const snapshot = await this.files.snapshot(rootDirectory, sku);
    if (!snapshot.exists || !snapshot.mediaSignature || snapshot.fileCount < 2) {
      throw new AppError('WB_SOURCE_MEDIA_CLEANED', '公共媒体已在成功上品后清理，请重新投递媒体', { sku }, 410);
    }
    if (!snapshot.stagingEmpty) throw new AppError('WB_SOURCE_MEDIA_BUSY', '公共媒体仍在投递，请稍后重试', { sku }, 409);
    return snapshot;
  }
}

async function calculatePackageSignature(productRoot: string): Promise<string> {
  const product = parseObject(await readFile(path.join(productRoot, 'product.json'), 'utf8'));
  const paths = new Set<string>(['product.json']);
  for (const variantValue of Array.isArray(product.variants) ? product.variants : []) {
    const variant = parseRecord(variantValue);
    for (const image of Array.isArray(variant.images) ? variant.images : []) paths.add(String(image).replaceAll('\\', '/'));
    if (variant.video) paths.add(String(variant.video).replaceAll('\\', '/'));
  }
  for (const manifest of ['variants/variant-media-manifest.json', 'variant-media-manifest.json']) {
    const target = path.join(productRoot, ...manifest.split('/'));
    if (await lstat(target).catch(() => undefined)) paths.add(manifest);
  }
  const rows: Array<{ relativePath: string; size: number; sha256: string }> = [];
  for (const relativePath of [...paths].sort()) {
    if (!relativePath || path.posix.isAbsolute(relativePath) || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw archiveError('WB 成功归档 product.json 包含不安全媒体路径', { relativePath });
    }
    const file = await secureResolve(productRoot, relativePath);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw archiveError('WB 成功归档包包含非普通文件', { relativePath });
    rows.push({ relativePath, size: info.size, sha256: `sha256:${await hashFile(file)}` });
  }
  return `sha256:${createHash('sha256').update(JSON.stringify(rows)).digest('hex')}`;
}

async function validateArchiveMediaSubset(archiveRoot: string, source: WbSourceMediaFileSnapshot): Promise<void> {
  const product = parseObject(await readFile(path.join(archiveRoot, 'product.json'), 'utf8'));
  const referenced: string[] = [];
  for (const variantValue of Array.isArray(product.variants) ? product.variants : []) {
    const variant = parseRecord(variantValue);
    for (const image of Array.isArray(variant.images) ? variant.images : []) referenced.push(String(image).replaceAll('\\', '/'));
    if (variant.video) referenced.push(String(variant.video).replaceAll('\\', '/'));
  }
  if (!referenced.length) throw archiveError('WB 成功归档缺少媒体引用', { archiveRoot });
  const sourceFiles = new Map(source.files.map((file) => [file.relativePath, file]));
  for (const relativePath of new Set(referenced)) {
    if (!relativePath.startsWith('variants/') || path.posix.isAbsolute(relativePath)
      || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw archiveError('WB 成功归档包含不安全媒体引用', { archiveRoot, relativePath });
    }
    const frozen = sourceFiles.get(relativePath);
    if (!frozen) throw archiveError('WB 成功归档媒体不在冻结公共媒体中', { archiveRoot, relativePath });
    const archiveFile = await secureResolve(archiveRoot, relativePath);
    const info = await lstat(archiveFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== frozen.sizeBytes
      || `sha256:${await hashFile(archiveFile)}` !== frozen.sha256) {
      throw archiveError('WB 成功归档媒体与冻结公共媒体不一致', { archiveRoot, relativePath });
    }
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function parseObject(raw: string): Record<string, any> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON object expected');
  return parsed as Record<string, any>;
}

function parseRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function archiveError(message: string, details: Record<string, unknown>): AppError {
  return new AppError('WB_SUCCESS_ARCHIVE_INVALID', message, details, 409);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function automaticMediaBatchId(input: {
  sku: string;
  deliveredAt: string;
  submissionId: string;
  mediaSignature: string;
  expectedStoreIds: string[];
}): string {
  return `sha256:${createHash('sha256').update(stableJson({
    sku: input.sku,
    deliveredAt: input.deliveredAt,
    submissionId: input.submissionId,
    mediaSignature: input.mediaSignature,
    expectedStoreIds: [...input.expectedStoreIds].sort()
  })).digest('hex')}`;
}

function emptyRunResult(): WbSourceMediaCleanupRunResult {
  return { checked: 0, waiting: 0, quarantined: 0, cleaned: 0, retried: 0, superseded: 0 };
}
