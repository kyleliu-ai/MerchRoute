import path from 'node:path';
import { mkdir, readFile, copyFile } from 'node:fs/promises';
import writeFileAtomic from 'write-file-atomic';
import { randomUUID } from 'node:crypto';
import { reviewOperationContext } from '../utils/review-operation-context.js';
import { AppError, type AppDatabase, type AppEvent, type ReviewRecord, type ReviewStatus, type ReviewOperation, type SubmissionRecord } from '@n8n-media-review/shared';

const EMPTY_DB: AppDatabase = {
  schemaVersion: '1.0', reviews: [], pendingSubmissions: [], submissionHistory: [], submissionBatches: [], appEvents: [],
  reviewOperations: [], deliveryCheckpoints: [], deliveryOutbox: [], reviewReplay: {}
};
type Section = Exclude<keyof AppDatabase, 'schemaVersion'>;
export type StateChange = { sections: Section[]; stageIds: string[]; revision: number };
type Aliases = { storedToRuntime: Map<string, string>; runtimeToStored: Map<string, string> };
type StoreOptions = { write?: (file: string, content: string) => Promise<void> };
const SECTIONS = Object.keys(EMPTY_DB).filter((key) => key !== 'schemaVersion') as Section[];

export class StateStore {
  private data: AppDatabase = deepFreeze(structuredClone(EMPTY_DB));
  private saveChain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(change: StateChange) => void>();
  private taskIdResolver?: (stageId: string, sourceFolder: string) => string;
  private aliases?: Aliases;
  private identityFingerprint = '';
  private statusCache?: Map<string, ReviewStatus>;
  private reviewIndex = new Map<string, ReviewRecord>();
  private serializedSections = new Map<Section, string>();
  private revision = 0;
  private writeFailure?: Error;
  constructor(
    private readonly appDataDir: string,
    private readonly canonicalizeRead: (value: unknown) => unknown = (value) => value,
    private readonly options: StoreOptions = {}
  ) {}
  private get file(): string { return path.join(this.appDataDir, 'db.json'); }

