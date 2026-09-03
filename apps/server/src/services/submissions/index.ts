import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import pLimit from 'p-limit';
import type { FastifyBaseLogger } from 'fastify';
import {
  AppError,
  ROOT_METADATA_EXTENSIONS,
  SUBMISSION_STEPS,
  type BatchItemProgress,
  type PendingSubmission,
  type SubmissionBatchRecord,
  type SubmissionRecord,
  type DeliveryCheckpoint,
  type StageConfig,
  type TaskDetail,
  type TargetConfig
} from '@n8n-media-review/shared';
import type { ConfigService } from '../../config/service.js';
import type { StateStore } from '../../repositories/store.js';
import type { ScannerService } from '../scanner/index.js';
import type { ProductIdentityService } from '../product-identity/index.js';
import { reviewOperationContext } from '../../utils/review-operation-context.js';
import { deliveryIoLimit, copyVerified, treeReceipts, verifyTree, syncDirectory, syncFile, withDeliveryNamespace } from '../../utils/delivery-files.js';
import { stableHash, type ReviewOperationService } from '../review-operations.js';
import { atomicRenameWithRetry } from '../../utils/atomic-rename.js';

type SubmissionResult = {
  pendingSubmissionId: string;
  status: SubmissionRecord['status'];
  submissionId?: string;
  errorCode?: string;
  errorMessage?: string;
};

const excludedMetadata = new Set(['_READY.json', 'selection-manifest.json', 'handoff.json', '.review-draft.json']);

export class SubmissionService {
  private locks = new Set<string>();
  private progress = new Map<string, Partial<BatchItemProgress>>();
  private namespaceTails = new Map<string, Promise<unknown>>();
  constructor(
    private readonly config: ConfigService,
    private readonly store: StateStore,
    private readonly scanner: ScannerService,
    private readonly productIdentity: ProductIdentityService,
    private readonly logger: FastifyBaseLogger,
    private readonly operations?: ReviewOperationService
  ) {}

  async runBatch(batchId: string, pendingIds: string[], conflictPolicy: 'skip' | 'new-revision'): Promise<{ batchId: string; results: SubmissionResult[] }> {
    const uniqueIds = [...new Set(pendingIds)];
    if (!uniqueIds.length) throw new AppError('CONFIG_INVALID', '至少选择一个待投递任务');
    const snapshot = { pendingSubmissions: this.store.section('pendingSubmissions') };
    for (const id of uniqueIds) {
      const pending = snapshot.pendingSubmissions.find((item) => item.id === id);
      if (!pending && this.store.select('deliveryCheckpoints', (rows) => rows?.some((row) => row.pendingSubmissionId === id && row.phase === 'COMPLETE'))) continue;
      if (!pending) throw new AppError('CONFIG_INVALID', '待投递任务不存在', { id }, 404);
      this.requirePendingStagesEnabled(pending);
    }
    const now = new Date().toISOString();
    const batch: SubmissionBatchRecord = {
      batchId,
      status: 'RUNNING',
      total: uniqueIds.length,
      completed: 0,
      createdAt: now,
      items: uniqueIds.map((id) => ({ pendingSubmissionId: id, status: 'WAITING' }))
    };
    await this.store.updateSections(['submissionBatches', 'pendingSubmissions'], (db) => {
      if (!db.submissionBatches.some((item) => item.batchId === batchId)) db.submissionBatches.unshift(batch);
      const active = db.submissionBatches.filter((item) => item.status === 'RUNNING');
      db.submissionBatches = [...active, ...db.submissionBatches.filter((item) => item.status !== 'RUNNING').slice(0, 100)];
      for (const pending of db.pendingSubmissions.filter((item) => uniqueIds.includes(item.id))) pending.conflictPolicy = conflictPolicy;
    });

    const workGroups = new Map<string, string[]>();
    for (const id of uniqueIds) {
      const pending = snapshot.pendingSubmissions.find((item) => item.id === id)!;
      const key = pending ? `${pending.taskId}:${pending.targetStageId}` : id;
      workGroups.set(key, [...(workGroups.get(key) || []), id]);
    }
    const limit = pLimit(this.config.get().submissionConcurrency);
    const groupOutcomes = await Promise.allSettled([...workGroups.values()].map((ids) => limit(async () => {
      const groupResults: SubmissionResult[] = [];
      // Variants from one review share the destination-name namespace. Queue them
      // so the existing revision policy can allocate the next folder safely.
      for (const id of ids) {
        const pending = this.store.getPending(id);
        const stage = this.config.get().stages.find((item) => item.id === pending?.sourceStageId);
        const target = stage?.targets.find((item) => item.targetStageId === pending?.targetStageId);
        const sourceName = pending ? this.store.getReview(pending.taskId)?.sourceFolderName : undefined;
        const namespace = target && sourceName ? path.join(path.resolve(target.targetQueueRoot), target.folderNameTemplate.replaceAll('{sourceName}', sourceName)).toLocaleLowerCase('en-US') : target ? path.resolve(target.targetQueueRoot).toLocaleLowerCase('en-US') : id;
        const previous = this.namespaceTails.get(namespace) || Promise.resolve();
        const run = previous.catch(() => undefined).then(() => deliveryIoLimit(() => this.submitOne(batchId, id)));
        this.namespaceTails.set(namespace, run);
        try { groupResults.push(await run); } finally { if (this.namespaceTails.get(namespace) === run) this.namespaceTails.delete(namespace); }
      }
      return groupResults;
    })));
    const failedGroup = groupOutcomes.find((outcome) => outcome.status === 'rejected');
    if (failedGroup?.status === 'rejected') throw failedGroup.reason;
    const groupedResults = groupOutcomes.flatMap((outcome) => outcome.status === 'fulfilled' ? outcome.value : []);
    const resultsByPendingId = new Map(groupedResults.flat().map((result) => [result.pendingSubmissionId, result]));
    const results = uniqueIds.map((id) => resultsByPendingId.get(id)!);
    await this.store.updateSections(['submissionBatches'], (db) => {
      const current = db.submissionBatches.find((item) => item.batchId === batchId);
      if (current) {
        current.status = 'COMPLETED';
        current.completed = current.total;
        current.completedAt = new Date().toISOString();
        current.items = results.map((result) => ({ ...result }));
      }
    });
    return { batchId, results };
  }

