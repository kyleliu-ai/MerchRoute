import path from 'node:path';
import { createHash } from 'node:crypto';
import { readdir, stat, lstat, readFile, realpath } from 'node:fs/promises';
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, type FolderTreeNode, type ImageItem, type ProductTask, type StageConfig, type TaskContext, type TaskDetail, AppError } from '@n8n-media-review/shared';
import type { ConfigService } from '../../config/service.js';
import type { StateStore } from '../../repositories/store.js';
import { fromApiRelativePath, isPathInside, normalizedTaskPath, secureResolve, toApiRelativePath } from '../../utils/paths.js';

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const ignoredFiles = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '_READY.json', 'selection-manifest.json', 'handoff.json', '.review-draft.json']);

function rawTaskId(stageId: string, sourceFolder: string): string {
  return createHash('sha256').update(`${stageId}${normalizedTaskPath(sourceFolder)}`).digest('hex');
}

export type PersistedMediaTaskSnapshot = Omit<ProductTask, 'status'> & { images: ImageItem[] };

export type PersistedMediaStageSnapshot = {
  stageId: string;
  scannedAt: string;
  rootFingerprint: string;
  rootDirectoryCount: number;
  tasks: PersistedMediaTaskSnapshot[];
};

export type IndexedMediaTask = ProductTask & { stage: StageConfig; images: ImageItem[] };

export type IndexedTaskInvalidation = {
  stageId: string;
  relativeTaskDirectory: string;
  taskId: string;
  reason: 'TASK_DIRECTORY_MISSING' | 'SOURCE_FILE_MISSING' | 'SOURCE_FILE_CHANGED';
};

export type ResolvedIndexedMedia = { task: IndexedMediaTask; image: ImageItem; absolutePath: string };
export type ResolveIndexedMediaOptions = { allowDisabledStage?: boolean };

type StageIndexMetadata = Pick<PersistedMediaStageSnapshot, 'scannedAt' | 'rootFingerprint' | 'rootDirectoryCount'>;

export class ScannerService {
  private index = new Map<string, IndexedMediaTask>();
  private readonly stageMetadata = new Map<string, StageIndexMetadata>();
  private readonly stageScanFlights = new Map<string, Promise<ProductTask[]>>();
  private allScanFlight?: Promise<Map<string, IndexedMediaTask>>;
  private persistentIndexAuthoritative = false;
  private readonly invalidationListeners = new Set<(event: IndexedTaskInvalidation) => void | Promise<void>>();
  constructor(
    private readonly config: ConfigService,
    private readonly store: StateStore,
    private readonly canonicalizePath: (value: string) => string = (value) => value
  ) {
    this.store.configureTaskIdResolver((stageId, sourceFolder) => this.taskId(stageId, sourceFolder));
  }

  setPersistentIndexAuthoritative(authoritative: boolean): void {
    this.persistentIndexAuthoritative = authoritative;
  }

  taskId(stageId: string, sourceFolder: string): string {
    return rawTaskId(stageId, this.canonicalizePath(sourceFolder));
  }

  async scanStage(stageId: string): Promise<ProductTask[]> {
    const active = this.stageScanFlights.get(stageId);
    if (active) return active;
    const operation = (async () => {
      const snapshot = await this.buildStageSnapshot(stageId);
      this.hydrateStage(snapshot);
      return this.listIndexedStageTasks(stageId);
    })();
    this.stageScanFlights.set(stageId, operation);
    try {
      return await operation;
    } finally {
      if (this.stageScanFlights.get(stageId) === operation) this.stageScanFlights.delete(stageId);
    }
  }

