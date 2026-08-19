import { describe, expect, it } from 'vitest';
import type { OzonPublishJob } from '@n8n-media-review/shared';
import {
  ozonAutomaticStateMeta,
  ozonAutomaticTaskPrimaryState,
  ozonAutomaticTaskReason,
  ozonAutomaticTaskStatistics,
  ozonAutomaticTaskVersionMode
} from './ozon-automation-utils';

describe('OZON automatic state presentation', () => {
  it('uses the approved automatic-state labels for every persisted state', () => {
    expect(Object.fromEntries(Object.entries(ozonAutomaticStateMeta).map(([state, meta]) => [state, meta.label]))).toEqual({
      WAITING_MEDIA: '等待媒体', READY: '等待调度', UPLOADING_MEDIA: '上传媒体', SUBMITTING: '提交商品',
      IMPORTING: '导入受理', VERIFYING_IMAGES: '图片读回', UPDATING_PRICE: '价格生效',
      UPDATING_STOCK: '库存可售', MODERATING: '平台审核', SUCCEEDED: '已可售',
      NEEDS_ATTENTION: '需要处理', FAILED: '上品失败', CANCELLED: '已取消'
    });
  });

  it('keeps platform archive and not-for-sale outcomes authoritative', () => {
    expect(ozonAutomaticTaskPrimaryState({ state: 'NEEDS_ATTENTION', ozonProductLinks: [{ displayState: 'ARCHIVED' }] } as OzonPublishJob))
      .toEqual({ label: '商品已归档', color: 'default' });
    expect(ozonAutomaticTaskPrimaryState({ state: 'NEEDS_ATTENTION', ozonProductLinks: [{ displayState: 'NOT_FOR_SALE' }] } as OzonPublishJob))
      .toEqual({ label: '商品已下架', color: 'volcano' });
  });

  it('presents an active network recovery as normal OZON publishing progress', () => {
    expect(ozonAutomaticTaskPrimaryState({
      state: 'IMPORTING',
      payload: { networkRecovery: { status: 'WAITING_NETWORK' } },
      ozonProductLinks: []
    } as unknown as OzonPublishJob)).toEqual({ label: 'OZON上品中', color: 'processing' });
  });
});

describe('OZON automatic version and mode', () => {
  it('shows the frozen revision and per-store publication mode', () => {
    expect(ozonAutomaticTaskVersionMode({ revision: 2, payload: { mode: 'MULTISTORE_PUBLICATION' }, taskKind: 'STORE_PUBLICATION', publicationMode: 'CREATE_ONLY' }))
      .toEqual({ revisionLabel: 'R2', modeLabel: '自动创建' });
    expect(ozonAutomaticTaskVersionMode({ revision: 3, payload: { mode: 'MULTISTORE_PUBLICATION' }, taskKind: 'STORE_PUBLICATION', publicationMode: 'COMPATIBLE_UPSERT' }))
      .toEqual({ revisionLabel: 'R3', modeLabel: '兼容更新' });
  });

  it('falls back to the payload revision and a legacy automatic label', () => {
    expect(ozonAutomaticTaskVersionMode({ payload: { revision: 3 } }))
      .toEqual({ revisionLabel: 'R3', modeLabel: '迁移前任务' });
    expect(ozonAutomaticTaskVersionMode({ payload: {} }))
      .toEqual({ revisionLabel: 'R—', modeLabel: '迁移前任务' });
  });
});

describe('OZON automatic current reason', () => {
  it('explains the 0000128 waiting-media state', () => {
    expect(ozonAutomaticTaskReason({ state: 'WAITING_MEDIA', payload: {}, ozonProductLinks: [] }).text)
      .toBe('等待对应变体的 E005 图片和 E004 视频完成投递。');
  });

  it('uses reassuring list copy while preserving the next automatic check', () => {
    expect(ozonAutomaticTaskReason({
      state: 'UPDATING_STOCK',
      payload: { networkRecovery: {
        schemaVersion: 1,
        status: 'WAITING_NETWORK',
        phase: 'STOCK_WRITE',
        resumeState: 'UPDATING_STOCK',
        deliveryState: 'NOT_SENT',
        attempt: 1,
        firstFailureAt: '2026-08-13T07:58:00.000Z',
        lastFailureAt: '2026-08-13T07:59:00.000Z',
        errorCode: 'NETWORK_TIMEOUT',
        errorMessage: '网络中断，原 OZON 任务等待自动续跑。',
        nextAttemptAt: '2026-08-13T08:00:00.000Z'
      } },
      ozonProductLinks: []
    })).toEqual({
      text: '系统正在继续完成 OZON 上品，无需人工处理。',
      tone: 'processing',
      nextAttemptAt: '2026-08-13T08:00:00.000Z'
    });
  });

  it('uses actionable errors only for waiting and attention outcomes', () => {
    expect(ozonAutomaticTaskReason({ state: 'FAILED', payload: {}, lastErrorCode: 'OZON_IMPORT_FAILED', lastErrorMessage: '品牌参数错误', ozonProductLinks: [] }))
      .toMatchObject({ text: '品牌参数错误', detail: 'OZON_IMPORT_FAILED', tone: 'attention' });
    expect(ozonAutomaticTaskReason({ state: 'SUCCEEDED', payload: {}, lastErrorMessage: 'stale error', ozonProductLinks: [] }).text)
      .toBe('商品资料、媒体、价格与库存已完成同步。');
  });
});

describe('OZON automatic metrics', () => {
  it('separates waiting, processing, attention and success like the WB panel', () => {
    expect(ozonAutomaticTaskStatistics({
      WAITING_MEDIA: 2,
      READY: 1,
      UPLOADING_MEDIA: 1,
      SUBMITTING: 1,
      IMPORTING: 1,
      VERIFYING_IMAGES: 1,
      UPDATING_PRICE: 1,
      UPDATING_STOCK: 1,
      MODERATING: 1,
      NEEDS_ATTENTION: 3,
      FAILED: 2,
      SUCCEEDED: 8,
      CANCELLED: 4,
      ARCHIVED: 5,
      FUTURE_STATE: 99
    })).toEqual({ waiting: 2, processing: 8, needsAttention: 5, succeeded: 8 });
  });
});
