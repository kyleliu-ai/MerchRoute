import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import writeFileAtomic from 'write-file-atomic';
import {
  AppError,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  type DeliveryCheckpoint,
  type StageConfig,
  type SubmissionRecord,
  type TaskDetail,
  type WbColorIdentity
} from '@n8n-media-review/shared';
import type { StateStore } from '../../repositories/store.js';
import { addReviewOperationPhase, addReviewOperationWork, reviewOperationContext } from '../../utils/review-operation-context.js';
import { copyVerified, deliveryFileIoLimit, deliveryIoLimit, treeReceipts, verifyTree, syncDirectory, syncTreeDirectories, type FileReceipt } from '../../utils/delivery-files.js';
import type { ConfigService } from '../../config/service.js';
import { parseOzonMediaOutputRootTemplate, resolveOzonMediaOutputRoot, resolveWbMediaOutputRoot } from '../../config/service.js';
import { validateProductVariantName } from '../../repositories/purchases.js';
import { isPathInside, secureResolve, toApiRelativePath } from '../../utils/paths.js';
import { withWbSourceMediaSkuLock } from '../wb-source-media/sku-lock.js';
import { withOzonSourceMediaFilesystemLock, withOzonSourceMediaSkuLock } from '../ozon-source-media/sku-lock.js';

type DeliveryInput = {
  submissionId?: string;
  platform: 'WB' | 'OZON';
  task: TaskDetail;
  stage: StageConfig;
  selectedRelativePaths: string[];
  productSku: string;
  productName: string;
  variantId: string;
  variantName: string;
  variantColor?: WbColorIdentity;
  sourceSubmissionId?: string;
  archiveMedia?: boolean;
  retry?: { submissionId: string; outputRootTemplateSnapshot: string; resolvedOutputRoot: string };
};

type ManifestAsset = {
  assetId: string;
  submissionId: string;
  sourceSubmissionId?: string;
  sourceStageId: string;
  sourceTaskId: string;
  variantId: string;
  variantName: string;
  variantColor?: WbColorIdentity;
  kind: 'image' | 'video';
  sortOrder?: number;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  deliveredAt: string;
};

type VariantMediaManifest = {
  schemaVersion: 1 | 2;
  SKU: string;
  productName: string;
  updatedAt: string;
  assets: ManifestAsset[];
};