  async scanAll(): Promise<Map<string, IndexedMediaTask>> {
    if (this.allScanFlight) return this.allScanFlight;
    const operation = (async () => {
      const enabledStageIds = new Set(this.config.get().stages.filter((item) => item.reviewEnabled && item.enabled).map((item) => item.id));
      for (const stageId of [...this.stageMetadata.keys()]) if (!enabledStageIds.has(stageId)) this.replaceStageIndex(stageId, [], emptyStageMetadata());
      for (const stageId of enabledStageIds) await this.scanStage(stageId);
      return new Map(this.index);
    })();
    this.allScanFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.allScanFlight === operation) this.allScanFlight = undefined;
    }
  }

  async getTask(taskId: string): Promise<TaskDetail> {
    let task = await this.getIndexedTask(taskId);
    if (!task && !this.persistentIndexAuthoritative) {
      await this.scanAll();
      task = await this.getIndexedTask(taskId);
    }
    if (!task) throw new AppError('SOURCE_FOLDER_MISSING', '产品任务不存在或已被移动', { taskId }, 404);
    const review = this.store.getReview(taskId);
    const taskContext = await this.readTaskContext(task.sourceFolder, task.stageId);
    return {
      ...toProductTask(task, review?.status),
      tree: this.buildTree(task.images),
      images: task.images.map(cloneImage),
      selectedRelativePaths: review?.selectedRelativePaths || [],
      selectedTargetStageIds: review?.selectedTargetStageIds || [],
      variantSelectionGroups: review?.variantSelectionGroups || [],
      taskContext,
      productIdentity: { status: 'UNRESOLVED', message: '尚未解析产品身份' }
    };
  }

  async scanImages(root: string, mediaTypes: Array<'image' | 'video'> = ['image']): Promise<ImageItem[]> {
    const items: ImageItem[] = [];
    const resolvedRoot = await realpath(root);
    const walk = async (directory: string): Promise<void> => {
      const directoryInfo = await lstat(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
        throw new AppError('PATH_TRAVERSAL_BLOCKED', '扫描目录不是普通目录或已变为符号链接', { root, directory });
      }
      const resolvedDirectory = await realpath(directory);
      if (!isPathInside(resolvedRoot, resolvedDirectory) && normalizedTaskPath(resolvedRoot) !== normalizedTaskPath(resolvedDirectory)) {
        throw new AppError('PATH_TRAVERSAL_BLOCKED', '扫描目录真实路径超出产品任务目录', { root, directory });
      }
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => collator.compare(a.name, b.name));
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name.startsWith('_') || ignoredFiles.has(entry.name) || entry.name.startsWith('.review-')) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile()) {
          const extension = path.extname(entry.name).toLocaleLowerCase('en-US');
          const mediaType = VIDEO_EXTENSIONS.includes(extension as any) ? 'video' : IMAGE_EXTENSIONS.includes(extension as any) ? 'image' : undefined;
          if (!mediaType || !mediaTypes.includes(mediaType)) continue;
          const info = await lstat(absolute);
          if (info.isSymbolicLink()) continue;
          const resolvedFile = await realpath(absolute);
          if (!isPathInside(resolvedRoot, resolvedFile)) throw new AppError('PATH_TRAVERSAL_BLOCKED', '媒体文件真实路径超出产品任务目录', { root, absolute });
          const relativePath = toApiRelativePath(path.relative(root, absolute));
          const relativeDirectory = toApiRelativePath(path.dirname(path.relative(root, absolute)));
          items.push({ relativePath, fileName: entry.name, directory: relativeDirectory === '.' ? '' : relativeDirectory, sizeBytes: info.size, lastModifiedAt: info.mtime.toISOString(), mediaType });
        }
      }
    };
    await walk(root);
    return items.sort((a, b) => collator.compare(a.relativePath, b.relativePath));
  }

  async buildStageSnapshot(stageId: string): Promise<PersistedMediaStageSnapshot> {
    const stage = this.requireStage(stageId);
    if (!stage.enabled || !stage.candidateRoot || !stage.reviewEnabled) return { stageId, ...emptyStageMetadata(), tasks: [] };
    const rootInfo = await stat(stage.candidateRoot).catch(() => null);
    if (!rootInfo?.isDirectory()) return { stageId, ...emptyStageMetadata(), tasks: [] };
    const directories = (await readdir(stage.candidateRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && !entry.name.startsWith('_'))
      .sort((a, b) => collator.compare(a.name, b.name));
    const tasks: PersistedMediaTaskSnapshot[] = [];
    for (const directory of directories) {
      const snapshot = await this.buildTaskSnapshotFromName(stage, directory.name);
      if (snapshot) tasks.push(snapshot);
    }
    tasks.sort((a, b) => b.lastModifiedAt.localeCompare(a.lastModifiedAt));
    return {
      stageId,
      scannedAt: new Date().toISOString(),
      rootFingerprint: mediaDirectoryFingerprint(directories.map((entry) => entry.name)),
      rootDirectoryCount: directories.length,
      tasks
    };
  }

  async buildTaskSnapshot(stageId: string, relativeTaskDirectory: string): Promise<PersistedMediaTaskSnapshot | undefined> {
    const stage = this.requireStage(stageId);
    if (!stage.enabled || !stage.reviewEnabled || !stage.candidateRoot) return undefined;
    const normalized = normalizeRelativeTaskDirectory(relativeTaskDirectory);
    return this.buildTaskSnapshotFromName(stage, normalized);
  }

  exportStageSnapshot(stageId: string): PersistedMediaStageSnapshot | undefined {
    const metadata = this.stageMetadata.get(stageId);
    if (!metadata) return undefined;
    const tasks = [...this.index.values()]
      .filter((task) => task.stageId === stageId)
      .map(toPersistedTask)
      .sort((a, b) => b.lastModifiedAt.localeCompare(a.lastModifiedAt));
    return { stageId, ...metadata, tasks };
  }

  hydrateStage(snapshot: PersistedMediaStageSnapshot): ProductTask[] {
    const stage = this.requireStage(snapshot.stageId);
    if (!stage.enabled || !stage.reviewEnabled || !stage.candidateRoot) {
      this.replaceStageIndex(stage.id, [], pickStageMetadata(snapshot));
      return [];
    }
    const reviews = this.store.reviewStatuses();
    const tasks = snapshot.tasks.map((task) => this.indexedTaskFromSnapshot(stage, task, reviews.get(task.taskId)));
    this.replaceStageIndex(stage.id, tasks, pickStageMetadata(snapshot));
    return tasks.map((task) => toProductTask(task));
  }

  applyTaskSnapshot(stageId: string, relativeTaskDirectory: string, task?: PersistedMediaTaskSnapshot): ProductTask[] {
    const normalized = normalizeRelativeTaskDirectory(relativeTaskDirectory);
    const current = this.exportStageSnapshot(stageId) || { stageId, ...emptyStageMetadata(), tasks: [] };
    const nextTasks = current.tasks.filter((item) => normalizeRelativeTaskDirectory(item.sourceFolderName) !== normalized);
    if (task) nextTasks.push(task);
    return this.hydrateStage({ ...current, scannedAt: new Date().toISOString(), tasks: nextTasks });
  }

  listIndexedStageTasks(stageId: string): ProductTask[] {
    const reviews = this.store.reviewStatuses();
    return [...this.index.values()]
      .filter((task) => task.stageId === stageId)
      .map((task) => toProductTask(task, reviews.get(task.taskId)))
      .sort((a, b) => b.lastModifiedAt.localeCompare(a.lastModifiedAt));
  }

  hasStageSnapshot(stageId: string): boolean {
    return this.stageMetadata.has(stageId);
  }

  clearStageIndex(stageId: string): void {
    this.replaceStageIndex(stageId, [], emptyStageMetadata());
  }

  getStageIndexMetadata(stageId: string): StageIndexMetadata | undefined {
    const value = this.stageMetadata.get(stageId);
    return value ? { ...value } : undefined;
  }

  async getIndexedTask(taskId: string, options: ResolveIndexedMediaOptions = {}): Promise<IndexedMediaTask | undefined> {
    const runtimeTaskId = this.store.resolveRuntimeTaskId(taskId);
    const task = this.index.get(runtimeTaskId);
    if (!task) return undefined;
    const stage = this.config.get().stages.find((item) => item.id === task.stageId);
    if (!stage) throw new AppError('SOURCE_FOLDER_MISSING', '产品任务所属流程已被删除', { taskId, stageId: task.stageId }, 404);
    if ((!stage.enabled || !stage.reviewEnabled || !stage.candidateRoot) && !options.allowDisabledStage) {
      throw new AppError('STAGE_DISABLED', `流程 ${task.stageId} 已停用`, { stageId: task.stageId }, 409);
    }
    const expectedFolder = stage.candidateRoot ? path.resolve(stage.candidateRoot, fromApiRelativePath(task.sourceFolderName)) : undefined;
    if (!options.allowDisabledStage && (!expectedFolder || !isImmediateChild(stage.candidateRoot!, expectedFolder)
      || normalizedTaskPath(expectedFolder) !== normalizedTaskPath(task.sourceFolder))) {
      if (this.index.get(runtimeTaskId) === task) this.index.delete(runtimeTaskId);
      throw new AppError('SOURCE_FOLDER_MISSING', '产品任务不属于当前阶段候选目录', { taskId, stageId: task.stageId }, 404);
    }
    const source = await lstat(task.sourceFolder).catch(() => null);
    if (this.index.get(runtimeTaskId) !== task) return this.getIndexedTask(taskId, options);
    if (!source?.isDirectory() || source.isSymbolicLink()) {
      if (this.index.get(runtimeTaskId) === task) {
        this.index.delete(runtimeTaskId);
        this.emitInvalidation({
          stageId: task.stageId,
          relativeTaskDirectory: task.sourceFolderName,
          taskId: runtimeTaskId,
          reason: 'TASK_DIRECTORY_MISSING'
        });
      }
      throw new AppError('SOURCE_FOLDER_MISSING', '产品任务不存在或已被移动', { taskId }, 404);
    }
    return cloneIndexedTask(task);
  }

  async resolveIndexedMedia(taskId: string, relativePath: string, options: ResolveIndexedMediaOptions = {}): Promise<ResolvedIndexedMedia> {
    let task = await this.getIndexedTask(taskId, options);
    if (!task && !options.allowDisabledStage) {
      await this.getTask(taskId);
      task = await this.getIndexedTask(taskId, options);
    }
    if (!task) throw new AppError('SOURCE_FOLDER_MISSING', '产品任务不存在或已被移动', { taskId }, 404);
    const normalizedRelativePath = String(relativePath || '').replaceAll('\\', '/');
    fromApiRelativePath(normalizedRelativePath);
    const image = task.images.find((item) => item.relativePath === normalizedRelativePath);
    if (!image) throw new AppError('SOURCE_FILE_MISSING', '请求的媒体文件不在当前索引中', { taskId, relativePath: normalizedRelativePath }, 404);
    let absolutePath: string;
    try {
      absolutePath = await secureResolve(task.sourceFolder, normalizedRelativePath);
    } catch (error) {
      if (error instanceof AppError && error.code === 'SOURCE_FILE_MISSING') this.markSourceFileMissing(taskId);
      throw error;
    }
    const info = await lstat(absolutePath).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) {
      this.markSourceFileMissing(taskId);
      throw new AppError('SOURCE_FILE_MISSING', '索引中的媒体文件已不存在', { taskId, relativePath: normalizedRelativePath }, 404);
    }
    const indexedMtime = Date.parse(image.lastModifiedAt);
    if (info.size !== image.sizeBytes || !Number.isFinite(indexedMtime) || Math.abs(info.mtimeMs - indexedMtime) > 1) {
      this.markSourceFileChanged(taskId);
      throw new AppError('SOURCE_FILE_CHANGED', '媒体文件在索引后已发生变化，请等待索引刷新', {
        taskId,
        relativePath: normalizedRelativePath,
        indexedSizeBytes: image.sizeBytes,
        actualSizeBytes: info.size,
        indexedLastModifiedAt: image.lastModifiedAt,
        actualLastModifiedAt: info.mtime.toISOString()
      }, 409);
    }
    return { task, image: cloneImage(image), absolutePath };
  }

  onTaskInvalidated(listener: (event: IndexedTaskInvalidation) => void | Promise<void>): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  markSourceFileMissing(taskId: string): void {
    const runtimeTaskId = this.store.resolveRuntimeTaskId(taskId);
    const task = this.index.get(runtimeTaskId);
    if (!task) return;
    this.emitInvalidation({
      stageId: task.stageId,
      relativeTaskDirectory: task.sourceFolderName,
      taskId: runtimeTaskId,
      reason: 'SOURCE_FILE_MISSING'
    });
  }

  markSourceFileChanged(taskId: string): void {
    const runtimeTaskId = this.store.resolveRuntimeTaskId(taskId);
    const task = this.index.get(runtimeTaskId);
    if (!task) return;
    this.emitInvalidation({
      stageId: task.stageId,
      relativeTaskDirectory: task.sourceFolderName,
      taskId: runtimeTaskId,
      reason: 'SOURCE_FILE_CHANGED'
    });
  }

  private async buildTaskSnapshotFromName(stage: StageConfig, directoryName: string): Promise<PersistedMediaTaskSnapshot | undefined> {
    if (!stage.candidateRoot) return undefined;
    const normalized = normalizeRelativeTaskDirectory(directoryName);
    const sourceFolder = path.resolve(stage.candidateRoot, fromApiRelativePath(normalized));
    if (!isImmediateChild(stage.candidateRoot, sourceFolder)) throw new AppError('PATH_TRAVERSAL_BLOCKED', '任务目录必须位于阶段候选根目录下', { stageId: stage.id, relativeTaskDirectory: normalized });
    const folderInfo = await lstat(sourceFolder).catch(() => null);
    if (!folderInfo?.isDirectory() || folderInfo.isSymbolicLink()) return undefined;
    const scannedMedia = await this.scanImages(sourceFolder, stage.mediaTypes);
    const media = stage.id === 'E005' ? await orderMediaFromSelectionManifest(sourceFolder, scannedMedia) : scannedMedia;
    if (!media.length) return undefined;
    return {
      taskId: this.taskId(stage.id, sourceFolder),
      stageId: stage.id,
      sourceFolder,
      sourceFolderName: normalized,
      imageCount: media.filter((item) => item.mediaType !== 'video').length,
      videoCount: media.filter((item) => item.mediaType === 'video').length,
      mediaCount: media.length,
      subfolderCount: new Set(media.map((item) => item.directory).filter(Boolean)).size,
      lastModifiedAt: folderInfo.mtime.toISOString(),
      representativeImages: media.filter((item) => item.mediaType !== 'video').slice(0, 4).map((item) => item.relativePath),
      representativeMedia: media.slice(0, 4).map((item) => ({ relativePath: item.relativePath, mediaType: item.mediaType || 'image' })),
      images: media.map(cloneImage)
    };
  }

  private indexedTaskFromSnapshot(stage: StageConfig, snapshot: PersistedMediaTaskSnapshot, status?: ProductTask['status']): IndexedMediaTask {
    const relativeTaskDirectory = normalizeRelativeTaskDirectory(snapshot.sourceFolderName);
    const sourceFolder = stage.candidateRoot ? path.resolve(stage.candidateRoot, fromApiRelativePath(relativeTaskDirectory)) : '';
    if (!stage.candidateRoot || snapshot.stageId !== stage.id || !isImmediateChild(stage.candidateRoot, sourceFolder)
      || normalizedTaskPath(sourceFolder) !== normalizedTaskPath(this.canonicalizePath(snapshot.sourceFolder))) {
      throw new AppError('CONFIG_INVALID', '媒体索引任务路径与当前阶段配置不一致', { stageId: stage.id, taskId: snapshot.taskId });
    }
    const runtimeTaskId = this.taskId(stage.id, sourceFolder);
    const historicalTaskId = rawTaskId(stage.id, snapshot.sourceFolder);
    if (runtimeTaskId !== snapshot.taskId && historicalTaskId !== snapshot.taskId) {
      throw new AppError('CONFIG_INVALID', '媒体索引任务 ID 与源目录不匹配', { stageId: stage.id, taskId: snapshot.taskId });
    }
    const images = snapshot.images.map((image) => validateSnapshotImage(image, stage.mediaTypes));
    const imageCount = images.filter((item) => item.mediaType !== 'video').length;
    const videoCount = images.filter((item) => item.mediaType === 'video').length;
    return {
      taskId: runtimeTaskId,
      stageId: stage.id,
      sourceFolder,
      sourceFolderName: relativeTaskDirectory,
      imageCount,
      videoCount,
      mediaCount: images.length,
      subfolderCount: new Set(images.map((item) => item.directory).filter(Boolean)).size,
      lastModifiedAt: normalizeIsoDate(snapshot.lastModifiedAt),
      status: status || 'PENDING_REVIEW',
      representativeImages: snapshot.representativeImages.filter((relativePath) => images.some((image) => image.relativePath === relativePath)).slice(0, 4),
      representativeMedia: (snapshot.representativeMedia || []).filter((representative) => images.some((image) => image.relativePath === representative.relativePath)).slice(0, 4).map((item) => ({ ...item })),
      stage,
      images
    };
  }

  private replaceStageIndex(stageId: string, tasks: IndexedMediaTask[], metadata: StageIndexMetadata): void {
    const nextIndex = new Map([...this.index].filter(([, task]) => task.stageId !== stageId));
    for (const task of tasks) nextIndex.set(task.taskId, task);
    this.index = nextIndex;
    this.stageMetadata.set(stageId, { ...metadata });
  }

  private requireStage(stageId: string): StageConfig {
    const stage = this.config.get().stages.find((item) => item.id === stageId);
    if (!stage) throw new AppError('CONFIG_INVALID', '阶段不存在', { stageId }, 404);
    return stage;
  }

  private emitInvalidation(event: IndexedTaskInvalidation): void {
    for (const listener of this.invalidationListeners) void Promise.resolve(listener(event)).catch(() => undefined);
  }

  private async readTaskContext(root: string, stageId: string): Promise<TaskContext | undefined> {
    const candidates = ['task-context.json', ...(await readdir(root).catch(() => [])).filter((name) => /^n8n_setParameter_.*\.json$/i.test(name)).sort().reverse()];
    for (const name of candidates) {
      try {
        const value = JSON.parse(await readFile(path.join(root, name), 'utf8')) as Record<string, unknown>;
        const sku = String(value.SKU || '').trim();
        const productName = String(value.productName || '').trim();
        if (!/^\d{7}$/.test(sku) || !productName) continue;
        const variants = typeof value.variants === 'string' ? value.variants.trim() : undefined;
        return {
          schemaVersion: 1,
          workflowCode: typeof value.workflowCode === 'string' ? value.workflowCode : stageId,
          SKU: sku,
          productName,
          ...(typeof value.variantId === 'string' ? { variantId: value.variantId } : {}),
          ...(variants ? { variants } : {}),
          ...(typeof value.sourceSubmissionId === 'string' ? { sourceSubmissionId: value.sourceSubmissionId } : {}),
          ...(typeof value.n8nExecutionId === 'string' ? { n8nExecutionId: value.n8nExecutionId } : {})
        };
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private buildTree(images: ImageItem[]): FolderTreeNode[] {
    type MutableNode = Omit<FolderTreeNode, 'children'> & { children: MutableNode[]; map: Map<string, MutableNode> };
    const root: MutableNode = { key: '', title: '根目录', imageCount: 0, children: [], map: new Map() };
    for (const image of images) {
      const parts = image.directory ? image.directory.split('/') : [];
      let node = root;
      if (!parts.length) root.imageCount += 1;
      for (const part of parts) {
        const key = node.key ? `${node.key}/${part}` : part;
        let child = node.map.get(part);
        if (!child) {
          child = { key, title: part, imageCount: 0, children: [], map: new Map() };
          node.map.set(part, child);
          node.children.push(child);
        }
        child.imageCount += 1;
        node = child;
      }
    }
    const strip = (node: MutableNode): FolderTreeNode => ({ key: node.key, title: node.title, imageCount: node.imageCount, children: node.children.map(strip) });
    const result = root.children.map(strip);
    if (root.imageCount) result.unshift({ key: '', title: '根目录', imageCount: root.imageCount, children: [] });
    return result;
  }
}

function emptyStageMetadata(): StageIndexMetadata {
  return { scannedAt: new Date().toISOString(), rootFingerprint: mediaDirectoryFingerprint([]), rootDirectoryCount: 0 };
}

async function orderMediaFromSelectionManifest(root: string, media: ImageItem[]): Promise<ImageItem[]> {
  const manifestPath = path.join(root, 'selection-manifest.json');
  let parsed: { selectedFiles?: unknown };
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as { selectedFiles?: unknown };
  } catch (error: any) {
    if (error?.code === 'ENOENT') return media;
    throw new AppError('CONFIG_INVALID', 'E005 输出顺序清单无法读取', { manifestPath, reason: error instanceof Error ? error.message : String(error) }, 409);
  }
  if (!Array.isArray(parsed.selectedFiles) || !parsed.selectedFiles.length) {
    throw new AppError('CONFIG_INVALID', 'E005 输出顺序清单缺少 selectedFiles', { manifestPath }, 409);
  }
  const entries = parsed.selectedFiles.map((value, index) => {
    if (!value || typeof value !== 'object') throw new AppError('CONFIG_INVALID', 'E005 输出顺序清单包含无效文件条目', { manifestPath, index }, 409);
    const entry = value as { targetRelativePath?: unknown; sortOrder?: unknown };
    const targetRelativePath = String(entry.targetRelativePath || '').replaceAll('\\', '/');
    try {
      fromApiRelativePath(targetRelativePath);
    } catch (error) {
      throw new AppError('CONFIG_INVALID', 'E005 输出顺序清单包含无效目标路径', { manifestPath, index, targetRelativePath, reason: error instanceof Error ? error.message : String(error) }, 409);
    }
    return { targetRelativePath, sortOrder: entry.sortOrder };
  });
  const hasSortOrder = entries.some((entry) => entry.sortOrder !== undefined);
  let ordered = entries;
  if (hasSortOrder) {
    if (entries.some((entry) => typeof entry.sortOrder !== 'number' || !Number.isInteger(entry.sortOrder) || entry.sortOrder < 0)) {
      throw new AppError('CONFIG_INVALID', 'E005 输出顺序清单的 sortOrder 必须全部为非负整数', { manifestPath }, 409);
    }
    ordered = [...entries].sort((left, right) => Number(left.sortOrder) - Number(right.sortOrder));
    if (ordered.some((entry, index) => entry.sortOrder !== index)) {
      throw new AppError('CONFIG_INVALID', 'E005 输出顺序清单的 sortOrder 必须从 0 开始且连续唯一', { manifestPath }, 409);
    }
  }
  const mediaByPath = new Map(media.map((item) => [item.relativePath, item]));
  const orderedPaths = ordered.map((entry) => entry.targetRelativePath);
  if (new Set(orderedPaths).size !== orderedPaths.length || orderedPaths.length !== media.length || orderedPaths.some((relativePath) => !mediaByPath.has(relativePath))) {
    throw new AppError('CONFIG_INVALID', 'E005 输出顺序清单与候选图片集合不一致', {
      manifestPath,
      manifestRelativePaths: orderedPaths,
      candidateRelativePaths: media.map((item) => item.relativePath)
    }, 409);
  }
  return orderedPaths.map((relativePath) => mediaByPath.get(relativePath)!);
}

function pickStageMetadata(snapshot: PersistedMediaStageSnapshot): StageIndexMetadata {
  return {
    scannedAt: normalizeIsoDate(snapshot.scannedAt),
    rootFingerprint: String(snapshot.rootFingerprint || mediaDirectoryFingerprint([])),
    rootDirectoryCount: Math.max(0, Number(snapshot.rootDirectoryCount) || 0)
  };
}

export function mediaDirectoryFingerprint(names: string[]): string {
  const normalized = names.map((name) => process.platform === 'win32' ? name.toLocaleLowerCase('en-US') : name).sort((a, b) => collator.compare(a, b));
  return createHash('sha256').update(normalized.join('\0')).digest('hex');
}

function normalizeRelativeTaskDirectory(value: string): string {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '').normalize('NFC');
  const parts = normalized.split('/');
  if (!normalized || parts.length !== 1 || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new AppError('INVALID_RELATIVE_PATH', '任务目录必须是候选根目录下的一级相对目录', { relativeTaskDirectory: value });
  }
  return normalized;
}