  async retrySubmission(submissionId: string): Promise<unknown> {
    const history = this.store.getSubmission(submissionId);
    if (!history) throw new AppError('CONFIG_INVALID', '投递记录不存在', { submissionId }, 404);
    if (history.status === 'SUCCESS') return history;
    const checkpoint = this.store.select('deliveryCheckpoints', (rows) => rows?.find((row) => row.submissionId === submissionId));
    if (!checkpoint && history.targetFolder) throw new AppError('DELIVERY_OUTCOME_UNKNOWN', '旧记录缺少交付检查点，请核对目标及归档；不会重新入队', { submissionId }, 409);
    if (checkpoint && ['TARGET_COMMITTED', 'COMPLETE'].includes(checkpoint.phase)) {
      const result = await this.reconcile(checkpoint);
      return { ...result, archiveFolder: this.store.getSubmission(submissionId)?.archiveFolder, retriedPart: 'archive' };
    }
    const pending = this.store.getPending(history.pendingSubmissionId);
    if (!pending) throw new AppError('CONFIG_INVALID', '该记录没有可重试的待投递项');
    return this.runBatch('BATCH-RETRY-' + (this.operations?.currentId || randomUUID()), [pending.id], pending.conflictPolicy);
  }

  getBatch(batchId: string): SubmissionBatchRecord | undefined {
    const batch = this.store.getBatch(batchId);
    if (batch) for (const item of batch.items) Object.assign(item, this.progress.get(batchId + ':' + item.pendingSubmissionId));
    return batch;
  }
  private async setProgress(batchId: string, pendingId: string, patch: Partial<BatchItemProgress>): Promise<void> {
    const key = batchId + ':' + pendingId;
    this.progress.set(key, { ...this.progress.get(key), ...patch });
    this.operations?.report({ step: patch.step || patch.status || '处理中' });
  }

