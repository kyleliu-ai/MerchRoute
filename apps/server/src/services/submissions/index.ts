import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
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
  type StageConfig,
  type TaskDetail,
  type TargetConfig
} from '@n8n-media-review/shared';
import type { ConfigService } from '../../config/service.js';
import type { StateStore } from '../../repositories/store.js';
import type { ScannerService } from '../scanner/index.js';
import type { ProductIdentityService } from '../product-identity/index.js';
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
  constructor(
    private readonly config: ConfigService,
    private readonly store: StateStore,
    private readonly scanner: ScannerService,
    private readonly productIdentity: ProductIdentityService,
    private readonly logger: FastifyBaseLogger
  ) {}

  async runBatch(batchId: string, pendingIds: string[], conflictPolicy: 'skip' | 'new-revision'): Promise<{ batchId: string; results: SubmissionResult[] }> {
    const uniqueIds = [...new Set(pendingIds)];
    if (!uniqueIds.length) throw new AppError('CONFIG_INVALID', '至少选择一个待投递任务');
    const snapshot = this.store.read();
    for (const id of uniqueIds) {
      const pending = snapshot.pendingSubmissions.find((item) => item.id === id);
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
    await this.store.update((db) => {
      if (db.submissionBatches.some((item) => item.batchId === batchId)) throw new AppError('TASK_LOCKED', '批次编号已存在', { batchId }, 409);
      db.submissionBatches.unshift(batch);
      db.submissionBatches = db.submissionBatches.slice(0, 100);
      for (const pending of db.pendingSubmissions.filter((item) => uniqueIds.includes(item.id))) pending.conflictPolicy = conflictPolicy;
    });

    const workGroups = new Map<string, string[]>();
    for (const id of uniqueIds) {
      const pending = snapshot.pendingSubmissions.find((item) => item.id === id)!;
      const key = `${pending.taskId}:${pending.targetStageId}`;
      workGroups.set(key, [...(workGroups.get(key) || []), id]);
    }
    const limit = pLimit(this.config.get().submissionConcurrency);
    const groupedResults = await Promise.all([...workGroups.values()].map((ids) => limit(async () => {
      const groupResults: SubmissionResult[] = [];
      // Variants from one review share the destination-name namespace. Queue them
      // so the existing revision policy can allocate the next folder safely.
      for (const id of ids) groupResults.push(await this.submitOne(batchId, id));
      return groupResults;
    })));
    const resultsByPendingId = new Map(groupedResults.flat().map((result) => [result.pendingSubmissionId, result]));
    const results = uniqueIds.map((id) => resultsByPendingId.get(id)!);
    await this.store.update((db) => {
      const current = db.submissionBatches.find((item) => item.batchId === batchId);
      if (current) {
        current.status = 'COMPLETED';
        current.completed = current.total;
        current.completedAt = new Date().toISOString();
      }
    });
    return { batchId, results };
  }

  async retrySubmission(submissionId: string): Promise<unknown> {
    const snapshot = this.store.read();
    const history = snapshot.submissionHistory.find((item) => item.submissionId === submissionId);
    if (!history) throw new AppError('CONFIG_INVALID', '投递记录不存在', { submissionId }, 404);
    const pending = snapshot.pendingSubmissions.find((item) => item.id === history.pendingSubmissionId);
    if (!pending) throw new AppError('CONFIG_INVALID', '该记录没有可重试的待投递项');
    this.requirePendingStagesEnabled(pending);
    if (history.status !== 'PARTIAL_SUCCESS' || !history.targetFolder || history.archiveFolder) {
      return this.runBatch(`BATCH-RETRY-${randomUUID()}`, [pending.id], pending.conflictPolicy);
    }
    const task = await this.scanner.getTask(pending.taskId);
    const stage = this.config.get().stages.find((item) => item.id === pending.sourceStageId);
    if (!stage?.approvedArchiveRoot) throw new AppError('ARCHIVE_ROOT_UNAVAILABLE', '审核归档目录未配置');
    await this.ensureWritableDirectory(stage.approvedArchiveRoot, 'ARCHIVE_ROOT_UNAVAILABLE');
    const archiveFinal = path.join(stage.approvedArchiveRoot, path.basename(history.targetFolder));
    const archiveStaging = path.join(stage.approvedArchiveRoot, '.staging');
    const archiveTemp = path.join(archiveStaging, `${path.basename(history.targetFolder)}.__tmp__RETRY-${randomUUID()}`);
    try {
      if (!(await this.isCompatibleArchive(archiveFinal, task.taskId, pending.selectedRelativePaths))) {
        if (await stat(archiveFinal).catch(() => null)) throw new AppError('TARGET_FOLDER_EXISTS', '审核归档目录仍被不兼容内容占用', { path: archiveFinal });
        await mkdir(archiveStaging, { recursive: true });
        await cp(history.targetFolder, archiveTemp, { recursive: true, errorOnExist: true, force: false });
        await rename(archiveTemp, archiveFinal);
      }
      await this.store.update((db) => {
        const record = db.submissionHistory.find((item) => item.submissionId === submissionId);
        if (record) { record.archiveFolder = archiveFinal; record.status = 'SUCCESS'; record.errorCode = undefined; record.errorMessage = undefined; record.completedAt = new Date().toISOString(); }
        db.pendingSubmissions = db.pendingSubmissions.filter((item) => item.id !== pending.id);
        const review = db.reviews.find((item) => item.taskId === pending.taskId);
        if (review) review.status = db.pendingSubmissions.some((item) => item.taskId === pending.taskId) ? 'PARTIALLY_SUBMITTED' : 'SUBMITTED';
      });
      return { submissionId, status: 'SUCCESS', archiveFolder: archiveFinal, retriedPart: 'archive' };
    } catch (error) {
      await rm(archiveTemp, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async setProgress(batchId: string, pendingId: string, patch: Partial<BatchItemProgress>): Promise<void> {
    await this.store.update((db) => {
      const item = db.submissionBatches.find((batch) => batch.batchId === batchId)?.items.find((candidate) => candidate.pendingSubmissionId === pendingId);
      if (item) Object.assign(item, patch);
    });
  }

  private async submitOne(batchId: string, pendingId: string): Promise<SubmissionResult> {
    const pending = this.store.read().pendingSubmissions.find((item) => item.id === pendingId);
    if (!pending) return this.failProgress(batchId, pendingId, 'CONFIG_INVALID', '待投递任务不存在');
    let task: TaskDetail;
    try {
      this.requirePendingStagesEnabled(pending);
      task = await this.scanner.getTask(pending.taskId);
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError('STAGE_DISABLED', '流程已停用', undefined, 409);
      return this.failProgress(batchId, pendingId, appError.code, appError.message);
    }
    const lockKey = `${pending.taskId}:${pending.targetStageId}`;
    if (this.locks.has(lockKey)) return this.failProgress(batchId, pendingId, 'TASK_LOCKED', '同一产品和目标正在投递');
    this.locks.add(lockKey);
    await this.setProgress(batchId, pendingId, { status: 'PROCESSING', step: SUBMISSION_STEPS[0] });
    await this.store.update((db) => {
      const item = db.pendingSubmissions.find((candidate) => candidate.id === pendingId);
      if (item) { item.status = 'PACKAGING'; item.updatedAt = new Date().toISOString(); }
      const review = db.reviews.find((candidate) => candidate.taskId === pending.taskId);
      if (review) review.status = 'PACKAGING';
    });

    try {
      const result = await this.packageAndSubmit(batchId, pending, task);
      await this.setProgress(batchId, pendingId, { status: result.status, submissionId: result.submissionId, step: SUBMISSION_STEPS[8] });
      await this.store.update((db) => {
        const batch = db.submissionBatches.find((item) => item.batchId === batchId);
        if (batch) batch.completed += 1;
      });
      return result;
    } catch (error: any) {
      const appError = error instanceof AppError ? error : new AppError('COPY_FAILED', error?.message || '投递失败');
      const failureId = this.submissionId();
      const failureStatus = appError.code === 'TARGET_FOLDER_EXISTS' ? 'SKIPPED_CONFLICT' : 'FAILED';
      const result: SubmissionResult = { pendingSubmissionId: pendingId, status: failureStatus, submissionId: failureId, errorCode: appError.code, errorMessage: appError.message };
      await this.setProgress(batchId, pendingId, { status: failureStatus, submissionId: failureId, errorCode: appError.code, errorMessage: appError.message });
      await this.store.update((db) => {
        const item = db.pendingSubmissions.find((candidate) => candidate.id === pendingId);
        if (item) { item.status = 'FAILED'; item.lastError = `${appError.code}: ${appError.message}`; item.updatedAt = new Date().toISOString(); }
        const review = db.reviews.find((candidate) => candidate.taskId === pending.taskId);
        if (review) review.status = 'FAILED';
        db.submissionHistory.unshift({
          submissionId: failureId,
          pendingSubmissionId: pending.id,
          taskId: pending.taskId,
          sourceStageId: pending.sourceStageId,
          targetStageId: pending.targetStageId,
          sourceFolder: review?.sourceFolder || '',
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
        const batch = db.submissionBatches.find((item) => item.batchId === batchId);
        if (batch) batch.completed += 1;
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
    const stage = this.config.get().stages.find((item) => item.id === pending.sourceStageId);
    const target = stage?.targets.find((item) => item.targetStageId === pending.targetStageId);
    if (!stage || !target || !stage.approvedArchiveRoot) throw new AppError('CONFIG_INVALID', '来源阶段或目标阶段配置不完整');
    if (new Set(pending.selectedRelativePaths).size !== pending.selectedRelativePaths.length) throw new AppError('CONFIG_INVALID', '选中的图片路径不能重复');
    const imageByRelativePath = new Map(task.images.map((item) => [item.relativePath, item]));
    const missingPaths = pending.selectedRelativePaths.filter((relativePath) => !imageByRelativePath.has(relativePath));
    if (missingPaths.length) throw new AppError('SOURCE_FILE_MISSING', '部分选中的图片已不存在', { relativePaths: missingPaths });
    const sourceImages = pending.selectedRelativePaths.map((relativePath) => imageByRelativePath.get(relativePath)!);
    for (const image of sourceImages) {
      const { absolutePath: source } = await this.scanner.resolveIndexedMedia(task.taskId, image.relativePath, { allowDisabledStage: true });
      if ((await stat(source)).size <= 0) throw new AppError('SOURCE_FILE_EMPTY', '选中的图片为空文件', { relativePath: image.relativePath });
    }
    await this.ensureWritableDirectory(target.targetQueueRoot, 'TARGET_QUEUE_UNAVAILABLE');
    await this.ensureWritableDirectory(stage.approvedArchiveRoot, 'ARCHIVE_ROOT_UNAVAILABLE');

    const currentProduct = await this.productIdentity.requirePendingIdentity(pending);
    pending.productSku = currentProduct.sku;
    pending.productNameSnapshot = currentProduct.productName;
    pending.n8nTaskParameters = pending.variantName
      ? this.productIdentity.injectVariant(pending.n8nTaskParameters, currentProduct, pending.variantName)
      : this.productIdentity.inject(pending.n8nTaskParameters, currentProduct);
    await this.store.update((db) => {
      const current = db.pendingSubmissions.find((item) => item.id === pending.id);
      if (current) Object.assign(current, { productSku: currentProduct.sku, productNameSnapshot: currentProduct.productName, n8nTaskParameters: structuredClone(pending.n8nTaskParameters), updatedAt: new Date().toISOString() });
    });

    const recovered = await this.recoverInterruptedSubmission(batchId, pending, task, stage, target);
    if (recovered) return recovered;

    const nameInfo = await this.resolveDestinationName(task.sourceFolderName, target, pending.conflictPolicy);
    const submissionId = this.submissionId();
    const n8nTaskParameters = pending.n8nTaskParameters || await this.config.getWorkflowParameters(pending.targetStageId);
    const n8nParameterFileName = this.n8nParameterFileName(pending.targetStageId, submissionId);
    const startedAt = new Date().toISOString();
    const targetFinal = path.join(target.targetQueueRoot, nameInfo.name);
    const targetStagingRoot = path.join(target.targetQueueRoot, '.staging');
    const targetTemp = path.join(targetStagingRoot, `${nameInfo.name}.__tmp__${submissionId}`);
    const archiveFinal = path.join(stage.approvedArchiveRoot, nameInfo.name);
    const archiveStagingRoot = path.join(stage.approvedArchiveRoot, '.staging');
    const archiveTemp = path.join(archiveStagingRoot, `${nameInfo.name}.__tmp__${submissionId}`);
    await mkdir(targetStagingRoot, { recursive: true });
    await mkdir(targetTemp, { recursive: false });

    const record: SubmissionRecord = {
      submissionId, pendingSubmissionId: pending.id, taskId: task.taskId, sourceStageId: stage.id,
      targetStageId: target.targetStageId, sourceFolder: task.sourceFolder, selectedImageCount: sourceImages.length,
      selectedRelativePaths: [...pending.selectedRelativePaths],
      productSku: currentProduct.sku, productNameSnapshot: currentProduct.productName,
      variantGroupId: pending.variantGroupId, variantId: pending.variantId, variantName: pending.variantName,
      n8nTaskParameters: structuredClone(n8nTaskParameters), n8nTaskParameterOptions: structuredClone(pending.n8nTaskParameterOptions || {}), n8nParameterFileName,
      status: 'FAILED', startedAt
    };

    try {
      await this.setProgress(batchId, pending.id, { step: SUBMISSION_STEPS[1], submissionId });
      const selectedFiles: Array<Record<string, unknown>> = [];
      for (const [sortOrder, image] of sourceImages.entries()) {
        const { absolutePath: source } = await this.scanner.resolveIndexedMedia(task.taskId, image.relativePath, { allowDisabledStage: true });
        const targetRelativePath = target.packageMode === 'flatten' ? this.flattenName(image.relativePath) : image.relativePath;
        const destination = path.join(targetTemp, ...targetRelativePath.split('/'));
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(source, destination);
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
      const approvedAt = this.store.read().reviews.find((item) => item.taskId === task.taskId)?.approvedAt || startedAt;
      const manifest = {
        schemaVersion: '1.0', taskId: task.taskId, sourceStageId: stage.id, sourceFolderName: task.sourceFolderName,
        sourceFolderPath: task.sourceFolder, targetStageId: target.targetStageId, packageMode: target.packageMode,
        selectedImageCount: sourceImages.length, selectedFiles, n8nParameterFileName, approvedAt,
        productSku: currentProduct.sku, productName: currentProduct.productName, variantId: pending.variantId, variantName: pending.variantName
      };
      const handoff = {
        schemaVersion: '1.0', submissionId, taskId: task.taskId, sourceStageId: stage.id,
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
        schemaVersion: '1.0', ready: true, submissionId, taskId: task.taskId, sourceStageId: stage.id,
        targetStageId: target.targetStageId, imageCount: sourceImages.length, n8nParameterFileName, createdAt: new Date().toISOString()
      });
      await this.setProgress(batchId, pending.id, { step: SUBMISSION_STEPS[6] });
      const atomicRenameLogContext = {
        batchId,
        pendingSubmissionId: pending.id,
        submissionId,
        taskId: task.taskId,
        sourceStageId: stage.id,
        targetStageId: target.targetStageId,
        sourcePath: targetTemp,
        targetPath: targetFinal
      };
      await atomicRenameWithRetry(targetTemp, targetFinal, {
        onRetry: (event) => this.logger.warn({
          ...atomicRenameLogContext,
          errorCode: event.errorCode,
          attemptNumber: event.attemptNumber,
          retryNumber: event.retryNumber,
          totalAttempts: event.totalAttempts,
          totalRetries: event.totalRetries,
          delayMs: event.delayMs,
          elapsedMs: event.elapsedMs
        }, '投递原子入队遇到瞬时占用，准备重试'),
        onRecovered: (event) => this.logger.info({
          ...atomicRenameLogContext,
          errorCode: event.errorCode,
          attemptNumber: event.attemptNumber,
          retryNumber: event.retryNumber,
          totalAttempts: event.totalAttempts,
          totalRetries: event.totalRetries,
          delayMs: event.delayMs,
          elapsedMs: event.elapsedMs
        }, '投递原子入队重试后成功'),
        onExhausted: (event) => this.logger.error({
          ...atomicRenameLogContext,
          errorCode: event.errorCode,
          attemptNumber: event.attemptNumber,
          retryNumber: event.retryNumber,
          totalAttempts: event.totalAttempts,
          totalRetries: event.totalRetries,
          delayMs: event.delayMs,
          elapsedMs: event.elapsedMs
        }, '投递原子入队重试耗尽')
      }).catch((error: any) => { throw new AppError('ATOMIC_RENAME_FAILED', error?.message || '监听目录原子入队失败'); });
      record.targetFolder = targetFinal;

      await this.setProgress(batchId, pending.id, { step: SUBMISSION_STEPS[7] });
      try {
        const canReuseArchive = await this.isCompatibleArchive(archiveFinal, task.taskId, sourceImages.map((item) => item.relativePath));
        if (!canReuseArchive) {
          if (await stat(archiveFinal).catch(() => null)) throw new AppError('TARGET_FOLDER_EXISTS', '审核归档目录已存在且内容与本次选图不同', { path: archiveFinal });
          await mkdir(archiveStagingRoot, { recursive: true });
          await cp(targetFinal, archiveTemp, { recursive: true, errorOnExist: true, force: false });
          await rename(archiveTemp, archiveFinal).catch(async (error) => {
            if (!(await this.isCompatibleArchive(archiveFinal, task.taskId, sourceImages.map((item) => item.relativePath)))) throw error;
            await rm(archiveTemp, { recursive: true, force: true });
          });
        }
        // A single source review can be delivered to multiple target stages in parallel.
        // Keep every target's frozen n8n parameter snapshot in the shared archive,
        // regardless of which target won the initial archive-directory rename race.
        await copyFile(path.join(targetFinal, n8nParameterFileName), path.join(archiveFinal, n8nParameterFileName));
        record.archiveFolder = archiveFinal;
        record.status = 'SUCCESS';
      } catch (error: any) {
        record.status = 'PARTIAL_SUCCESS';
        record.errorCode = 'ARCHIVE_ROOT_UNAVAILABLE';
        record.errorMessage = error?.message || '监听目录投递成功，但审核归档失败';
      }
      record.completedAt = new Date().toISOString();
      await this.store.update((db) => {
        db.submissionHistory.unshift(record);
        if (record.status === 'SUCCESS') db.pendingSubmissions = db.pendingSubmissions.filter((item) => item.id !== pending.id);
        else {
          const item = db.pendingSubmissions.find((candidate) => candidate.id === pending.id);
          if (item) { item.status = 'FAILED'; item.lastError = `${record.errorCode}: ${record.errorMessage}`; }
        }
        const remainingForTask = db.pendingSubmissions.filter((item) => item.taskId === task.taskId);
        const review = db.reviews.find((item) => item.taskId === task.taskId);
        if (review) review.status = record.status === 'SUCCESS' ? (remainingForTask.length ? 'PARTIALLY_SUBMITTED' : 'SUBMITTED') : 'PARTIALLY_SUBMITTED';
      });
      return { pendingSubmissionId: pending.id, status: record.status, submissionId, errorCode: record.errorCode, errorMessage: record.errorMessage };
    } catch (error) {
      await rm(targetTemp, { recursive: true, force: true }).catch(() => undefined);
      await rm(archiveTemp, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
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

  private async recoverInterruptedSubmission(batchId: string, pending: PendingSubmission, task: TaskDetail, stage: StageConfig, target: TargetConfig): Promise<SubmissionResult | null> {
    if (pending.status === 'PENDING' || !stage.approvedArchiveRoot) return null;
    const folderName = target.folderNameTemplate.replaceAll('{sourceName}', task.sourceFolderName);
    const existingTarget = path.join(target.targetQueueRoot, folderName);
    if (!(await this.isCompatibleArchive(existingTarget, task.taskId, pending.selectedRelativePaths))) return null;
    const archiveFinal = path.join(stage.approvedArchiveRoot, folderName);
    const archiveStaging = path.join(stage.approvedArchiveRoot, '.staging');
    const archiveTemp = path.join(archiveStaging, `${folderName}.__tmp__RECOVER-${randomUUID()}`);
    await this.setProgress(batchId, pending.id, { step: SUBMISSION_STEPS[7] });
    try {
      if (!(await this.isCompatibleArchive(archiveFinal, task.taskId, pending.selectedRelativePaths))) {
        if (await stat(archiveFinal).catch(() => null)) throw new AppError('TARGET_FOLDER_EXISTS', '审核归档目录已存在且内容与恢复任务不同', { path: archiveFinal });
        await mkdir(archiveStaging, { recursive: true });
        await cp(existingTarget, archiveTemp, { recursive: true, errorOnExist: true, force: false });
        await rename(archiveTemp, archiveFinal);
      }
      const ready = JSON.parse(await readFile(path.join(existingTarget, '_READY.json'), 'utf8'));
      const recoveredId = String(ready.submissionId || this.submissionId());
      const completedAt = new Date().toISOString();
      await this.store.update((db) => {
        const previous = db.submissionHistory.find((item) => item.pendingSubmissionId === pending.id && item.targetFolder === existingTarget);
        if (previous) {
          previous.status = 'SUCCESS'; previous.archiveFolder = archiveFinal; previous.errorCode = undefined; previous.errorMessage = undefined; previous.completedAt = completedAt;
        } else {
          db.submissionHistory.unshift({ submissionId: recoveredId, pendingSubmissionId: pending.id, taskId: task.taskId, sourceStageId: stage.id, targetStageId: target.targetStageId, sourceFolder: task.sourceFolder, targetFolder: existingTarget, archiveFolder: archiveFinal, selectedImageCount: pending.selectedRelativePaths.length, selectedRelativePaths: [...pending.selectedRelativePaths], productSku: pending.productSku, productNameSnapshot: pending.productNameSnapshot, status: 'SUCCESS', startedAt: completedAt, completedAt });
        }
        db.pendingSubmissions = db.pendingSubmissions.filter((item) => item.id !== pending.id);
        const review = db.reviews.find((item) => item.taskId === task.taskId);
        if (review) review.status = db.pendingSubmissions.some((item) => item.taskId === task.taskId) ? 'PARTIALLY_SUBMITTED' : 'SUBMITTED';
      });
      return { pendingSubmissionId: pending.id, status: 'SUCCESS', submissionId: recoveredId };
    } catch (error) {
      await rm(archiveTemp, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
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

  private async isCompatibleArchive(directory: string, taskId: string, selectedPaths: string[]): Promise<boolean> {
    try {
      const ready = JSON.parse(await readFile(path.join(directory, '_READY.json'), 'utf8'));
      const manifest = JSON.parse(await readFile(path.join(directory, 'selection-manifest.json'), 'utf8'));
      const archivedPaths = orderedManifestSourcePaths(manifest.selectedFiles);
      return ready.ready === true && ready.taskId === taskId && manifest.taskId === taskId && JSON.stringify(archivedPaths) === JSON.stringify(selectedPaths);
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