export class VariantMediaDeliveryService {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly config: ConfigService,
    private readonly canonicalizePath: (value: string) => string = (value) => value,
    private readonly store?: StateStore
  ) {}

  async deliver(input: DeliveryInput): Promise<SubmissionRecord> {
    return deliveryIoLimit(() => this.deliverLocked(input));
  }
  private async deliverLocked(input: DeliveryInput): Promise<SubmissionRecord> {
    input = {
      ...input,
      task: { ...input.task, sourceFolder: this.canonicalizePath(input.task.sourceFolder) },
      stage: {
        ...input.stage,
        ...(input.stage.approvedArchiveRoot ? { approvedArchiveRoot: this.canonicalizePath(input.stage.approvedArchiveRoot) } : {}),
        ...(input.stage.outputRoot ? { outputRoot: this.canonicalizePath(input.stage.outputRoot) } : {}),
        ...(input.stage.ozonOutputRoot ? { ozonOutputRoot: this.canonicalizePath(input.stage.ozonOutputRoot) } : {})
      },
      ...(input.retry ? {
        retry: {
          ...input.retry,
          outputRootTemplateSnapshot: this.canonicalizePath(input.retry.outputRootTemplateSnapshot),
          resolvedOutputRoot: this.canonicalizePath(input.retry.resolvedOutputRoot)
        }
      } : {})
    };
    if (input.stage.id !== 'E004' && input.stage.id !== 'E005') throw new AppError('CONFIG_INVALID', '只有 E004 和 E005 支持共享媒体终端投递');
    const outputRootTemplate = input.retry?.outputRootTemplateSnapshot || (input.platform === 'WB' ? input.stage.outputRoot : input.stage.ozonOutputRoot);
    if (!outputRootTemplate) throw new AppError('CONFIG_INVALID', `${input.stage.id} 尚未配置 ${input.platform} 共享媒体输出目录模板`, { stageId: input.stage.id, platform: input.platform }, 409);
    const variantName = validateProductVariantName(input.variantName);
    const parsedOutputRoot = input.platform === 'WB'
      ? resolveWbMediaOutputRoot(outputRootTemplate, input.productSku)
      : resolveOzonMediaOutputRoot(outputRootTemplate, input.productSku);
    const outputRoot = input.retry?.resolvedOutputRoot || parsedOutputRoot;
    if (input.retry && normalizePortablePath(outputRoot) !== normalizePortablePath(parsedOutputRoot)) throw new AppError('CONFIG_INVALID', `冻结的 ${input.platform} 投递目录与目录模板不一致`, { outputRoot, parsedOutputRoot }, 409);
    const submissionId = input.retry?.submissionId || input.submissionId || randomUUID();
    const kind: 'image' | 'video' = input.stage.id === 'E004' ? 'video' : 'image';
    const kindDirectory = kind === 'video' ? 'videos' : 'images';
    const skuRoot = path.dirname(outputRoot);
    const stagingRoot = path.join(skuRoot, '.staging', submissionId);
    const stagedMediaRoot = path.join(stagingRoot, kindDirectory);
    const destination = path.join(outputRoot, variantName, kindDirectory, submissionId);
    const startedAt = new Date().toISOString();
    addReviewOperationWork(
      input.selectedRelativePaths.length,
      input.selectedRelativePaths.reduce((sum, relativePath) => sum + (input.task.images.find((image) => image.relativePath === relativePath)?.sizeBytes || 0), 0)
    );
    let record: SubmissionRecord = {
      submissionId,
      pendingSubmissionId: submissionId,
      taskId: input.task.taskId,
      sourceStageId: input.stage.id,
      targetStageId: `${input.platform}_SHARED_MEDIA`,
      sourceFolder: input.task.sourceFolder,
      selectedImageCount: input.selectedRelativePaths.length,
      selectedRelativePaths: [...input.selectedRelativePaths],
      productSku: input.productSku,
      productNameSnapshot: input.productName,
      variantId: input.variantId,
      variantName,
      deliveryType: input.platform === 'WB' ? 'WB_MEDIA' : 'OZON_MEDIA',
      outputRootTemplateSnapshot: outputRootTemplate,
      resolvedOutputRoot: outputRoot,
      sourceSubmissionId: input.sourceSubmissionId,
      status: 'FAILED',
      startedAt
    };
    let checkpoint = this.store?.select('deliveryCheckpoints', (rows) => rows?.find((row) => row.submissionId === submissionId));
    if (checkpoint?.phase === 'COMPLETE') return checkpoint.record;
    if (checkpoint) record = structuredClone(checkpoint.record);
    const archiveFinal = input.archiveMedia !== false && input.stage.approvedArchiveRoot ? path.join(input.stage.approvedArchiveRoot, input.task.sourceFolderName + '-' + submissionId) : undefined;
    checkpoint ||= {
      submissionId, operationId: reviewOperationContext.getStore()?.operationId, pendingSubmissionId: submissionId, taskId: input.task.taskId,
      phase: 'PREPARING', targetTemp: stagedMediaRoot, targetFinal: destination,
      archiveTemp: archiveFinal ? path.join(input.stage.approvedArchiveRoot!, '.staging', submissionId) : undefined,
      archiveFinal, revision: 1, record, files: [], updatedAt: startedAt,
      manifestPath: path.join(outputRoot, 'variant-media-manifest.json')
    };
    try {
      let verifiedInThisRun = false;
      const stageAndCommit = async (commitLock: (operation: () => Promise<void>) => Promise<void>) => {
        let staged: ManifestAsset[];
        if (['COMMIT_INTENT', 'TARGET_COMMITTED', 'NEEDS_ATTENTION'].includes(checkpoint!.phase)) {
          staged = checkpoint!.manifestAssets as ManifestAsset[] || [];
          if (!staged.length) throw new AppError('DELIVERY_OUTCOME_UNKNOWN', '共享媒体提交缺少校验记录，请核对后处理', { submissionId }, 409);
        } else {
          // PREPARING / VERIFIED are not visible through the shared manifest.
          if (path.dirname(stagingRoot) !== path.join(skuRoot, '.staging')) throw new AppError('CONFIG_INVALID', '暂存路径异常');
          await rm(stagingRoot, { recursive: true, force: true });
          await mkdir(stagedMediaRoot, { recursive: true });
          const stageStarted = performance.now();
          const prepared = await this.stageFiles(input, stagedMediaRoot, variantName, kind, submissionId);
          staged = prepared.assets;
          checkpoint!.files = prepared.files;
          await syncTreeDirectories(stagedMediaRoot);
          verifiedInThisRun = true;
          addReviewOperationPhase('copyAndVerifyMs', performance.now() - stageStarted);
          checkpoint!.manifestAssets = staged as unknown as Array<Record<string, unknown>>;
          if (checkpoint!.archiveTemp) {
            const archiveStarted = performance.now();
            if (path.dirname(checkpoint!.archiveTemp) !== path.join(input.stage.approvedArchiveRoot!, '.staging')) throw new AppError('CONFIG_INVALID', '归档暂存路径异常');
            await rm(checkpoint!.archiveTemp, { recursive: true, force: true });
            await copyDirectory(stagedMediaRoot, checkpoint!.archiveTemp);
            if (JSON.stringify(await treeReceipts(checkpoint!.archiveTemp, true)) !== JSON.stringify(checkpoint!.files)) throw new AppError('VERIFY_FAILED', '归档暂存校验失败');
            addReviewOperationPhase('archiveMs', performance.now() - archiveStarted);
          }
          checkpoint!.phase = 'VERIFIED';
          await this.saveCheckpoint(checkpoint!);
        }
        await commitLock(async () => {
          if (checkpoint!.phase === 'TARGET_COMMITTED') return;
          const commitStarted = performance.now();
          const manifestPath = checkpoint!.manifestPath!;
          let manifest: VariantMediaManifest | undefined;
          try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
          catch (error: any) { if (error?.code !== 'ENOENT') throw new AppError('MANIFEST_WRITE_FAILED', '共享媒体清单无法读取'); }
          const registered = manifest?.assets?.filter((asset) => asset.submissionId === submissionId) || [];
          if (registered.length) {
            if (registered.length !== staged.length || registered.some((asset, index) => asset.sha256 !== staged[index]?.sha256 || asset.relativePath !== staged[index]?.relativePath || asset.sortOrder !== staged[index]?.sortOrder)) throw new AppError('DELIVERY_OUTCOME_UNKNOWN', '共享媒体清单与冻结记录不一致', { submissionId }, 409);
            // Manifest is the commit point. Downstream may already have cleaned files.
            if (await stat(destination).catch(() => undefined)) {
              const recoveredFiles = await this.inspectCommittedFiles(destination, outputRoot, input, kind, submissionId, staged);
              if (staged.length !== recoveredFiles.length || staged.some((item, index) => item.sha256 !== recoveredFiles[index]?.sha256 || item.relativePath !== recoveredFiles[index]?.relativePath || item.sortOrder !== recoveredFiles[index]?.sortOrder)) {
                throw new AppError('DELIVERY_OUTCOME_UNKNOWN', '共享媒体恢复校验失败，请核对目标目录，禁止重复投递', { submissionId }, 409);
              }
            }
          } else {
            checkpoint!.phase = 'COMMIT_INTENT';
            await this.saveCheckpoint(checkpoint!);
            this.store?.assertWritable();
            await mkdir(path.dirname(destination), { recursive: true });
            let renamedVerifiedStaging = false;
            if (!(await stat(destination).catch(() => undefined))) {
              if (!verifiedInThisRun && !await verifyTree(stagedMediaRoot, checkpoint!.files)) throw new AppError('DELIVERY_OUTCOME_UNKNOWN', '共享媒体暂存及目标均无法验证，禁止重新复制', { submissionId }, 409);
              await rename(stagedMediaRoot, destination);
              await syncDirectory(path.dirname(destination));
              renamedVerifiedStaging = true;
            }
            const committed = await this.inspectCommittedFiles(destination, outputRoot, input, kind, submissionId, staged, !renamedVerifiedStaging);
            if (staged.length !== committed.length || staged.some((item, index) => item.sha256 !== committed[index]?.sha256 || item.relativePath !== committed[index]?.relativePath || item.sortOrder !== committed[index]?.sortOrder)) throw new AppError('VERIFY_FAILED', '共享媒体目标文件校验失败');
            await this.updateManifest(manifestPath, input, committed);
            await syncDirectory(path.dirname(manifestPath));
          }
          record.mediaManifestPath = manifestPath; record.targetFolder = destination;
          checkpoint!.record = structuredClone(record); checkpoint!.phase = 'TARGET_COMMITTED';
          addReviewOperationPhase('commitMs', performance.now() - commitStarted);
        });
      };
      if (input.platform === 'WB') await stageAndCommit((operation) => withWbSourceMediaSkuLock(input.productSku, operation));
      else {
        const ozonRootDirectory = parseOzonMediaOutputRootTemplate(outputRootTemplate).rootDirectory;
        await withOzonSourceMediaSkuLock(input.productSku, () => withOzonSourceMediaFilesystemLock(ozonRootDirectory, input.productSku, () => stageAndCommit((operation) => this.withSkuLock(input.platform + ':' + input.productSku, operation))));
      }
      record.targetFolder = destination;
      try {
        if (checkpoint.archiveFinal && checkpoint.archiveTemp) {
          const archiveFinalExists = await stat(checkpoint.archiveFinal).catch(() => undefined);
          if (archiveFinalExists) {
            if (!await verifyTree(checkpoint.archiveFinal, checkpoint.files)) throw new AppError('TARGET_FOLDER_EXISTS', '归档已存在不同内容');
          } else {
            if (!verifiedInThisRun && !await verifyTree(checkpoint.archiveTemp, checkpoint.files)) throw new AppError('VERIFY_FAILED', '已投递，但归档暂存校验失败');
            await rename(checkpoint.archiveTemp, checkpoint.archiveFinal);
            await syncDirectory(path.dirname(checkpoint.archiveFinal));
          }
          record.archiveFolder = checkpoint.archiveFinal;
        }
        record.status = 'SUCCESS'; record.errorCode = undefined; record.errorMessage = undefined; checkpoint.phase = 'COMPLETE';
      } catch (error: any) {
        record.status = 'PARTIAL_SUCCESS'; record.errorCode = 'ARCHIVE_ROOT_UNAVAILABLE'; record.errorMessage = error?.message || '归档失败';
      }
      record.completedAt = new Date().toISOString();
      checkpoint.record = structuredClone(record);
      await this.saveCheckpoint(checkpoint, true, input.platform);
      return record;
    } catch (error) {
      record.errorCode = error instanceof AppError ? error.code : ['EBUSY', 'EPERM', 'EAGAIN'].includes((error as NodeJS.ErrnoException)?.code || '') ? (error as NodeJS.ErrnoException).code : 'COPY_FAILED';
      record.errorMessage = error instanceof Error ? error.message : '共享媒体投递失败';
      record.completedAt = new Date().toISOString();
      if (['COMMIT_INTENT', 'COMPLETE'].includes(checkpoint.phase) || record.errorCode === 'DELIVERY_OUTCOME_UNKNOWN') {
        checkpoint.phase = 'NEEDS_ATTENTION'; record.status = 'FAILED'; record.errorCode = 'DELIVERY_OUTCOME_UNKNOWN';
      }
      checkpoint.record = structuredClone(record);
      await this.saveCheckpoint(checkpoint).catch(() => undefined);
      throw new TerminalDeliveryError(record, error);
    }
  }

  private async saveCheckpoint(checkpoint: DeliveryCheckpoint, completed = false, platform?: 'WB' | 'OZON'): Promise<void> {
    if (!this.store) return;
    checkpoint.updatedAt = new Date().toISOString();
    const started = performance.now();
    const sections = completed
      ? ['deliveryCheckpoints', 'deliveryOutbox', 'submissionHistory', 'appEvents'] as const
      : ['deliveryCheckpoints'] as const;
    await this.store.updateSections(sections, (db) => {
      const rows = db.deliveryCheckpoints ||= [];
      const index = rows.findIndex((row) => row.submissionId === checkpoint.submissionId);
      if (index < 0) rows.push(structuredClone(checkpoint)); else rows[index] = structuredClone(checkpoint);
      if (completed) {
        const historyIndex = db.submissionHistory.findIndex((row) => row.submissionId === checkpoint.submissionId);
        if (historyIndex < 0) db.submissionHistory.unshift(structuredClone(checkpoint.record)); else db.submissionHistory[historyIndex] = structuredClone(checkpoint.record);
        const outbox = db.deliveryOutbox ||= [];
        if (!outbox.some((row) => row.id === checkpoint.submissionId)) outbox.push({ id: checkpoint.submissionId, platform: platform!, submissionId: checkpoint.submissionId, status: 'PENDING', attempts: 0, createdAt: new Date().toISOString() });
        this.store!.appendEvent(db, `${platform}_MEDIA_DELIVERED`, `${checkpoint.record.sourceStageId} 审核媒体已投递到 ${platform} 共享媒体库`, {
          taskId: checkpoint.record.taskId,
          submissionId: checkpoint.record.submissionId,
          sku: checkpoint.record.productSku,
          variantName: checkpoint.record.variantName,
          targetFolder: checkpoint.record.targetFolder
        });
      }
    });
    addReviewOperationPhase('checkpointMs', performance.now() - started);
  }

  private async stageFiles(input: DeliveryInput, stagingRoot: string, variantName: string, kind: 'image' | 'video', submissionId: string): Promise<{ assets: ManifestAsset[]; files: FileReceipt[] }> {
    const extensions = kind === 'video' ? VIDEO_EXTENSIONS : IMAGE_EXTENSIONS;
    const deliveredAt = new Date().toISOString();
    const prepared = await settleAll(input.selectedRelativePaths.map((relativePath, sortOrder) => deliveryFileIoLimit(async () => {
      const source = await secureResolve(input.task.sourceFolder, relativePath);
      const sourceInfo = await lstat(source);
      const expected = input.task.images.find((image) => image.relativePath === relativePath);
      if (expected && (sourceInfo.size !== expected.sizeBytes || sourceInfo.mtime.toISOString() !== expected.lastModifiedAt)) throw new AppError('FILE_CHANGED', '接收审核后媒体发生变化，请重新核对', { relativePath }, 409);
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new AppError('SOURCE_FILE_MISSING', '选中的媒体文件不存在或不是普通文件', { relativePath });
      const extension = path.extname(source).toLocaleLowerCase('en-US');
      if (!(extensions as readonly string[]).includes(extension)) throw new AppError('UNSUPPORTED_FILE_TYPE', `${input.stage.id} 选中了不支持的媒体类型`, { relativePath });
      if (sourceInfo.size <= 0) throw new AppError('SOURCE_FILE_EMPTY', '选中的媒体文件为空', { relativePath });
      const target = path.join(stagingRoot, relativePath);
      if (!isPathInside(stagingRoot, target)) throw new AppError('PATH_TRAVERSAL_BLOCKED', '媒体相对路径超出暂存目录', { relativePath });
      await mkdir(path.dirname(target), { recursive: true });
      const receipt = await copyVerified(source, target);
      if (sourceInfo.size !== receipt.sizeBytes) throw new AppError('VERIFY_FAILED', '暂存媒体文件校验失败', { relativePath });
      const finalRelative = toApiRelativePath(path.join('variants', variantName, kind === 'video' ? 'videos' : 'images', submissionId, relativePath));
      return { file: { ...receipt, relativePath: toApiRelativePath(relativePath) }, asset: {
        assetId: createHash('sha256').update(`${finalRelative}\0${receipt.sha256}`).digest('hex'),
        submissionId,
        sourceSubmissionId: input.sourceSubmissionId,
        sourceStageId: input.stage.id,
        sourceTaskId: input.task.taskId,
        variantId: input.variantId,
        variantName,
        ...(input.variantColor ? { variantColor: input.variantColor } : {}),
        kind,
        sortOrder,
        relativePath: finalRelative,
        sizeBytes: receipt.sizeBytes,
        sha256: receipt.sha256,
        deliveredAt
      } satisfies ManifestAsset };
    })));
    const assets = prepared.map((item) => item.asset);
    const files = prepared.map((item) => item.file);
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return { assets, files };
  }

  private async inspectCommittedFiles(destination: string, outputRoot: string, input: DeliveryInput, kind: 'image' | 'video', submissionId: string, expected: ManifestAsset[], hashContents = true): Promise<ManifestAsset[]> {
    const files: string[] = [];
    await walkFiles(destination, files);
    const deliveredAt = new Date().toISOString();
    const expectedByPath = new Map(expected.map((asset) => [asset.relativePath, asset]));
    const assetsByPath = new Map<string, ManifestAsset>();
    for (const file of files) {
      const relativePath = toApiRelativePath(path.relative(path.dirname(outputRoot), file));
      const expectedAsset = expectedByPath.get(relativePath);
      if (!expectedAsset) throw new AppError('VERIFY_FAILED', `${input.platform} 共享媒体目标目录包含非本次选中的文件`, { destination, relativePath });
      const info = await stat(file);
      if (info.size !== expectedAsset.sizeBytes) throw new AppError('VERIFY_FAILED', `${input.platform} 共享媒体目标文件大小不一致`, { relativePath });
      const sha256 = hashContents ? await hashFile(file) : expectedAsset.sha256;
      assetsByPath.set(relativePath, { assetId: createHash('sha256').update(`${relativePath}\0${sha256}`).digest('hex'), submissionId, sourceSubmissionId: input.sourceSubmissionId, sourceStageId: input.stage.id, sourceTaskId: input.task.taskId, variantId: input.variantId, variantName: input.variantName, ...(input.variantColor ? { variantColor: input.variantColor } : {}), kind, sortOrder: expectedAsset.sortOrder, relativePath, sizeBytes: info.size, sha256, deliveredAt });
    }
    if (assetsByPath.size !== expected.length) throw new AppError('VERIFY_FAILED', `${input.platform} 共享媒体目标目录缺少本次选中的文件`, { destination });
    return expected.map((asset) => assetsByPath.get(asset.relativePath)!);
  }

  private async updateManifest(file: string, input: DeliveryInput, assets: ManifestAsset[]): Promise<void> {
    let current: VariantMediaManifest = { schemaVersion: 2, SKU: input.productSku, productName: input.productName, updatedAt: new Date().toISOString(), assets: [] };
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as VariantMediaManifest;
      if (![1, 2].includes(parsed.schemaVersion) || parsed.SKU !== input.productSku || !Array.isArray(parsed.assets)) throw new Error('清单结构无效');
      validateManifestAssetOrder(parsed.assets);
      current = parsed;
    } catch (error: any) {
       if (error?.code !== 'ENOENT') throw new AppError('MANIFEST_WRITE_FAILED', '现有共享媒体清单无法读取', { file, reason: error instanceof Error ? error.message : String(error) });
    }
    const replacingSubmissions = new Set(assets.map((asset) => asset.submissionId));
    current.assets = [...current.assets.filter((asset) => !replacingSubmissions.has(asset.submissionId)), ...assets];
    validateManifestAssetOrder(current.assets);
    current.productName = input.productName;
    current.schemaVersion = 2;
    current.updatedAt = new Date().toISOString();
    await writeFileAtomic(file, `${JSON.stringify(current, null, 2)}\n`, { fsync: true });
  }

  private async withSkuLock<T>(sku: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sku) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.catch(() => undefined).then(() => current);
    this.locks.set(sku, chain);
    await previous.catch(() => undefined);
    try { return await action(); }
    finally {
      release();
      if (this.locks.get(sku) === chain) this.locks.delete(sku);
    }
  }
}