function isImmediateChild(root: string, candidate: string): boolean {
  if (!isPathInside(root, candidate)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative === '.' || relative.split(path.sep).length !== 1) return false;
  if (process.platform !== 'win32') return true;
  return path.dirname(path.resolve(candidate)).toLocaleLowerCase('en-US') === path.resolve(root).toLocaleLowerCase('en-US');
}

function validateSnapshotImage(image: ImageItem, mediaTypes: Array<'image' | 'video'>): ImageItem {
  const relativePath = String(image.relativePath || '').replaceAll('\\', '/');
  fromApiRelativePath(relativePath);
  const extension = path.posix.extname(relativePath).toLocaleLowerCase('en-US');
  const mediaType = image.mediaType || (VIDEO_EXTENSIONS.includes(extension as any) ? 'video' : 'image');
  if (!mediaTypes.includes(mediaType) || (mediaType === 'video' ? !VIDEO_EXTENSIONS.includes(extension as any) : !IMAGE_EXTENSIONS.includes(extension as any))) {
    throw new AppError('CONFIG_INVALID', '媒体索引中包含阶段不支持的文件类型', { relativePath, mediaType });
  }
  const fileName = path.posix.basename(relativePath);
  const directory = path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath);
  return {
    relativePath,
    fileName,
    directory,
    sizeBytes: Math.max(0, Number(image.sizeBytes) || 0),
    lastModifiedAt: normalizeIsoDate(image.lastModifiedAt),
    mediaType
  };
}

