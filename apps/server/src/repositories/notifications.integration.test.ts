import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PurchaseRepository } from './purchases.js';

const connectionString = process.env.DATABASE_URL;
const schema = `notifications_test_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let purchases: PurchaseRepository;

describe.runIf(Boolean(connectionString))('generic task notification PostgreSQL integration', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const isolatedUrl = new URL(connectionString!);
    isolatedUrl.searchParams.set('options', `-c search_path=${schema},public`);
    purchases = new PurchaseRepository(isolatedUrl.toString());
    await purchases.initialize();
  });

  afterAll(async () => {
    await purchases?.close();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('uses a stable dedupe key without resetting read or resolved state', async () => {
    const input = {
      dedupeKey: 'WB_PUBLISH_FAILED:task-17',
      category: 'WB_PUBLISHING',
      eventType: 'WB_PUBLISH_FAILED',
      severity: 'ERROR' as const,
      title: 'WB 上品失败 · 0000017',
      message: '视频上传失败',
      sourceType: 'WB_LISTING_TASK',
      sourceId: 'task-17',
      sku: '0000017',
      productName: '休闲运动鞋',
      workflowCode: 'WB-S001',
      details: { taskStatus: 'FAILED', errorCode: 'VIDEO_UPLOAD_FAILED' }
    };
    const created = await purchases.upsertNotification(input);
    expect(created).toMatchObject({
      category: 'WB_PUBLISHING', eventType: 'WB_PUBLISH_FAILED', severity: 'ERROR',
      sourceType: 'WB_LISTING_TASK', sourceId: 'task-17', sku: '0000017', readAt: null, resolvedAt: null
    });

    const read = await purchases.updateNotification(created.id, { read: true });
    const duplicate = await purchases.upsertNotification(input);
    expect(duplicate.id).toBe(created.id);
    expect(duplicate.readAt).toEqual(read.readAt);
    expect(duplicate.resolvedAt).toBeNull();
    expect(duplicate.updatedAt).toEqual(read.updatedAt);

    const refreshed = await purchases.upsertNotification({
      ...input,
      message: '视频上传失败，已停止自动推进',
      details: { taskStatus: 'NEEDS_ATTENTION', errorCode: 'VIDEO_UPLOAD_FAILED', attempt: 3 }
    });
    expect(refreshed.id).toBe(created.id);
    expect(refreshed.readAt).toEqual(read.readAt);
    expect(refreshed.message).toContain('停止自动推进');
    expect(refreshed.details).toEqual({ taskStatus: 'NEEDS_ATTENTION', errorCode: 'VIDEO_UPLOAD_FAILED', attempt: 3 });
    expect((await purchases.listNotifications({ category: 'WB_PUBLISHING', sourceType: 'WB_LISTING_TASK' })).total).toBe(1);
  });

  it('resolves failure threads by source and merges resolution details', async () => {
    await purchases.upsertNotification({
      dedupeKey: 'WB_PUBLISH_FAILED:task-18:media',
      category: 'WB_PUBLISHING', eventType: 'WB_PUBLISH_FAILED', severity: 'ERROR',
      title: 'WB 上品失败 · 0000018', message: '图片上传失败',
      sourceType: 'WB_LISTING_TASK', sourceId: 'task-18', sku: '0000018',
      details: { stage: 'MEDIA' }
    });
    await purchases.upsertNotification({
      dedupeKey: 'WB_PUBLISH_FAILED:task-18:price',
      category: 'WB_PUBLISHING', eventType: 'WB_PUBLISH_FAILED', severity: 'ERROR',
      title: 'WB 上品失败 · 0000018', message: '价格同步失败',
      sourceType: 'WB_LISTING_TASK', sourceId: 'task-18', sku: '0000018',
      details: { stage: 'PRICE' }
    });

    const resolved = await purchases.resolveNotifications({
      sourceType: 'WB_LISTING_TASK', sourceId: 'task-18', eventType: 'WB_PUBLISH_FAILED',
      details: { resolvedBy: 'WB_PUBLISH_SUCCEEDED', finalStatus: 'SUCCEEDED' }
    });
    expect(resolved.updated).toBe(2);
    expect(resolved.items).toHaveLength(2);
    for (const item of resolved.items) {
      expect(item.readAt).toBeTruthy();
      expect(item.resolvedAt).toBeTruthy();
      expect(item.details).toMatchObject({ resolvedBy: 'WB_PUBLISH_SUCCEEDED', finalStatus: 'SUCCEEDED' });
    }
    expect((await purchases.resolveNotifications({ sourceType: 'WB_LISTING_TASK', sourceId: 'task-18' })).updated).toBe(0);
  });

  it('does not allow one dedupe key to be reassigned to another source', async () => {
    await purchases.upsertNotification({
      dedupeKey: 'WB_PUBLISH_SUCCEEDED:task-19',
      category: 'WB_PUBLISHING', eventType: 'WB_PUBLISH_SUCCEEDED', severity: 'SUCCESS',
      title: 'WB 上品完成 · 0000019', message: '商品资料已全部同步到 WB',
      sourceType: 'WB_LISTING_TASK', sourceId: 'task-19', sku: '0000019', details: { nmIds: [1279538487] }
    });
    await expect(purchases.upsertNotification({
      dedupeKey: 'WB_PUBLISH_SUCCEEDED:task-19',
      category: 'WB_PUBLISHING', eventType: 'WB_PUBLISH_SUCCEEDED', severity: 'SUCCESS',
      title: '冲突通知', message: '不应覆盖原来源',
      sourceType: 'WB_AUTO_PUBLISH_JOB', sourceId: 'auto-19', sku: '0000019'
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });

    const stored = (await purchases.listNotifications({ eventType: 'WB_PUBLISH_SUCCEEDED' })).items[0]!;
    expect(stored).toMatchObject({ sourceType: 'WB_LISTING_TASK', sourceId: 'task-19', title: 'WB 上品完成 · 0000019' });
  });

  it('rejects malformed generic notification inputs', async () => {
    await expect(purchases.upsertNotification({
      dedupeKey: '', category: 'WB_PUBLISHING', eventType: 'WB_PUBLISH_FAILED', severity: 'ERROR',
      title: '失败', message: '失败', sourceType: 'WB_LISTING_TASK', sourceId: 'task-invalid'
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(purchases.upsertNotification({
      dedupeKey: 'bad-sku', category: 'WB_PUBLISHING', eventType: 'WB_PUBLISH_FAILED', severity: 'ERROR',
      title: '失败', message: '失败', sourceType: 'WB_LISTING_TASK', sourceId: 'task-invalid', sku: '17'
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(purchases.resolveNotifications({ sourceType: 'WB_LISTING_TASK' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });
});