export class TerminalDeliveryError extends Error {
  constructor(readonly record: SubmissionRecord, readonly cause: unknown) {
    super(record.errorMessage || '共享媒体投递失败');
    this.name = 'TerminalDeliveryError';
  }
}

function validateManifestAssetOrder(assets: ManifestAsset[]): void {
  const batches = new Map<string, ManifestAsset[]>();
  for (const asset of assets) {
    if (!asset || typeof asset.submissionId !== 'string' || !asset.submissionId) throw new Error('共享媒体清单批次标识无效');
    const batch = batches.get(asset.submissionId) || [];
    batch.push(asset);
    batches.set(asset.submissionId, batch);
  }
  for (const [submissionId, batch] of batches) {
    const hasSortOrder = batch.some((asset) => asset.sortOrder !== undefined);
    if (!hasSortOrder) continue;
    if (batch.some((asset) => typeof asset.sortOrder !== 'number' || !Number.isInteger(asset.sortOrder) || asset.sortOrder < 0)) {
      throw new Error(`共享媒体清单批次 ${submissionId} 的 sortOrder 缺失或无效`);
    }
    const ordered = [...batch].sort((left, right) => Number(left.sortOrder) - Number(right.sortOrder));
    if (ordered.some((asset, index) => asset.sortOrder !== index)) throw new Error(`共享媒体清单批次 ${submissionId} 的 sortOrder 不连续或重复`);
  }
}

function normalizePortablePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase('en-US');
}

async function walkFiles(directory: string, files: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new AppError('PATH_TRAVERSAL_BLOCKED', '媒体目录中不允许存在符号链接', { path: target });
    if (entry.isDirectory()) await walkFiles(target, files);
    else if (entry.isFile()) files.push(target);
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function copyDirectory(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  await settleAll((await readdir(source, { withFileTypes: true })).map(async (entry) => {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) return copyDirectory(from, to);
    if (entry.isFile()) return deliveryFileIoLimit(() => copyFile(from, to));
    throw new AppError('VERIFY_FAILED', '交付包包含不支持的文件类型');
  }));
}

async function settleAll<T>(promises: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}