  async initialize(): Promise<void> {
    await mkdir(this.appDataDir, { recursive: true });
    let parsed: Partial<AppDatabase>;
    try { parsed = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error: any) {
      if (error?.code !== 'ENOENT') throw new AppError('STATE_STORE_UNAVAILABLE', '审核状态文件无法读取；已停止写入，请核对备份，禁止重置为空库', undefined, 503);
      await this.write(this.data);
      parsed = {};
    }
    if (parsed.schemaVersion && !['1.0', '1.1'].includes(parsed.schemaVersion)) throw new AppError('STATE_SCHEMA_UNSUPPORTED', '当前程序不支持该审核状态版本，请使用兼容版本', undefined, 503);
    for (const key of SECTIONS.filter((key) => key !== 'reviewReplay')) {
      if (parsed[key] !== undefined && !Array.isArray(parsed[key])) throw new AppError('STATE_STORE_UNAVAILABLE', '审核状态文件结构异常，已停止写入', { section: key }, 503);
    }
    this.data = deepFreeze({ ...structuredClone(EMPTY_DB), ...parsed } as AppDatabase);
    this.serializedSections = new Map(SECTIONS.map((key) => [key, JSON.stringify(this.data[key])]));
    this.identityFingerprint = identityFingerprint(this.data);
    this.reviewIndex = new Map(this.data.reviews.map((row) => [row.taskId, row]));
  }
  read(): AppDatabase { return this.readView(this.data); }
  section<K extends Section>(key: K): AppDatabase[K] { return this.readView(this.data[key]); }
  select<K extends Section, T>(key: K, select: (value: AppDatabase[K]) => T): T { return this.readView(select(this.data[key])); }
  getPending(id: string) { return this.select('pendingSubmissions', (rows) => rows.find((row) => row.id === id)); }
  getSubmission(id: string) { return this.select('submissionHistory', (rows) => rows.find((row) => row.submissionId === id)); }
  getSubmissionView(id: string) { return this.selectSubmissionHistory((rows) => rows.find((row) => row.submissionId === id)); }
  selectSubmissionHistory<T>(select: (rows: SubmissionRecord[]) => T): T {
    const operations = new Map((this.data.reviewOperations || []).map((row) => [row.operationId, row]));
    const awaiting = (this.data.deliveryCheckpoints || []).filter((row) => {
      if (!['COMMIT_INTENT', 'NEEDS_ATTENTION', 'TARGET_COMMITTED'].includes(row.phase)) return false;
      const owner = row.operationId ? operations.get(row.operationId) : undefined;
      return owner ? owner.status === 'NEEDS_ATTENTION' : row.phase === 'NEEDS_ATTENTION';
    });
    if (!awaiting.length) return this.readView(select(this.data.submissionHistory));
    const persisted = new Map(this.data.submissionHistory.map((row) => [row.submissionId, row]));
    const projected = new Map<string, SubmissionRecord>();
    for (const checkpoint of awaiting) {
      // A read projection must never overwrite an acknowledged successful leg.
      const existing = persisted.get(checkpoint.submissionId);
      if (existing?.status === 'SUCCESS' || existing?.status === 'PARTIAL_SUCCESS') continue;
      const owner = checkpoint.operationId ? operations.get(checkpoint.operationId) : undefined;
      projected.set(checkpoint.submissionId, {
        ...checkpoint.record, ...existing, status: 'FAILED', errorCode: 'DELIVERY_OUTCOME_UNKNOWN',
        errorMessage: owner?.error?.message || '投递结果无法确认，请核对原记录，禁止重复投递',
        completedAt: owner?.completedAt || checkpoint.updatedAt
      });
    }
    const rows = [...projected.values(), ...this.data.submissionHistory.filter((row) => !projected.has(row.submissionId))]
      .sort((a, b) => (b.completedAt || b.startedAt).localeCompare(a.completedAt || a.startedAt));
    return this.readView(select(rows));
  }
  getBatch(id: string) { return this.select('submissionBatches', (rows) => rows.find((row) => row.batchId === id)); }
  getOperation(id: string) { return this.select('reviewOperations', (rows) => rows?.find((row) => row.operationId === id)); }
  operations(activeOnly = false): ReviewOperation[] { return this.select('reviewOperations', (rows) => (rows || []).filter((row) => !activeOnly || operationIsActive(row))); }
  assertWritable(): void {
    if (this.writeFailure) throw new AppError('STATE_STORE_UNAVAILABLE', '审核状态保存失败；请恢复磁盘写入能力后再提交', undefined, 503);
  }
  get stateRevision(): number { return this.revision; }
  configureTaskIdResolver(resolver: (stageId: string, sourceFolder: string) => string): void {
    this.taskIdResolver = resolver; this.aliases = undefined; this.taskIdAliases();
  }
  resolveRuntimeTaskId(taskId: string): string { return this.taskIdAliases().storedToRuntime.get(taskId) || taskId; }
  resolvePersistedTaskId(taskId: string): string { return this.taskIdAliases().runtimeToStored.get(taskId) || taskId; }
  getReview(taskId: string): ReviewRecord | undefined {
    const review = this.reviewIndex.get(this.resolvePersistedTaskId(taskId));
    return review ? this.readView(review) : undefined;
  }
  reviewStatuses(): Map<string, ReviewStatus> {
    if (!this.statusCache) {
      const aliases = this.taskIdAliases();
      const statuses = new Map<string, ReviewStatus>();
      for (const review of this.data.reviews) {
        statuses.set(review.taskId, review.status);
        statuses.set(aliases.storedToRuntime.get(review.taskId) || review.taskId, review.status);
      }
      this.statusCache = statuses;
    }
    return new Map(this.statusCache);
  }
  pendingSubmissionCountsBySourceStage(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const pending of this.data.pendingSubmissions) counts.set(pending.sourceStageId, (counts.get(pending.sourceStageId) || 0) + 1);
    return counts;
  }
  async update(mutator: (db: AppDatabase) => void): Promise<void> { return this.updateSections(SECTIONS, mutator); }
  async updateSections(sections: readonly Section[], mutator: (db: AppDatabase) => void): Promise<void> {
    const operation = this.saveChain.catch(() => undefined).then(async () => {
      const before = this.data;
      const draft = { ...before };
      for (const key of sections) (draft as any)[key] = structuredClone(before[key]);
      mutator(draft);
      for (const key of SECTIONS) if (!sections.includes(key) && draft[key] !== before[key]) throw new Error('Undeclared state section: ' + key);
      const serialized = new Map<Section, string>();
      const changed = [...new Set(sections)];
      for (const key of changed) serialized.set(key, JSON.stringify(draft[key]));
      this.assertSubjectsUnlocked(before, draft, changed);
      this.advanceVersions(draft, before, changed);
      const nextFingerprint = changed.some((key) => key === 'reviews' || key === 'submissionHistory') ? identityFingerprint(draft) : this.identityFingerprint;
      const aliases = nextFingerprint === this.identityFingerprint ? this.aliases : this.buildAliases(draft);
      for (const key of changed) {
        this.canonicalizeRead(draft[key]);
        serialized.set(key, JSON.stringify(draft[key]));
      }
      const stageIds = changedStages(before, draft, changed);
      if ((draft.reviewOperations?.length || draft.deliveryCheckpoints?.length || draft.deliveryOutbox?.length) && draft.schemaVersion === '1.0') {
        await copyFile(this.file, path.join(this.appDataDir, 'db.before-review-operations-v1.json'), 1).catch((error: any) => { if (error?.code !== 'EEXIST') throw error; });
        draft.schemaVersion = '1.1';
      }
      try { await this.write(draft, serialized); this.writeFailure = undefined; }
      catch (error) { this.writeFailure = error as Error; throw error; }
      this.data = deepFreeze(draft);
      if (changed.includes('reviews')) this.reviewIndex = new Map(this.data.reviews.map((row) => [row.taskId, row]));
      if (changed.includes('reviews') || nextFingerprint !== this.identityFingerprint) this.statusCache = undefined;
      this.identityFingerprint = nextFingerprint;
      this.aliases = aliases;
      this.revision += 1;
      for (const listener of this.listeners) {
        try { listener({ sections: changed, stageIds, revision: this.revision }); } catch { /* observers cannot roll back a durable transaction */ }
      }
    });
    this.saveChain = operation;
    await operation;
  }
  async flush(): Promise<void> { await this.saveChain; }
  subscribe(listener: (change: StateChange) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  appendEvent(db: AppDatabase, type: string, message: string, details?: Record<string, unknown>): AppEvent {
    const event: AppEvent = { id: randomUUID(), type, message, details, createdAt: new Date().toISOString() };
    db.appEvents.unshift(event); db.appEvents = db.appEvents.slice(0, 2000); return event;
  }
  async addEvent(type: string, message: string, details?: Record<string, unknown>): Promise<AppEvent> {
    let event!: AppEvent;
    await this.updateSections(['appEvents'], (db) => { event = this.appendEvent(db, type, message, details); });
    return structuredClone(event);
  }
  legacyRootReferenceCounts(inspect: (value: unknown) => { changedStrings: number; changedKeys: number }): Record<string, number> {
    return Object.fromEntries(['reviews', 'pendingSubmissions', 'submissionHistory', 'submissionBatches', 'appEvents'].map((key) => {
      const result = inspect(this.data[key as Section]); return [key, result.changedStrings + result.changedKeys];
    }));
  }
  private readView<T>(value: T): T { return this.canonicalizeRead(structuredClone(value)) as T; }
  private taskIdAliases(): Aliases { return this.aliases ??= this.buildAliases(this.data); }
  private buildAliases(data: AppDatabase): Aliases {
    const storedToRuntime = new Map<string, string>();
    const runtimeToStored = new Map<string, string>();
    if (!this.taskIdResolver) return { storedToRuntime, runtimeToStored };
    for (const reference of data.reviews) {
      if (!reference.taskId || !reference.stageId || !reference.sourceFolder) continue;
      const runtimeTaskId = this.taskIdResolver(reference.stageId, this.canonicalizeRead(reference.sourceFolder) as string);
      const previous = runtimeToStored.get(runtimeTaskId);
      if (previous && previous !== reference.taskId) throw new AppError('LEGACY_TASK_ID_COLLISION', '历史任务路径映射产生重复任务 ID，已停止读取以避免覆盖审核记录', { runtimeTaskId, firstPersistedTaskId: previous, conflictingPersistedTaskId: reference.taskId }, 409);
      storedToRuntime.set(reference.taskId, runtimeTaskId); runtimeToStored.set(runtimeTaskId, reference.taskId);
    }
    for (const reference of data.submissionHistory) {
      if (!reference.taskId || !reference.sourceStageId || !reference.sourceFolder) continue;
      storedToRuntime.set(reference.taskId, this.taskIdResolver(reference.sourceStageId, this.canonicalizeRead(reference.sourceFolder) as string));
    }
    return { storedToRuntime, runtimeToStored };
  }
  private assertSubjectsUnlocked(before: AppDatabase, after: AppDatabase, changed: Section[]): void {
    const subjects = new Set<string>();
    for (const key of ['reviews', 'pendingSubmissions'] as const) {
      if (!changed.includes(key)) continue;
      const id = (row: any) => key === 'reviews' ? row.taskId : row.id;
      const previous = new Map<string, any>(before[key].map((row) => [id(row), row]));
      for (const row of after[key]) {
        if (JSON.stringify(row) !== JSON.stringify(previous.get(id(row)))) subjects.add('task:' + row.taskId);
        previous.delete(id(row));
      }
      for (const row of previous.values()) subjects.add('task:' + row.taskId);
    }
    const owner = reviewOperationContext.getStore()?.operationId;
    const locked = before.reviewOperations?.find((row) => row.operationId !== owner && operationIsActive(row) && row.subjectKeys.some((key) => subjects.has(key)));
    if (locked) throw new AppError('TASK_LOCKED', '任务正在处理或等待结果核对，暂不能修改', { operationId: locked.operationId }, 409);
  }
  private advanceVersions(draft: AppDatabase, before: AppDatabase, changed: Section[]): void {
    if (changed.includes('reviews')) {
      const previous = new Map(before.reviews.map((row) => [row.taskId, row]));
      for (const row of draft.reviews) {
        const old = previous.get(row.taskId);
        if (old && reviewContent(row) !== reviewContent(old)) row.version = (old.version || 0) + 1;
      }
    }
    if (changed.includes('pendingSubmissions')) {
      const previous = new Map(before.pendingSubmissions.map((row) => [row.id, row]));
      for (const row of draft.pendingSubmissions) {
        const old = previous.get(row.id);
        if (old && JSON.stringify([old.selectedRelativePaths, old.n8nTaskParameters, old.n8nTaskParameterOptions, old.conflictPolicy]) !== JSON.stringify([row.selectedRelativePaths, row.n8nTaskParameters, row.n8nTaskParameterOptions, row.conflictPolicy])) row.version = (old.version || 0) + 1;
      }
    }
  }
  private async write(value: AppDatabase, changed = new Map<Section, string>()): Promise<void> {
    const next = new Map(this.serializedSections);
    for (const key of SECTIONS) if (!next.has(key)) next.set(key, JSON.stringify(value[key]));
    for (const [key, serialized] of changed) next.set(key, serialized);
    const content = `{"schemaVersion":${JSON.stringify(value.schemaVersion)},${SECTIONS.map((key) => `${JSON.stringify(key)}:${next.get(key)}`).join(',')}}\n`;
    await (this.options.write || atomicWriteWithRetry)(this.file, content);
    this.serializedSections = next;
  }
}
export const operationIsActive = (operation: ReviewOperation): boolean => ['QUEUED', 'RUNNING', 'RETRY_WAIT', 'NEEDS_ATTENTION'].includes(operation.status);
function identityFingerprint(data: AppDatabase): string {
  return JSON.stringify([data.reviews.map((row) => [row.taskId, row.stageId, row.sourceFolder]), data.submissionHistory.map((row) => [row.taskId, row.sourceStageId, row.sourceFolder])]);
}
function reviewContent(row: ReviewRecord): string { return JSON.stringify([row.selectedRelativePaths, row.selectedTargetStageIds, row.variantSelectionGroups, row.productSku, row.variantId, row.status]); }
function changedStages(before: AppDatabase, after: AppDatabase, changed: Section[]): string[] {
  const ids = new Set<string>();
  if (changed.includes('reviews')) {
    const previous = new Map(before.reviews.map((row) => [row.taskId, row]));
    for (const row of after.reviews) { if (JSON.stringify(row) !== JSON.stringify(previous.get(row.taskId))) ids.add(row.stageId); previous.delete(row.taskId); }
    for (const row of previous.values()) ids.add(row.stageId);
  }
  if (changed.includes('pendingSubmissions')) {
    const previous = new Map(before.pendingSubmissions.map((row) => [row.id, row]));
    for (const row of after.pendingSubmissions) {
      const old = previous.get(row.id);
      if (!old || old.status !== row.status || old.sourceStageId !== row.sourceStageId) ids.add(row.sourceStageId);
      previous.delete(row.id);
    }
    for (const row of previous.values()) ids.add(row.sourceStageId);
  }
  return [...ids];
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}
async function atomicWriteWithRetry(file: string, content: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { await writeFileAtomic(file, content, { encoding: 'utf8', fsync: true }); return; }
    catch (error: any) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}