  private async submitOne(batchId: string, pendingId: string): Promise<SubmissionResult> {
    const checkpoint = this.store.select('deliveryCheckpoints', (rows) => rows?.find((row) => row.pendingSubmissionId === pendingId));
    if (checkpoint && ['COMPLETE', 'TARGET_COMMITTED', 'COMMIT_INTENT', 'NEEDS_ATTENTION'].includes(checkpoint.phase)) {
      const recovered = await this.reconcile(checkpoint);
      if (recovered) return recovered;
    }
    const pending = this.store.getPending(pendingId);
    if (!pending) return this.failProgress(batchId, pendingId, 'CONFIG_INVALID', '待投递任务不存在');
    let task: TaskDetail;
    try {
      this.requirePendingStagesEnabled(pending);
      const snapshotError = this.operations?.currentId ? (this.store.getOperation(this.operations.currentId)?.input.taskSnapshotErrors as Record<string, { code: string; message: string; statusCode: number }> | undefined)?.[pending.taskId] : undefined;
      if (snapshotError) throw new AppError(snapshotError.code, snapshotError.message, undefined, snapshotError.statusCode);
      const snapshots = this.operations?.currentId ? this.store.getOperation(this.operations.currentId)?.input.taskSnapshots as Record<string, TaskDetail> | undefined : undefined;
      task = snapshots?.[pending.taskId] || await this.scanner.getTask(pending.taskId);
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError('STAGE_DISABLED', '流程已停用', undefined, 409);
      return this.failProgress(batchId, pendingId, appError.code, appError.message);
    }
    const lockKey = `${pending.taskId}:${pending.targetStageId}`;
    if (this.locks.has(lockKey)) return this.failProgress(batchId, pendingId, 'TASK_LOCKED', '同一产品和目标正在投递');
    this.locks.add(lockKey);
    await this.setProgress(batchId, pendingId, { status: 'PROCESSING', step: SUBMISSION_STEPS[0] });
    await this.store.updateSections(['pendingSubmissions', 'reviews'], (db) => {
      const item = db.pendingSubmissions.find((candidate) => candidate.id === pendingId);
      if (item) { item.status = 'PACKAGING'; item.updatedAt = new Date().toISOString(); }
      const review = db.reviews.find((candidate) => candidate.taskId === pending.taskId);
      if (review) review.status = 'PACKAGING';
    });

    try {
      const result = await this.packageAndSubmit(batchId, pending, task);
      await this.setProgress(batchId, pendingId, { status: result.status, submissionId: result.submissionId, step: SUBMISSION_STEPS[8] });
      return result;
    } catch (error: any) {
      this.store.assertWritable();
      const uncertain = this.store.select('deliveryCheckpoints', (rows) => rows?.find((row) => row.pendingSubmissionId === pendingId && ['COMMIT_INTENT', 'NEEDS_ATTENTION'].includes(row.phase)));
      if (uncertain || error?.code === 'DELIVERY_OUTCOME_UNKNOWN') throw error;
      const attempt = this.operations?.currentId ? this.store.getOperation(this.operations.currentId)?.attempt || 0 : 4;
      if (['EBUSY', 'EPERM', 'EAGAIN'].includes(error?.code) && attempt <= 3) throw error;
      const appError = error instanceof AppError ? error : new AppError('COPY_FAILED', error?.message || '投递失败');
      const failureId = this.store.select('deliveryCheckpoints', (rows) => rows?.find((row) => row.pendingSubmissionId === pendingId))?.submissionId || this.submissionId();
      const failureStatus = appError.code === 'TARGET_FOLDER_EXISTS' ? 'SKIPPED_CONFLICT' : 'FAILED';
      const result: SubmissionResult = { pendingSubmissionId: pendingId, status: failureStatus, submissionId: failureId, errorCode: appError.code, errorMessage: appError.message };
      await this.setProgress(batchId, pendingId, { status: failureStatus, submissionId: failureId, errorCode: appError.code, errorMessage: appError.message });
      await this.store.updateSections(['pendingSubmissions', 'reviews', 'submissionHistory'], (db) => {
        const item = db.pendingSubmissions.find((candidate) => candidate.id === pendingId);
        if (item) { item.status = 'FAILED'; item.lastError = `${appError.code}: ${appError.message}`; item.updatedAt = new Date().toISOString(); }
        const review = db.reviews.find((candidate) => candidate.taskId === pending.taskId);
        if (review) review.status = 'FAILED';
        db.submissionHistory = db.submissionHistory.filter((row) => row.submissionId !== failureId);
        db.submissionHistory.unshift({
          submissionId: failureId,
          pendingSubmissionId: pending.id,
          taskId: pending.taskId,
          sourceStageId: pending.sourceStageId,
          targetStageId: pending.targetStageId,
          sourceFolder: task.sourceFolder,
          selectedImageCount: pending.selectedRelativePaths.length,
          productSku: pending.productSku,
          productNameSnapshot: pending.productNameSnapshot,
          n8nTaskParameters: structuredClone(pending.n8nTaskParameters),
          n8nTaskParameterOptions: structuredClone(pending.n8nTaskParameterOptions || {}),
          n8nParameterFileName: this.n8nParameterFileName(pending.targetStageId, failureId),
          status: failureStatus,
          errorCode: appError.code,
          errorMessage: appError.message,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        });

      });
      return result;
    } finally {
      this.locks.delete(lockKey);
    }
  }

  private async failProgress(batchId: string, pendingId: string, errorCode: string, errorMessage: string): Promise<SubmissionResult> {
    await this.setProgress(batchId, pendingId, { status: errorCode === 'TARGET_FOLDER_EXISTS' ? 'SKIPPED_CONFLICT' : 'FAILED', errorCode, errorMessage });
    return { pendingSubmissionId: pendingId, status: errorCode === 'TARGET_FOLDER_EXISTS' ? 'SKIPPED_CONFLICT' : 'FAILED', errorCode, errorMessage };
  }

  private requirePendingStagesEnabled(pending: PendingSubmission): void {
    const stages = this.config.get().stages;
    const sourceStage = stages.find((item) => item.id === pending.sourceStageId);
    const targetStage = stages.find((item) => item.id === pending.targetStageId);
    if (!sourceStage?.enabled) {
      throw new AppError('STAGE_DISABLED', `来源流程 ${pending.sourceStageId} 已停用`, { stageId: pending.sourceStageId, pendingSubmissionId: pending.id }, 409);
    }
    if (!targetStage?.enabled) {
      throw new AppError('STAGE_DISABLED', `目标流程 ${pending.targetStageId} 已停用`, { stageId: pending.targetStageId, pendingSubmissionId: pending.id }, 409);
    }
  }

