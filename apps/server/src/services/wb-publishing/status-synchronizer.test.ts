import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { WbRepository } from '../../repositories/wb.js';
import type { WbPublishingService } from './index.js';
import { WbTaskStatusSynchronizer } from './status-synchronizer.js';

function logger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger;
}

describe('WB task status synchronizer', () => {
  it('runs an immediate compensation pass when the service starts', async () => {
    const listActiveTaskReferences = vi.fn(async () => []);
    const repository = { configured: true, listActiveTaskReferences } as unknown as WbRepository;
    const flushPendingListingNotifications = vi.fn(async () => ({ delivered: 0, errors: [] }));
    const publishing = { n8n: { configured: true }, flushPendingListingNotifications } as unknown as WbPublishingService;
    const synchronizer = new WbTaskStatusSynchronizer(repository, publishing, logger(), { intervalMs: 60_000 });

    synchronizer.start();
    await vi.waitFor(() => expect(listActiveTaskReferences).toHaveBeenCalledTimes(1));
    expect(flushPendingListingNotifications).toHaveBeenCalledTimes(1);
    await synchronizer.stop();
  });

  it('reconciles queued and running tasks without requiring an open workbench', async () => {
    const repository = {
      configured: true,
      listActiveTaskReferences: vi.fn(async () => [
        { sku: '0000020', taskId: '0000020__r2', status: 'QUEUED' },
        { sku: '0000021', taskId: '0000021__r1', status: 'RUNNING' }
      ])
    } as unknown as WbRepository;
    const reconcileTaskStatus = vi.fn(async (sku: string) => sku === '0000020'
      ? { listing: { sku, status: 'SUCCEEDED' }, task: { state: 'SUCCEEDED' } }
      : { listing: { sku, status: 'RUNNING' }, task: { state: 'MEDIA_VERIFYING' } });
    const publishing = {
      n8n: { configured: true }, reconcileTaskStatus,
      flushPendingListingNotifications: vi.fn(async () => ({ delivered: 0, errors: [] }))
    } as unknown as WbPublishingService;
    const synchronizer = new WbTaskStatusSynchronizer(repository, publishing, logger());

    await expect(synchronizer.synchronizeNow()).resolves.toEqual({ checked: 2, completed: 1, pollErrors: 0 });
    expect(reconcileTaskStatus).toHaveBeenCalledTimes(2);
    expect(reconcileTaskStatus).toHaveBeenCalledWith('0000020');
    expect(reconcileTaskStatus).toHaveBeenCalledWith('0000021');
  });

  it('does not start a second reconciliation while the previous batch is running', async () => {
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const listActiveTaskReferences = vi.fn(async () => [{ sku: '0000020', taskId: '0000020__r2', status: 'QUEUED' as const }]);
    const repository = { configured: true, listActiveTaskReferences } as unknown as WbRepository;
    const reconcileTaskStatus = vi.fn(async () => {
      await waiting;
      return { listing: { sku: '0000020', status: 'RUNNING' } };
    });
    const publishing = {
      n8n: { configured: true }, reconcileTaskStatus,
      flushPendingListingNotifications: vi.fn(async () => ({ delivered: 0, errors: [] }))
    } as unknown as WbPublishingService;
    const synchronizer = new WbTaskStatusSynchronizer(repository, publishing, logger());

    const first = synchronizer.synchronizeNow();
    const second = synchronizer.synchronizeNow();
    await vi.waitFor(() => expect(reconcileTaskStatus).toHaveBeenCalledTimes(1));
    finish();
    await Promise.all([first, second]);
    expect(listActiveTaskReferences).toHaveBeenCalledTimes(1);
  });

  it('stays idle when PostgreSQL or the n8n bridge is unavailable', async () => {
    const listActiveTaskReferences = vi.fn();
    const repository = { configured: false, listActiveTaskReferences } as unknown as WbRepository;
    const publishing = { n8n: { configured: true } } as unknown as WbPublishingService;
    const synchronizer = new WbTaskStatusSynchronizer(repository, publishing, logger());

    await expect(synchronizer.synchronizeNow()).resolves.toEqual({ checked: 0, completed: 0, pollErrors: 0 });
    expect(listActiveTaskReferences).not.toHaveBeenCalled();
  });

  it('replays pending terminal notifications even when no active task or n8n bridge exists', async () => {
    const repository = {
      configured: true,
      listActiveTaskReferences: vi.fn(async () => [])
    } as unknown as WbRepository;
    const flushPendingListingNotifications = vi.fn(async () => ({ delivered: 1, errors: [] }));
    const publishing = {
      n8n: { configured: false }, flushPendingListingNotifications
    } as unknown as WbPublishingService;
    const synchronizer = new WbTaskStatusSynchronizer(repository, publishing, logger());

    await expect(synchronizer.synchronizeNow()).resolves.toEqual({ checked: 0, completed: 0, pollErrors: 0 });
    expect(flushPendingListingNotifications).toHaveBeenCalledTimes(1);
    expect(repository.listActiveTaskReferences).not.toHaveBeenCalled();
  });

  it('runs source-media cleanup compensation even when the n8n bridge is unavailable', async () => {
    const repository = { configured: true, listActiveTaskReferences: vi.fn() } as unknown as WbRepository;
    const publishing = {
      n8n: { configured: false },
      flushPendingListingNotifications: vi.fn(async () => ({ delivered: 0, errors: [] }))
    } as unknown as WbPublishingService;
    const runDue = vi.fn(async () => ({ checked: 1, waiting: 0, quarantined: 0, cleaned: 1, retried: 0, superseded: 0 }));
    const synchronizer = new WbTaskStatusSynchronizer(repository, publishing, logger(), {}, { runDue } as any);

    await expect(synchronizer.synchronizeNow()).resolves.toEqual({ checked: 0, completed: 0, pollErrors: 0 });
    expect(runDue).toHaveBeenCalledTimes(1);
    expect(repository.listActiveTaskReferences).not.toHaveBeenCalled();
  });
});
