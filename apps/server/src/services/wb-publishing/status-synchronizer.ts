import type { FastifyBaseLogger } from 'fastify';
import pLimit from 'p-limit';
import type { WbRepository } from '../../repositories/wb.js';
import type { WbPublishingService } from './index.js';
import type { WbSourceMediaCleanupService } from '../wb-source-media/index.js';

type SynchronizerOptions = {
  intervalMs?: number;
  batchSize?: number;
  concurrency?: number;
};

export type WbTaskSynchronizationResult = {
  checked: number;
  completed: number;
  pollErrors: number;
};

const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'BLOCKED', 'NEEDS_ATTENTION']);

export class WbTaskStatusSynchronizer {
  private stopped = true;
  private timer?: NodeJS.Timeout;
  private activePromise?: Promise<WbTaskSynchronizationResult>;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly concurrency: number;

  constructor(
    private readonly repository: WbRepository,
    private readonly publishing: WbPublishingService,
    private readonly logger: FastifyBaseLogger,
    options: SynchronizerOptions = {},
    private readonly sourceMediaCleanup?: WbSourceMediaCleanupService
  ) {
    this.intervalMs = Math.max(1_000, options.intervalMs ?? 5_000);
    this.batchSize = Math.min(100, Math.max(1, options.batchSize ?? 25));
    this.concurrency = Math.min(8, Math.max(1, options.concurrency ?? 4));
  }

  start(): void {
    // Pending message-center deliveries only need PostgreSQL. Keep the
    // compensator alive even when the n8n bridge is temporarily unavailable.
    if (!this.repository.configured || !this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.synchronizeNow(); }, this.intervalMs);
    void this.synchronizeNow();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activePromise?.catch(() => undefined);
  }

  async synchronizeNow(): Promise<WbTaskSynchronizationResult> {
    if (!this.repository.configured) return { checked: 0, completed: 0, pollErrors: 0 };
    if (this.activePromise) return this.activePromise;
    const operation = this.runOnce();
    this.activePromise = operation;
    try {
      return await operation;
    } finally {
      if (this.activePromise === operation) this.activePromise = undefined;
    }
  }

  private async runOnce(): Promise<WbTaskSynchronizationResult> {
    if (this.sourceMediaCleanup) {
      try {
        const cleanup = await this.sourceMediaCleanup.runDue(this.batchSize);
        if (cleanup.cleaned || cleanup.retried || cleanup.superseded) {
          this.logger.info({ cleanup }, 'WB 来源媒体后台清理批次已处理');
        }
      } catch (error) {
        this.logger.warn({ err: error }, 'WB 来源媒体后台清理器本轮执行失败，稍后重试');
      }
    }
    const notificationDelivery = await this.publishing.flushPendingListingNotifications(this.batchSize);
    if (notificationDelivery.errors.length) {
      this.logger.warn({ errors: notificationDelivery.errors }, 'WB 上品终态通知补投失败，稍后重试');
    }
    if (!this.publishing.n8n.configured) return { checked: 0, completed: 0, pollErrors: 0 };
    const tasks = await this.repository.listActiveTaskReferences(this.batchSize);
    if (!tasks.length) return { checked: 0, completed: 0, pollErrors: 0 };
    const limit = pLimit(this.concurrency);
    const results = await Promise.all(tasks.map((task) => limit(async () => {
      try {
        const result = await this.publishing.reconcileTaskStatus(task.sku);
        const status = String(result.listing.status || '');
        if (TERMINAL_STATUSES.has(status)) {
          this.logger.info({ sku: task.sku, taskId: task.taskId, status }, 'WB 上品任务状态已自动同步');
        } else if (result.pollError) {
          this.logger.debug({ sku: task.sku, taskId: task.taskId, pollError: result.pollError }, 'WB 上品任务状态暂未同步');
        }
        return { completed: TERMINAL_STATUSES.has(status) ? 1 : 0, pollErrors: result.pollError ? 1 : 0 };
      } catch (error) {
        this.logger.warn({ err: error, sku: task.sku, taskId: task.taskId }, 'WB 上品任务后台状态回读失败');
        return { completed: 0, pollErrors: 1 };
      }
    })));
    return results.reduce<WbTaskSynchronizationResult>((summary, result) => ({
      checked: summary.checked + 1,
      completed: summary.completed + result.completed,
      pollErrors: summary.pollErrors + result.pollErrors
    }), { checked: 0, completed: 0, pollErrors: 0 });
  }
}