  private async packageAndSubmit(batchId: string, pending: PendingSubmission, task: TaskDetail): Promise<SubmissionResult> {
    const frozen = this.operations?.currentId ? this.store.getOperation(this.operations.currentId)?.input.stages as StageConfig[] | undefined : undefined;
    const stage = (frozen || this.config.get().stages).find((item) => item.id === pending.sourceStageId);
    const target = stage?.targets.find((item) => item.targetStageId === pending.targetStageId);
    if (!stage || !target || !stage.approvedArchiveRoot) throw new AppError('CONFIG_INVALID', '来源阶段或目标阶段配置不完整');
    if (new Set(pending.selectedRelativePaths).size !== pending.selectedRelativePaths.length) throw new AppError('CONFIG_INVALID', '选中的图片路径不能重复');
    const imageByRelativePath = new Map(task.images.map((item) => [item.relativePath, item]));
    const missingPaths = pending.selectedRelativePaths.filter((relativePath) => !imageByRelativePath.has(relativePath));
    if (missingPaths.length) throw new AppError('SOURCE_FILE_MISSING', '部分选中的图片已不存在', { relativePaths: missingPaths });
    const sourceImages = pending.selectedRelativePaths.map((relativePath) => imageByRelativePath.get(relativePath)!);
    for (const image of sourceImages) {
      const { absolutePath: source } = await this.scanner.resolveIndexedMedia(task.taskId, image.relativePath, { allowDisabledStage: true });
      const current = await stat(source);
      if (current.size !== image.sizeBytes || current.mtime.toISOString() !== image.lastModifiedAt) throw new AppError('FILE_CHANGED', '接收任务后图片发生变化，请核对选图', { relativePath: image.relativePath }, 409);
      if (current.size <= 0) throw new AppError('SOURCE_FILE_EMPTY', '选中的图片为空文件', { relativePath: image.relativePath });
    }
    await this.ensureWritableDirectory(target.targetQueueRoot, 'TARGET_QUEUE_UNAVAILABLE');
    await this.ensureWritableDirectory(stage.approvedArchiveRoot, 'ARCHIVE_ROOT_UNAVAILABLE');

    const verifiedProduct = await this.productIdentity.requirePendingIdentity(pending);
    if (verifiedProduct.sku !== pending.productSku) throw new AppError('PRODUCT_IDENTITY_CHANGED', '产品身份已变化，请重新核对待投递任务', undefined, 409);
    const currentProduct = { ...verifiedProduct, productName: pending.productNameSnapshot || verifiedProduct.productName };
    // Parameters and product name were frozen at approval/admission; verification
    // must never replace those snapshots with later workflow or catalog changes.

    const existingCheckpoint = this.store.select('deliveryCheckpoints', (rows) => rows?.find((row) => row.pendingSubmissionId === pending.id));
    if (existingCheckpoint) {
      const frozen = existingCheckpoint.record;
      if (stableHash([frozen.selectedRelativePaths, frozen.n8nTaskParameters, frozen.n8nTaskParameterOptions || {}, frozen.productSku, frozen.variantId]) !== stableHash([pending.selectedRelativePaths, pending.n8nTaskParameters, pending.n8nTaskParameterOptions || {}, pending.productSku, pending.variantId])
        || path.dirname(existingCheckpoint.targetFinal) !== path.resolve(target.targetQueueRoot)
        || path.dirname(existingCheckpoint.archiveFinal!) !== path.resolve(stage.approvedArchiveRoot)) {
        throw new AppError('DELIVERY_INPUT_CHANGED', '原投递已有冻结检查点，当前选图、参数或目录已改变；请重新打开审核生成新的待投递项', { submissionId: existingCheckpoint.submissionId }, 409);
      }
    }
    const nameInfo = existingCheckpoint ? { name: path.basename(existingCheckpoint.targetFinal), revision: existingCheckpoint.revision } : await this.resolveDestinationName(task.sourceFolderName, target, pending.conflictPolicy);
    const submissionId = existingCheckpoint?.submissionId || this.submissionId();
    const n8nTaskParameters = pending.n8nTaskParameters || await this.config.getWorkflowParameters(pending.targetStageId);
    const n8nParameterFileName = this.n8nParameterFileName(pending.targetStageId, submissionId);
    const startedAt = new Date().toISOString();
    const targetFinal = path.join(target.targetQueueRoot, nameInfo.name);
    const targetStagingRoot = path.join(target.targetQueueRoot, '.staging');
    const targetTemp = path.join(targetStagingRoot, `${nameInfo.name}.__tmp__${submissionId}`);
    const archiveFinal = path.join(stage.approvedArchiveRoot, nameInfo.name);
    const archiveStagingRoot = path.join(stage.approvedArchiveRoot, '.staging');
    const archiveTemp = path.join(archiveStagingRoot, `${nameInfo.name}.__tmp__${submissionId}`);
    const record: SubmissionRecord = {
      submissionId, pendingSubmissionId: pending.id, taskId: pending.taskId, sourceStageId: stage.id,
      targetStageId: target.targetStageId, sourceFolder: task.sourceFolder, selectedImageCount: sourceImages.length,
      selectedRelativePaths: [...pending.selectedRelativePaths],
      productSku: currentProduct.sku, productNameSnapshot: currentProduct.productName,
      variantGroupId: pending.variantGroupId, variantId: pending.variantId, variantName: pending.variantName,
      n8nTaskParameters: structuredClone(n8nTaskParameters), n8nTaskParameterOptions: structuredClone(pending.n8nTaskParameterOptions || {}), n8nParameterFileName,
      status: 'FAILED', startedAt
    };

    const checkpoint: DeliveryCheckpoint = existingCheckpoint || {
      submissionId, operationId: reviewOperationContext.getStore()?.operationId, pendingSubmissionId: pending.id, taskId: pending.taskId,
      phase: 'PREPARING', targetTemp, targetFinal, archiveTemp, archiveFinal, revision: nameInfo.revision, record, files: [], updatedAt: startedAt
    };
    await this.saveCheckpoint(checkpoint);
    // Only pre-commit staging owned by this exact checkpoint may be rebuilt.
    await this.removeOwnedStaging(targetTemp, targetStagingRoot);
    await this.removeOwnedStaging(archiveTemp, archiveStagingRoot);
    await mkdir(targetTemp, { recursive: true });
    // Keep owned staging after errors: a failed write/rename may follow a visible commit.
    {
      await this.setProgress(batchId, pending.id, { step: SUBMISSION_STEPS[1], submissionId });
      const selectedFiles: Array<Record<string, unknown>> = [];
      const destinationNames = new Set<string>();
      let copiedBytes = 0;
      const totalBytes = sourceImages.reduce((sum, item) => sum + item.sizeBytes, 0);
      for (const [sortOrder, image] of sourceImages.entries()) {
        const { absolutePath: source } = await this.scanner.resolveIndexedMedia(task.taskId, image.relativePath, { allowDisabledStage: true });
        const targetRelativePath = target.packageMode === 'flatten' ? this.flattenName(image.relativePath) : image.relativePath;
        const destinationKey = targetRelativePath.toLocaleLowerCase('en-US');
        if (destinationNames.has(destinationKey)) throw new AppError('CONFIG_INVALID', '打包文件名冲突，请调整所选文件');
        destinationNames.add(destinationKey);
        const destination = path.join(targetTemp, ...targetRelativePath.split('/'));
        await mkdir(path.dirname(destination), { recursive: true });
        await copyVerified(source, destination, (bytes) => {
          copiedBytes += bytes;
          this.operations?.report({ step: '复制及校验图片', copiedBytes, totalBytes, completedFiles: sortOrder, totalFiles: sourceImages.length });
        });
        await this.scanner.resolveIndexedMedia(task.taskId, image.relativePath, { allowDisabledStage: true });
        selectedFiles.push({
          sortOrder,
          sourceRelativePath: image.relativePath,
          targetRelativePath,
          fileName: image.fileName,
          sizeBytes: image.sizeBytes,
          lastModifiedAt: image.lastModifiedAt
        });
      }
      await this.writeJson(path.join(targetTemp, n8nParameterFileName), n8nTaskParameters);
      await this.writeJson(path.join(targetTemp, 'task-context.json'), {
        schemaVersion: 1,
        workflowCode: target.targetStageId,
        SKU: currentProduct.sku,
        productName: currentProduct.productName,
        ...(pending.variantId ? { variantId: pending.variantId } : {}),
        ...(pending.variantName ? { variants: pending.variantName } : {}),
        sourceSubmissionId: submissionId
      });

      await this.setProgress(batchId, pending.id, { step: SUBMISSION_STEPS[2] });
      if (target.copyRootMetadata) await this.copyMetadata(task.sourceFolder, path.join(targetTemp, 'metadata'));
      const approvedAt = this.store.getReview(task.taskId)?.approvedAt || startedAt;
      const manifest = {
        schemaVersion: '1.0', taskId: pending.taskId, sourceStageId: stage.id, sourceFolderName: task.sourceFolderName,
        sourceFolderPath: task.sourceFolder, targetStageId: target.targetStageId, packageMode: target.packageMode,
        selectedImageCount: sourceImages.length, selectedFiles, n8nParameterFileName, approvedAt,
        productSku: currentProduct.sku, productName: currentProduct.productName, variantId: pending.variantId, variantName: pending.variantName
      };
      const handoff = {
        schemaVersion: '1.0', submissionId, taskId: pending.taskId, sourceStageId: stage.id,
        targetStageId: target.targetStageId, sourceFolderName: task.sourceFolderName, targetFolderName: nameInfo.name,
        revision: nameInfo.revision, n8nParameterFileName, submittedAt: startedAt, submittedBy: 'local-user',
        productSku: currentProduct.sku, productName: currentProduct.productName, variantId: pending.variantId, variantName: pending.variantName
      };
      await this.setProgress(batchId, pending.id, { step: SUBMISSION_STEPS[3] });
      await this.writeJson(path.join(targetTemp, 'selection-manifest.json'), manifest);
      await this.writeJson(path.join(targetTemp, 'handoff.json'), handoff);

      await this.setProgress(batchId, pending.id, { step: SUBMISSION_STEPS[4] });
      for (const file of selectedFiles) {
        const copied = await stat(path.join(targetTemp, ...(file.targetRelativePath as string).split('/')));
        if (copied.size !== file.sizeBytes) throw new AppError('VERIFY_FAILED', '复制后的文件大小不一致', { relativePath: file.targetRelativePath });
      }
      const savedParameters = JSON.parse(await readFile(path.join(targetTemp, n8nParameterFileName), 'utf8'));
      if (JSON.stringify(savedParameters) !== JSON.stringify(n8nTaskParameters)) {
        throw new AppError('VERIFY_FAILED', 'n8n 任务参数文件校验失败', { fileName: n8nParameterFileName });
      }

      await this.setProgress(batchId, pending.id, { step: SUBMISSION_STEPS[5] });
      await this.writeJson(path.join(targetTemp, '_READY.json'), {
        schemaVersion: '1.0', ready: true, submissionId, taskId: pending.taskId, sourceStageId: stage.id,
        targetStageId: target.targetStageId, imageCount: sourceImages.length, n8nParameterFileName, createdAt: new Date().toISOString()
      });
      // Prepare the complete archive before publishing a directory watched by n8n.
      await mkdir(archiveStagingRoot, { recursive: true });
      await cp(targetTemp, archiveTemp, { recursive: true, errorOnExist: true, force: false });
      checkpoint.files = await treeReceipts(targetTemp, true);
      const archiveFiles = await treeReceipts(archiveTemp, true);
      if (JSON.stringify(archiveFiles) !== JSON.stringify(checkpoint.files)) throw new AppError('VERIFY_FAILED', '归档暂存包校验失败');
      checkpoint.phase = 'VERIFIED';
      await this.saveCheckpoint(checkpoint);
      await this.setProgress(batchId, pending.id, { step: SUBMISSION_STEPS[6] });
      checkpoint.phase = 'COMMIT_INTENT';
      await this.saveCheckpoint(checkpoint);
      this.store.assertWritable();
      await atomicRenameWithRetry(targetTemp, targetFinal, {
        onRetry: (event) => this.logger.warn({ submissionId, ...event }, '投递原子入队遇到瞬时占用，准备重试')
      });
      await syncDirectory(path.dirname(targetFinal));
      checkpoint.phase = 'TARGET_COMMITTED';
      checkpoint.record.targetFolder = targetFinal;
      await this.saveCheckpoint(checkpoint);
      return await this.finishArchive(checkpoint);
    }
  }

