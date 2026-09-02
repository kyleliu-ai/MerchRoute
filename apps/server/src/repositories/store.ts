import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import writeFileAtomic from 'write-file-atomic';
import { randomUUID } from 'node:crypto';
import { AppError, type AppDatabase, type AppEvent, type ReviewRecord, type ReviewStatus } from '@n8n-media-review/shared';

const EMPTY_DB: AppDatabase = {
  schemaVersion: '1.0',
  reviews: [],
  pendingSubmissions: [],
  submissionHistory: [],
  submissionBatches: [],
  appEvents: []
};

export class StateStore {
  private data: AppDatabase = structuredClone(EMPTY_DB);
  private saveChain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private taskIdResolver?: (stageId: string, sourceFolder: string) => string;
  constructor(
    private readonly appDataDir: string,
    private readonly canonicalizeRead: (value: unknown) => unknown = (value) => value
  ) {}

  private get file(): string { return path.join(this.appDataDir, 'db.json'); }

  async initialize(): Promise<void> {
    await mkdir(this.appDataDir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<AppDatabase>;
      this.data = { ...structuredClone(EMPTY_DB), ...parsed } as AppDatabase;
    } catch (error: any) {
      if (error?.code !== 'ENOENT' && error?.name !== 'SyntaxError') throw error;
      await this.persist();
    }
  }

  read(): AppDatabase { return this.readView(this.data); }

  configureTaskIdResolver(resolver: (stageId: string, sourceFolder: string) => string): void {
    this.taskIdResolver = resolver;
    this.taskIdAliases();
  }

  resolveRuntimeTaskId(taskId: string): string {
    return this.taskIdAliases().storedToRuntime.get(taskId) || taskId;
  }

  resolvePersistedTaskId(taskId: string): string {
    return this.taskIdAliases().runtimeToStored.get(taskId) || taskId;
  }

  getReview(taskId: string): ReviewRecord | undefined {
    const storedTaskId = this.resolvePersistedTaskId(taskId);
    const review = this.data.reviews.find((item) => item.taskId === storedTaskId);
    return review ? this.readView(review) : undefined;
  }

  reviewStatuses(): Map<string, ReviewStatus> {
    const aliases = this.taskIdAliases();
    const statuses = new Map<string, ReviewStatus>();
    for (const review of this.data.reviews) {
      statuses.set(review.taskId, review.status);
      statuses.set(aliases.storedToRuntime.get(review.taskId) || review.taskId, review.status);
    }
    return statuses;
  }

  pendingSubmissionCountsBySourceStage(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const pending of this.data.pendingSubmissions) counts.set(pending.sourceStageId, (counts.get(pending.sourceStageId) || 0) + 1);
    return counts;
  }

  async update(mutator: (db: AppDatabase) => void): Promise<AppDatabase> {
    mutator(this.data);
    await this.persist();
    for (const listener of this.listeners) {
      try { listener(); } catch { /* State persistence must not fail because an observer failed. */ }
    }
    return this.read();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async addEvent(type: string, message: string, details?: Record<string, unknown>): Promise<AppEvent> {
    const event: AppEvent = { id: randomUUID(), type, message, details, createdAt: new Date().toISOString() };
    await this.update((db) => {
      db.appEvents.unshift(event);
      db.appEvents = db.appEvents.slice(0, 2000);
    });
    return event;
  }

  legacyRootReferenceCounts(inspect: (value: unknown) => { changedStrings: number; changedKeys: number }): Record<string, number> {
    return Object.fromEntries(Object.entries({
      reviews: this.data.reviews,
      pendingSubmissions: this.data.pendingSubmissions,
      submissionHistory: this.data.submissionHistory,
      submissionBatches: this.data.submissionBatches,
      appEvents: this.data.appEvents
    }).map(([section, value]) => {
      const result = inspect(value);
      return [section, result.changedStrings + result.changedKeys];
    }));
  }

  private readView<T>(value: T): T {
    return this.canonicalizeRead(structuredClone(value)) as T;
  }

  private taskIdAliases(): { storedToRuntime: Map<string, string>; runtimeToStored: Map<string, string> } {
    const storedToRuntime = new Map<string, string>();
    const runtimeToStored = new Map<string, string>();
    if (!this.taskIdResolver) return { storedToRuntime, runtimeToStored };
    const reviews = this.data.reviews.map((item) => ({ taskId: item.taskId, stageId: item.stageId, sourceFolder: item.sourceFolder }));
    for (const reference of reviews) {
      if (!reference.taskId || !reference.stageId || !reference.sourceFolder) continue;
      const canonicalSourceFolder = this.canonicalizeRead(reference.sourceFolder) as string;
      const runtimeTaskId = this.taskIdResolver(reference.stageId, canonicalSourceFolder);
      const previous = runtimeToStored.get(runtimeTaskId);
      if (previous && previous !== reference.taskId) {
        throw new AppError('LEGACY_TASK_ID_COLLISION', '历史任务路径映射产生重复任务 ID，已停止读取以避免覆盖审核记录', {
          runtimeTaskId,
          firstPersistedTaskId: previous,
          conflictingPersistedTaskId: reference.taskId
        }, 409);
      }
      storedToRuntime.set(reference.taskId, runtimeTaskId);
      runtimeToStored.set(runtimeTaskId, reference.taskId);
    }
    for (const reference of this.data.submissionHistory) {
      if (!reference.taskId || !reference.sourceStageId || !reference.sourceFolder) continue;
      const canonicalSourceFolder = this.canonicalizeRead(reference.sourceFolder) as string;
      storedToRuntime.set(reference.taskId, this.taskIdResolver(reference.sourceStageId, canonicalSourceFolder));
    }
    return { storedToRuntime, runtimeToStored };
  }

  private async persist(): Promise<void> {
    const snapshot = structuredClone(this.data);
    this.saveChain = this.saveChain.catch(() => undefined).then(() => atomicWriteWithRetry(this.file, `${JSON.stringify(snapshot, null, 2)}\n`));
    await this.saveChain;
  }
}

async function atomicWriteWithRetry(file: string, content: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await writeFileAtomic(file, content, { encoding: 'utf8' });
      return;
    } catch (error: any) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}
