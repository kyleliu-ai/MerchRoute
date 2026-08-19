import { describe, expect, it } from 'vitest';
import {
  summarizeWbAutoPublishCounts,
  wbAutoPublishNoticePresentation,
  wbAutoPublishStateMeta
} from './wb-automation-utils';

describe('WB 自动上品状态展示', () => {
  it('把等待、处理中、需人工处理和成功状态聚合为页面统计', () => {
    expect(summarizeWbAutoPublishCounts({
      WAITING_MEDIA: 2,
      WAITING_STABLE: 1,
      WAITING_NETWORK: 4,
      CHECKING: 3,
      QUEUED: 2,
      NEEDS_ATTENTION: 4,
      BLOCKED_EXISTING_CARD: 1,
      SUCCEEDED: 8,
      CANCELLED: 9,
      FUTURE_STATE: 99
    })).toEqual({ waiting: 7, processing: 5, attention: 5, success: 8 });
  });

  it('为每个已知持久化状态提供可读中文标签', () => {
    expect(wbAutoPublishStateMeta.WAITING_MEDIA!.label).toBe('等待媒体');
    expect(wbAutoPublishStateMeta.WAITING_NETWORK!.label).toBe('等待网络恢复');
    expect(wbAutoPublishStateMeta.BLOCKED_EXISTING_CARD!.label).toBe('发现既有商品卡');
    expect(wbAutoPublishStateMeta.SUCCEEDED!.label).toBe('自动上品完成');
  });

  it('把 RUNNING 中的传播代码展示为进度而不是错误', () => {
    expect(wbAutoPublishNoticePresentation('RUNNING')).toEqual({
      tone: 'progress',
      alertType: 'info',
      codeLabel: '进度代码'
    });
  });

  it.each(['NEEDS_ATTENTION', 'PAUSED', 'BLOCKED_EXISTING_CARD', 'FAILED'])(
    '把 %s 的错误字段保留为需处理提示',
    (state) => {
      expect(wbAutoPublishNoticePresentation(state)).toEqual({
        tone: 'error',
        alertType: 'warning',
        codeLabel: '错误代码'
      });
    }
  );
});