  private async saveCheckpoint(checkpoint: DeliveryCheckpoint): Promise<void> {
    checkpoint.updatedAt = new Date().toISOString();
    await this.store.updateSections(['deliveryCheckpoints'], (db) => {
      const rows = db.deliveryCheckpoints ||= [];
      const index = rows.findIndex((row) => row.submissionId === checkpoint.submissionId);
      if (index < 0) rows.push(structuredClone(checkpoint)); else rows[index] = structuredClone(checkpoint);
    });
  }

  private async reconcile(checkpoint: DeliveryCheckpoint): Promise<SubmissionResult | null> {
    if (checkpoint.phase === 'COMPLETE') return this.result(checkpoint.record);
    if (checkpoint.phase === 'TARGET_COMMITTED') return this.finishArchive(checkpoint);
    if (await verifyTree(checkpoint.targetFinal, checkpoint.files)) {
      checkpoint.phase = 'TARGET_COMMITTED';
      checkpoint.record.targetFolder = checkpoint.targetFinal;
      await this.saveCheckpoint(checkpoint);
      return this.finishArchive(checkpoint);
    }
    if (!(await stat(checkpoint.targetFinal).catch(() => null)) && await verifyTree(checkpoint.targetTemp, checkpoint.files)) {
      // Atomic rename did not happen: the exact verified staging package remains.
      this.store.assertWritable();
      await atomicRenameWithRetry(checkpoint.targetTemp, checkpoint.targetFinal);
      await syncDirectory(path.dirname(checkpoint.targetFinal));
      checkpoint.phase = 'TARGET_COMMITTED'; checkpoint.record.targetFolder = checkpoint.targetFinal;
      await this.saveCheckpoint(checkpoint);
      return this.finishArchive(checkpoint);
    }
    checkpoint.phase = 'NEEDS_ATTENTION';
    await this.saveCheckpoint(checkpoint);
    throw new AppError('DELIVERY_OUTCOME_UNKNOWN', '无法确认文件是否已被下游取走；已保留原投递编号，请核对后处理，禁止重复投递', { submissionId: checkpoint.submissionId }, 409);
  }

