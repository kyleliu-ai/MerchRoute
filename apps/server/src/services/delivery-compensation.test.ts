import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { StateStore } from '../repositories/store.js';
import { DeliveryReplayService } from './delivery-replay.js';
import { DeliveryOutboxService } from './delivery-outbox.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { if (!path.basename(root).startsWith('merchroute-compensation-')) throw Error('unsafe cleanup'); await rm(root, { recursive: true, force: true }); } });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-compensation-')); roots.push(root);
  const store = new StateStore(root); await store.initialize();
  return { root, store };
}
const record = { submissionId: 'delivery', pendingSubmissionId: 'delivery', taskId: 'task', sourceStageId: 'E005', targetStageId: 'WB_SHARED_MEDIA', sourceFolder: '/fixture/source', targetFolder: '/fixture/target', selectedImageCount: 1, status: 'SUCCESS' as const, startedAt: '2026-01-01', productSku: '0000001' };
describe('durable compensation', () => {
  it('limits replay, resumes its cursor and retries unresolved identities without scanning completed ones', async () => {
    const f = await fixture();
    const records = Array.from({ length: 45 }, (_, i) => ({ ...record, submissionId: String(i).padStart(3, '0') }));
    const callback = vi.fn(async (row) => row.submissionId !== '000');
    await new DeliveryReplayService(f.store).run('WB', records, 'epoch', callback);
    expect(callback).toHaveBeenCalledTimes(20);
    const next = new StateStore(f.root); await next.initialize();
    callback.mockClear();
    await new DeliveryReplayService(next).run('WB', records, 'epoch', callback);
    expect(callback).toHaveBeenCalledTimes(20);
    expect(callback.mock.calls.map(([row]) => row.submissionId)).not.toContain('000');
    expect(next.section('reviewReplay')!.WB!.unresolved).toBeDefined();
    const last = vi.fn(async () => true);
    await new DeliveryReplayService(next).run('WB', records, 'epoch', last);
    expect(last).toHaveBeenCalledTimes(5);
  });
  it('pauses history while a review executes and preserves notification retries across restart', async () => {
    const f = await fixture();
    await f.store.update((db) => {
      db.reviewOperations!.push({ operationId: 'op', kind: 'APPROVE', requestKey: 'op', requestHash: 'hash', subjectKeys: [], input: {}, status: 'RUNNING', createdAt: '2026-01-01', updatedAt: '2026-01-01', attempt: 1 });
      db.submissionHistory.push(record);
      db.deliveryOutbox!.push({ id: 'delivery', submissionId: 'delivery', platform: 'WB', attempts: 0, status: 'PENDING', createdAt: '2026-01-01' });
    });
    const history = vi.fn(async () => true);
    await new DeliveryReplayService(f.store).run('WB', [record], 'epoch', history);
    expect(history).not.toHaveBeenCalled();
    const fail = vi.fn(async () => { throw Error('database temporarily unavailable'); });
    await new DeliveryOutboxService(f.store, pino({ enabled: false }), fail).tick();
    expect(f.store.section('deliveryOutbox')![0]).toMatchObject({ status: 'PENDING', attempts: 1 });
    await f.store.updateSections(['deliveryOutbox'], (db) => { db.deliveryOutbox![0]!.nextAttemptAt = '2000-01-01'; });
    const next = new StateStore(f.root); await next.initialize();
    const delivered = vi.fn(async () => undefined);
    const outbox = new DeliveryOutboxService(next, pino({ enabled: false }), delivered);
    await outbox.tick(); await outbox.tick();
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(next.section('deliveryOutbox')![0]!.status).toBe('SENT');
  });
});
