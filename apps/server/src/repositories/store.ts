import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import writeFileAtomic from 'write-file-atomic';
import { randomUUID } from 'node:crypto';
import type { AppDatabase, AppEvent, ReviewRecord, ReviewStatus } from '@n8n-media-review/shared';

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
  constructor(private readonly appDataDir: string) {}

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

  read(): AppDatabase { return structuredClone(this.data); }

  getReview(taskId: string): ReviewRecord | undefined {
    const review = this.data.reviews.find((item) => item.taskId === taskId);
    return review ? structuredClone(review) : undefined;
  }

  reviewStatuses(): Map<string, ReviewStatus> {
    return new Map(this.data.reviews.map((review) => [review.taskId, review.status]));
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