  private async finishArchive(checkpoint: DeliveryCheckpoint): Promise<SubmissionResult> {
    return withDeliveryNamespace('archive:' + path.resolve(checkpoint.archiveFinal!), () => this.finishArchiveLocked(checkpoint));
  }
  private async finishArchiveLocked(checkpoint: DeliveryCheckpoint): Promise<SubmissionResult> {
    const record = structuredClone(checkpoint.record);
    record.targetFolder = checkpoint.targetFinal;
    try {
      const archiveFinal = checkpoint.archiveFinal!;
      const archiveTemp = checkpoint.archiveTemp!;
      if (!(await verifyTree(archiveFinal, checkpoint.files))) {
        if (!await verifyTree(archiveTemp, checkpoint.files)) throw new AppError('VERIFY_FAILED', '归档暂存包不存在或校验失败，目标已投递，不能重投');
        if (await stat(archiveFinal).catch(() => null)) {
          if (!await this.isCompatibleArchive(archiveFinal, [record.taskId, this.store.resolveRuntimeTaskId(record.taskId)], record.selectedRelativePaths || [])) throw new AppError('TARGET_FOLDER_EXISTS', '归档目录存在不兼容内容');
          // Existing contract shares one archive across target stages. Compare media
          // bytes before adding this target's unique frozen parameter file.
          const manifest = JSON.parse(await readFile(path.join(archiveTemp, 'selection-manifest.json'), 'utf8'));
          const existingFiles = await treeReceipts(archiveFinal);
          for (const item of manifest.selectedFiles) {
            const expected = checkpoint.files.find((file) => file.relativePath === item.targetRelativePath);
            const actual = existingFiles.find((file) => file.relativePath === item.targetRelativePath);
            if (!expected || !actual || expected.sha256 !== actual.sha256) throw new AppError('VERIFY_FAILED', '共享归档图片内容不一致');
          }
          if (record.n8nParameterFileName) {
            await copyFile(path.join(archiveTemp, record.n8nParameterFileName), path.join(archiveFinal, record.n8nParameterFileName));
            await syncFile(path.join(archiveFinal, record.n8nParameterFileName));
          }
        } else {
          await atomicRenameWithRetry(archiveTemp, archiveFinal);
          await syncDirectory(path.dirname(archiveFinal));
        }
      }
      record.archiveFolder = archiveFinal; record.status = 'SUCCESS';
      record.errorCode = undefined; record.errorMessage = undefined;
      checkpoint.phase = 'COMPLETE';
    } catch (error: any) {
      record.status = 'PARTIAL_SUCCESS'; record.errorCode = 'ARCHIVE_ROOT_UNAVAILABLE'; record.errorMessage = error?.message || '投递成功但归档未完成';
      checkpoint.phase = 'TARGET_COMMITTED';
    }
    record.completedAt = new Date().toISOString();
    checkpoint.record = record;
    await this.store.updateSections(['deliveryCheckpoints', 'submissionHistory', 'pendingSubmissions', 'reviews'], (db) => {
      const index = db.deliveryCheckpoints!.findIndex((row) => row.submissionId === checkpoint.submissionId);
      db.deliveryCheckpoints![index] = structuredClone(checkpoint);
      const historyIndex = db.submissionHistory.findIndex((row) => row.submissionId === record.submissionId);
      if (historyIndex < 0) db.submissionHistory.unshift(record); else db.submissionHistory[historyIndex] = record;
      if (record.status === 'SUCCESS') db.pendingSubmissions = db.pendingSubmissions.filter((row) => row.id !== record.pendingSubmissionId);
      else {
        const pending = db.pendingSubmissions.find((row) => row.id === record.pendingSubmissionId);
        if (pending) { pending.status = 'FAILED'; pending.lastError = record.errorMessage; }
      }
      const review = db.reviews.find((row) => row.taskId === record.taskId);
      if (review) review.status = record.status === 'SUCCESS' && !db.pendingSubmissions.some((row) => row.taskId === record.taskId) ? 'SUBMITTED' : 'PARTIALLY_SUBMITTED';
    });
    return this.result(record);
  }

