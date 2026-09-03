import type { FastifyBaseLogger } from 'fastify';
import type { DeliveryOutboxEntry, SubmissionRecord } from '@n8n-media-review/shared';
import type { StateStore } from '../repositories/store.js';

export class DeliveryOutboxService {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(private readonly store: StateStore, private readonly logger: FastifyBaseLogger, private readonly deliver: (entry: DeliveryOutboxEntry, record: SubmissionRecord) => Promise<unknown>) {}
  start(): void {
    this.timer = setInterval(() => { if (!this.running) this.running = this.tick().catch((error) => this.logger.error({ err: error }, '媒体通知状态保存失败')).finally(() => { this.running = undefined; }); }, 1000);
    this.timer.unref();
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); await this.running; }
  async tick(): Promise<void> {
    const pending = this.store.select('deliveryOutbox', (rows) => (rows || []).filter((row) => row.status === 'PENDING' && (!row.nextAttemptAt || Date.parse(row.nextAttemptAt) <= Date.now())).slice(0, 20));
    for (const entry of pending) {
      this.store.assertWritable();
      const record = this.store.getSubmission(entry.submissionId);
      if (!record?.targetFolder || !['SUCCESS', 'PARTIAL_SUCCESS'].includes(record.status)) continue;
      let error: Error | undefined;
      try { await this.deliver(entry, record); } catch (caught) { error = caught as Error; }
      await this.store.updateSections(['deliveryOutbox'], (db) => {
        const row = db.deliveryOutbox!.find((item) => item.id === entry.id)!;
        row.attempts += 1;
        if (!error) { row.status = 'SENT'; row.lastError = undefined; row.nextAttemptAt = undefined; }
        else {
          row.lastError = error.message;
          row.nextAttemptAt = new Date(Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(row.attempts, 6))).toISOString();
        }
      });
    }
  }
}