function normalizeIsoDate(value: string): string {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) throw new AppError('CONFIG_INVALID', '媒体索引时间戳无效', { value });
  return new Date(timestamp).toISOString();
}

function cloneImage(image: ImageItem): ImageItem {
  return { ...image };
}

function toPersistedTask(task: IndexedMediaTask): PersistedMediaTaskSnapshot {
  const product = toProductTask(task);
  return {
    taskId: product.taskId,
    stageId: product.stageId,
    sourceFolder: product.sourceFolder,
    sourceFolderName: product.sourceFolderName,
    imageCount: product.imageCount,
    videoCount: product.videoCount,
    mediaCount: product.mediaCount,
    subfolderCount: product.subfolderCount,
    lastModifiedAt: product.lastModifiedAt,
    representativeImages: [...product.representativeImages],
    representativeMedia: product.representativeMedia?.map((item) => ({ ...item })),
    images: task.images.map(cloneImage)
  };
}

function toProductTask(task: IndexedMediaTask, status: ProductTask['status'] = task.status): ProductTask {
  return {
    taskId: task.taskId,
    stageId: task.stageId,
    sourceFolder: task.sourceFolder,
    sourceFolderName: task.sourceFolderName,
    imageCount: task.imageCount,
    videoCount: task.videoCount,
    mediaCount: task.mediaCount,
    subfolderCount: task.subfolderCount,
    lastModifiedAt: task.lastModifiedAt,
    status,
    representativeImages: [...task.representativeImages],
    representativeMedia: task.representativeMedia?.map((item) => ({ ...item }))
  };
}

function cloneIndexedTask(task: IndexedMediaTask): IndexedMediaTask {
  return {
    ...toProductTask(task),
    stage: structuredClone(task.stage),
    images: task.images.map(cloneImage)
  };
}