  private result(record: SubmissionRecord): SubmissionResult {
    return { pendingSubmissionId: record.pendingSubmissionId, submissionId: record.submissionId, status: record.status, errorCode: record.errorCode, errorMessage: record.errorMessage };
  }
  private async removeOwnedStaging(directory: string, stagingRoot: string): Promise<void> {
    const root = path.resolve(stagingRoot), resolved = path.resolve(directory);
    if (path.dirname(resolved) !== root || !path.basename(resolved).includes('.__tmp__')) throw new AppError('CONFIG_INVALID', '拒绝清理不属于本次投递的暂存目录');
    await rm(resolved, { recursive: true, force: true });
  }

  private async ensureWritableDirectory(directory: string, code: string): Promise<void> {
    const info = await stat(directory).catch(() => null);
    if (!info?.isDirectory()) throw new AppError(code, '配置的目标目录不存在或不是目录', { path: directory });
    const probe = path.join(directory, `.review-write-test-${randomUUID()}`);
    try { await writeFile(probe, 'ok', 'utf8'); await rm(probe); }
    catch (error: any) { throw new AppError(code, error?.message || '目标目录不可写', { path: directory }); }
  }

  private n8nParameterFileName(targetStageId: string, submissionId: string): string {
    return `n8n_setParameter_${targetStageId}_${submissionId}.json`;
  }

