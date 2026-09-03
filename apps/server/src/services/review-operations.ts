import { createHash, randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { FastifyBaseLogger } from 'fastify';
import { AppError, type AppDatabase, type ReviewOperation, type ReviewOperationProgress } from '@n8n-media-review/shared';
import { StateStore, operationIsActive } from '../repositories/store.js';
import { reviewOperationContext } from '../utils/review-operation-context.js';

type Executor = (operation: ReviewOperation) => Promise<unknown>;
type AcceptedInput = {
  kind: ReviewOperation['kind']; requestKey: string; request: unknown;
  subjectKeys: string[]; input: Record<string, unknown>;
  validate?: (db: AppDatabase) => void;
};
const RETRY_MS = [1000, 3000, 10000];
const TERMINAL = new Set(['SUCCEEDED', 'PARTIAL_SUCCESS', 'FAILED', 'NEEDS_ATTENTION']);

export class ReviewOperationService {
  private readonly executors = new Map<ReviewOperation['kind'], Executor>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly progress = new Map<string, ReviewOperationProgress>();
  private readonly subscribers = new Set<ServerResponse>();
  private timer?: NodeJS.Timeout;
  private publishing = new Set<string>();
  private stopped = true;
  private accepting = true;
  constructor(private readonly store: StateStore, private readonly logger: FastifyBaseLogger) {}
  register(kind: ReviewOperation['kind'], executor: Executor): void { this.executors.set(kind, executor); }
  get currentId(): string | undefined { return reviewOperationContext.getStore()?.operationId; }
  get busy(): boolean { return this.store.operations(true).some((row) => row.status !== 'NEEDS_ATTENTION'); }

  async accept(input: AcceptedInput): Promise<ReviewOperation> {
    if (!this.accepting) throw new AppError('SERVICE_STOPPING', '服务正在停止接收新任务，请稍后重试', undefined, 503);
    if (!/^[A-Za-z0-9:_.-]{1,160}$/.test(input.requestKey)) throw new AppError('CONFIG_INVALID', '请求编号格式无效');
    const requestHash = stableHash({ kind: input.kind, request: input.request });
    let accepted!: ReviewOperation;
    await this.store.updateSections(['reviewOperations'], (db) => {
      const rows = db.reviewOperations ||= [];
      const existing = rows.find((row) => row.requestKey === input.requestKey || row.requestAliases?.includes(input.requestKey));
      if (existing) {
        if (existing.requestHash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT', '相同请求编号不能提交不同内容', undefined, 409);
        accepted = existing;
        return;
      }
      const same = rows.find((row) => row.kind === input.kind && row.requestHash === requestHash && row.subjectKeys.some((key) => input.subjectKeys.includes(key)) && operationIsActive(row));
      if (same) { (same.requestAliases ||= []).push(input.requestKey); accepted = same; return; }
      const conflicting = rows.find((row) => operationIsActive(row) && row.subjectKeys.some((key) => input.subjectKeys.includes(key)));
      if (conflicting) throw new AppError('TASK_LOCKED', '该任务正在处理或等待结果核对', { operationId: conflicting.operationId }, 409);
      const units = (row: { input: Record<string, unknown> }) => Math.max(1, Array.isArray(row.input.pendingSubmissionIds) ? row.input.pendingSubmissionIds.length : 1);
      if (rows.filter(operationIsActive).reduce((total, row) => total + units(row), 0) + units(input) > 200) throw new AppError('REVIEW_QUEUE_FULL', '投递队列已满，请稍后重试', { retryAfterSeconds: 5 }, 429);
      input.validate?.(db);
      const now = new Date().toISOString();
      accepted = { operationId: randomUUID(), kind: input.kind, requestKey: input.requestKey, requestHash, subjectKeys: [...new Set(input.subjectKeys)], input: structuredClone(input.input), status: 'QUEUED', createdAt: now, updatedAt: now, attempt: 0 };
      rows.push(accepted);
    });
    this.publish(accepted.operationId);
    this.kick();
    return structuredClone(accepted);
  }

  lookup(kind: ReviewOperation['kind'], key: string, request: unknown): ReviewOperation | undefined {
    const row = this.store.select('reviewOperations', (rows) => rows?.find((row) => row.requestKey === key || row.requestAliases?.includes(key)));
    if (row && row.requestHash !== stableHash({ kind, request })) throw new AppError('IDEMPOTENCY_CONFLICT', '相同请求编号不能提交不同内容', undefined, 409);
    return row;
  }
  async start(): Promise<void> {
    this.stopped = false;
    // Running operations are reconciled by the same executor and checkpoint IDs.
    await this.store.updateSections(['reviewOperations'], (db) => {
      for (const row of db.reviewOperations || []) if (row.status === 'RUNNING') { row.status = 'QUEUED'; row.updatedAt = new Date().toISOString(); }
    });
    this.timer = setInterval(() => { this.flushEvents(); this.kick(); }, 1000);
    this.timer.unref();
    this.kick();
  }
  async stop(): Promise<void> {
    this.accepting = false; this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.running.values()]);
    this.flushEvents();
    for (const client of this.subscribers) client.end();
    this.subscribers.clear();
    await this.store.flush();
  }
  view(id: string): Omit<ReviewOperation, 'input' | 'requestHash' | 'requestKey'> & { progress?: ReviewOperationProgress } {
    const operation = this.store.getOperation(id);
    if (!operation) throw new AppError('OPERATION_NOT_FOUND', '提交任务不存在', { operationId: id }, 404);
    const { input: _input, requestHash: _hash, requestKey: _key, requestAliases: _aliases, ...publicOperation } = operation;
    void [_input, _hash, _key, _aliases];
    let error = publicOperation.error;
    try { this.store.assertWritable(); } catch {
      error = { code: 'STATE_STORE_UNAVAILABLE', message: '状态文件暂时无法保存；磁盘恢复后点击恢复处理，原投递编号保持不变', statusCode: 503 };
    }
    return { ...publicOperation, error, progress: this.progress.get(id) };
  }
  list(activeOnly: boolean) { return this.store.operations(activeOnly).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, activeOnly ? 200 : 50).map((row) => { const { result: _result, ...view } = this.view(row.operationId); void _result; return view; }); }
  report(patch: Omit<ReviewOperationProgress, 'operationId' | 'updatedAt'>, operationId = this.currentId): void {
    if (!operationId) return;
    this.progress.set(operationId, { ...this.progress.get(operationId), ...patch, operationId, updatedAt: new Date().toISOString() });
    this.publishing.add(operationId);
  }
  addClient(client: ServerResponse): () => void {
    client.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    client.flushHeaders();
    client.write('event: ready\ndata: {}\n\n');
    this.subscribers.add(client);
    return () => this.subscribers.delete(client);
  }
  async wait(id: string): Promise<unknown> {
    for (;;) {
      const row = this.store.getOperation(id);
      if (!row) throw new AppError('OPERATION_NOT_FOUND', '提交任务不存在', undefined, 404);
      if (TERMINAL.has(row.status)) {
        if (row.status === 'NEEDS_ATTENTION' || (row.status === 'FAILED' && row.result === undefined)) throw new AppError(row.error?.code || 'REVIEW_OPERATION_FAILED', row.error?.message || '处理失败，请核对任务状态', { ...(row.error?.details as object), operationId: id }, row.error?.statusCode || (row.status === 'NEEDS_ATTENTION' ? 409 : 400));
        return row.result;
      }
      this.store.assertWritable();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  async retry(id: string): Promise<ReviewOperation> {
    const existing = this.store.getOperation(id);
    if (!existing) throw new AppError('OPERATION_NOT_FOUND', '提交任务不存在', undefined, 404);
    if (this.running.has(id)) return existing;
    await this.store.updateSections(['reviewOperations'], (db) => {
      const row = db.reviewOperations!.find((item) => item.operationId === id)!;
      if (!['QUEUED', 'RUNNING', 'FAILED', 'PARTIAL_SUCCESS', 'NEEDS_ATTENTION'].includes(row.status)) return;
      const conflict = db.reviewOperations!.find((other) => other.operationId !== id && operationIsActive(other) && other.subjectKeys.some((key) => row.subjectKeys.includes(key)));
      if (conflict) throw new AppError('TASK_LOCKED', '另一个操作正在处理该任务', { operationId: conflict.operationId }, 409);
      row.status = 'QUEUED'; row.error = undefined; row.result = undefined; row.completedAt = undefined; row.nextAttemptAt = undefined; row.updatedAt = new Date().toISOString();
    });
    this.kick();
    return this.store.getOperation(id)!;
  }
  private kick(): void {
    if (this.stopped) return;
    try { this.store.assertWritable(); } catch { return; }
    const candidates = this.store.operations(true).filter((row) => (row.status === 'QUEUED' || (row.status === 'RETRY_WAIT' && Date.parse(row.nextAttemptAt || '') <= Date.now())) && !this.running.has(row.operationId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const row of candidates) {
      if (this.running.size >= 4) break;
      const promise = this.run(row.operationId).catch((error) => this.logger.error({ err: error, operationId: row.operationId }, '任务状态保存失败，保留原任务等待核对')).finally(() => { this.running.delete(row.operationId); this.kick(); });
      this.running.set(row.operationId, promise);
    }
  }
  private async run(id: string): Promise<void> {
    await this.store.updateSections(['reviewOperations'], (db) => {
      const row = db.reviewOperations!.find((row) => row.operationId === id)!;
      row.status = 'RUNNING'; row.attempt += 1; row.startedAt ||= new Date().toISOString(); row.updatedAt = new Date().toISOString(); row.error = undefined;
    });
    const row = this.store.getOperation(id)!;
    this.publish(id);
    const started = performance.now();
    await reviewOperationContext.run({ operationId: id }, async () => {
      try {
        const execute = this.executors.get(row.kind);
        if (!execute) throw new AppError('OPERATION_UNSUPPORTED', '当前程序不能执行该任务，请使用兼容版本');
        const result: any = await execute(row);
        if (this.store.getOperation(id)?.status === 'SUCCEEDED') return;
        const statuses: string[] = result?.results?.map((item: any) => item.status) || result?.submissions?.map((item: any) => item.status) || [];
        const partial = result?.status === 'PARTIAL_SUCCESS' || statuses.some((status) => ['PARTIAL_SUCCESS', 'FAILED'].includes(status));
        const allFailed = statuses.length > 0 && statuses.every((status) => status === 'FAILED');
        const firstFailure = (result?.results || result?.submissions || [result]).find((item: any) => ['FAILED', 'PARTIAL_SUCCESS'].includes(item?.status));
        await this.store.updateSections(['reviewOperations'], (db) => {
          const current = db.reviewOperations!.find((item) => item.operationId === id)!;
          Object.assign(current, { status: allFailed ? 'FAILED' : partial ? 'PARTIAL_SUCCESS' : 'SUCCEEDED', result, error: firstFailure ? { code: firstFailure.errorCode || 'DELIVERY_INCOMPLETE', message: firstFailure.errorMessage || '部分投递尚未完成，请重试未完成部分' } : undefined, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        });
      } catch (error: any) {
        const checkpoint = this.store.select('deliveryCheckpoints', (rows) => rows?.find((item) => item.operationId === id && ['COMMIT_INTENT', 'NEEDS_ATTENTION'].includes(item.phase)));
        const unknown = Boolean(checkpoint) || ['DELIVERY_OUTCOME_UNKNOWN', 'STATE_STORE_UNAVAILABLE'].includes(error?.code);
        const delay = !unknown && ['EBUSY', 'EPERM', 'EAGAIN'].includes(error?.code) ? RETRY_MS[row.attempt - 1] : undefined;
        await this.store.updateSections(['reviewOperations'], (db) => {
          const current = db.reviewOperations!.find((item) => item.operationId === id)!;
          Object.assign(current, { status: unknown ? 'NEEDS_ATTENTION' : delay === undefined ? 'FAILED' : 'RETRY_WAIT', error: { code: error?.code || 'REVIEW_OPERATION_FAILED', message: error?.message || '处理失败', statusCode: error?.statusCode, details: error?.details }, updatedAt: new Date().toISOString(), nextAttemptAt: delay === undefined ? undefined : new Date(Date.now() + delay).toISOString(), completedAt: delay === undefined ? new Date().toISOString() : undefined });
        });
      } finally {
        this.logger.info({ operationId: id, kind: row.kind, elapsedMs: Math.round(performance.now() - started), status: this.store.getOperation(id)?.status }, '审核投递操作处理结束');
        this.publish(id);
      }
    });
  }
  private publish(id: string): void { this.publishing.add(id); }
  private flushEvents(): void {
    const ids = this.publishing; this.publishing = new Set();
    for (const client of this.subscribers) {
      if (client.destroyed || client.writableEnded) { this.subscribers.delete(client); continue; }
      try {
        let writable = true;
        if (!ids.size) writable = client.write(': keep-alive\n\n');
        for (const id of ids) writable = client.write('event: review-operation\ndata: ' + JSON.stringify(this.view(id)) + '\n\n') && writable;
        if (!writable) { client.destroy(); this.subscribers.delete(client); }
      } catch { client.destroy(); this.subscribers.delete(client); }
    }
  }
}
export function stableHash(value: unknown): string {
  const canonical = (item: any): any => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().filter((key) => item[key] !== undefined).map((key) => [key, canonical(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
