import { describe, expect, it, vi } from 'vitest';
import { notificationActionFor, WbAutoPublishRepository } from './wb-auto-publish.js';

describe('WB auto publish shared draft lock ordering', () => {
  it('transitions a cancelled store job before recomputing the shared SKU lock', async () => {
    const repository = new WbAutoPublishRepository();
    const order: string[] = [];
    vi.spyOn(repository, 'get').mockResolvedValue({ canCancel: true, state: 'WAITING_STABLE' } as any);
    vi.spyOn(repository, 'transition').mockImplementation(async () => {
      order.push('transition');
      return { state: 'CANCELLED' } as any;
    });
    vi.spyOn(repository, 'setListingLock').mockImplementation(async () => { order.push('lock'); });

    await expect(repository.cancel('0000110')).resolves.toMatchObject({ state: 'CANCELLED' });
    expect(order).toEqual(['transition', 'lock']);
  });

  it('recomputes each distinct shared SKU lock after bulk pausing instead of clearing drafts directly', async () => {
    const repository = new WbAutoPublishRepository();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [
        { id: 'job-1', store_id: 'store-1', sku: '0000110' },
        { id: 'job-2', store_id: 'store-2', sku: '0000110' },
        { id: 'job-3', store_id: 'store-3', sku: '0000111' }
      ] })
      .mockResolvedValue({ rows: [] });
    (repository as any).query = query;
    const setListingLock = vi.spyOn(repository, 'setListingLock').mockResolvedValue();

    await expect(repository.pauseUnsubmitted('预设停用')).resolves.toBe(3);
    expect(setListingLock.mock.calls).toEqual([['0000110', false], ['0000111', false]]);
    expect(query.mock.calls.some((call) => String(call[0]).includes('auto_publish_locked=false'))).toBe(false);
  });
});

describe('WB auto publish notification identity', () => {
  it('freezes job and store identity for new failures while retaining the historical default fallback payload', () => {
    const current = {
      id: '11111111-1111-4111-8111-111111111111',
      store_id: '22222222-2222-4222-8222-222222222222',
      sku: '0000110',
      created_at: '2026-08-10T10:30:00.000Z',
      run_id: '33333333-3333-4333-8333-333333333333',
      run_no: 1,
      operation_mode: 'CREATE_ONLY',
      notification_payload: {}
    };
    const emitted = notificationActionFor('NEEDS_ATTENTION', {
      errorCode: 'CONFIG_INVALID', errorMessage: '缺少字段'
    }, current);
    expect(emitted).toMatchObject({
      action: 'EMIT_FAILURE',
      payload: {
        failure: {
          jobId: current.id,
          storeId: current.store_id,
          sku: current.sku,
          runId: current.run_id
        }
      }
    });

    const historical = notificationActionFor('QUEUED', {}, {
      ...current,
      notification_payload: {
        failure: {
          sku: current.sku,
          jobCreatedAt: current.created_at,
          errorCode: 'CONFIG_INVALID',
          errorMessage: '旧 default 通知'
        }
      }
    });
    expect(historical).toMatchObject({
      action: 'RESOLVE_FAILURE',
      payload: { resolution: { sku: current.sku, jobCreatedAt: current.created_at } }
    });
    expect((historical!.payload.resolution as any).jobId).toBeUndefined();
    expect((historical!.payload.resolution as any).storeId).toBeUndefined();
  });
});