  private async resolveDestinationName(sourceName: string, target: TargetConfig, policy: PendingSubmission['conflictPolicy']): Promise<{ name: string; revision: number }> {
    const baseName = target.folderNameTemplate.replaceAll('{sourceName}', sourceName);
    const exists = async (name: string) => Boolean(await stat(path.join(target.targetQueueRoot, name)).catch(() => null));
    if (!(await exists(baseName))) return { name: baseName, revision: 1 };
    if (policy === 'skip') throw new AppError('TARGET_FOLDER_EXISTS', '目标任务目录已存在，已按策略跳过', { folderName: baseName }, 409);
    for (let revision = 2; revision < 10_000; revision += 1) {
      const name = `${baseName}__R${String(revision).padStart(2, '0')}`;
      if (!(await exists(name))) return { name, revision };
    }
    throw new AppError('TARGET_FOLDER_EXISTS', '无法计算可用的修订目录名称');
  }

  private flattenName(relativePath: string): string { return relativePath.split('/').join('__'); }

  private async isCompatibleArchive(directory: string, taskIds: string | string[], selectedPaths: string[]): Promise<boolean> {
    try {
      const ready = JSON.parse(await readFile(path.join(directory, '_READY.json'), 'utf8'));
      const manifest = JSON.parse(await readFile(path.join(directory, 'selection-manifest.json'), 'utf8'));
      const archivedPaths = orderedManifestSourcePaths(manifest.selectedFiles);
      const compatibleTaskIds = new Set(Array.isArray(taskIds) ? taskIds : [taskIds]);
      return ready.ready === true && compatibleTaskIds.has(ready.taskId) && compatibleTaskIds.has(manifest.taskId) && JSON.stringify(archivedPaths) === JSON.stringify(selectedPaths);
    } catch {
      return false;
    }
  }

  private async copyMetadata(sourceRoot: string, destination: string): Promise<void> {
    const entries = await readdir(sourceRoot, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && ROOT_METADATA_EXTENSIONS.includes(path.extname(entry.name).toLocaleLowerCase('en-US') as any) && !excludedMetadata.has(entry.name) && !entry.name.startsWith('.review-'));
    if (!files.length) return;
    await mkdir(destination, { recursive: true });
    await Promise.all(files.map((entry) => copyFile(path.join(sourceRoot, entry.name), path.join(destination, entry.name))));
  }

  private async writeJson(file: string, data: unknown): Promise<void> { await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8'); }

  private submissionId(): string {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    return `SUB-${stamp}-${randomUUID().slice(0, 8)}`;
  }
}

function orderedManifestSourcePaths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) return [];
  const entries = value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('清单文件条目无效');
    const entry = item as { sourceRelativePath?: unknown; sortOrder?: unknown };
    if (typeof entry.sourceRelativePath !== 'string' || !entry.sourceRelativePath) throw new Error('清单文件路径无效');
    return { sourceRelativePath: entry.sourceRelativePath, sortOrder: entry.sortOrder };
  });
  const hasSortOrder = entries.some((entry) => entry.sortOrder !== undefined);
  if (!hasSortOrder) return entries.map((entry) => entry.sourceRelativePath);
  if (entries.some((entry) => !Number.isInteger(entry.sortOrder) || Number(entry.sortOrder) < 0)) throw new Error('清单图片顺序无效');
  const ordered = [...entries].sort((left, right) => Number(left.sortOrder) - Number(right.sortOrder));
  if (ordered.some((entry, index) => Number(entry.sortOrder) !== index)) throw new Error('清单图片顺序不连续或重复');
  return ordered.map((entry) => entry.sourceRelativePath);
}
