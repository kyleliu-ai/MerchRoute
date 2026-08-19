import { describe, expect, it } from 'vitest';
import {
  sameWbAutoPublishJob,
  summarizeWbAutoPublishCounts,
  wbAutoPublishStateMeta,
  wbAutoPublishJobKey,
  wbAutoPublishNoticePresentation,
  wbAutoPublishProductLinks
} from './wb-automation-utils';

describe('WB 自动任务多店铺身份', () => {
  it('同一 SKU 在不同店铺使用不同的稳定行键', () => {
    expect(wbAutoPublishJobKey({ storeId: 'store-a', sku: '0000110' })).toBe('store-a:0000110');
    expect(wbAutoPublishJobKey({ storeId: 'store-b', sku: '0000110' })).toBe('store-b:0000110');
  });

  it('详情选择必须同时匹配 storeId 和 SKU', () => {
    const selected = { storeId: 'store-b', sku: '0000110' };
    expect(sameWbAutoPublishJob({ storeId: 'store-a', sku: '0000110' }, selected)).toBe(false);
    expect(sameWbAutoPublishJob({ storeId: 'store-b', sku: '0000110' }, selected)).toBe(true);
  });
});

describe('WB 自动任务说明展示', () => {
  it('把同 SKU 生成轮次等待展示为正常等待而不是人工错误', () => {
    expect(wbAutoPublishStateMeta.WAITING_GENERATION_TURN).toEqual({
      label: '等待同 SKU 版本冻结',
      color: 'geekblue',
      group: 'waiting'
    });
    expect(summarizeWbAutoPublishCounts({ WAITING_GENERATION_TURN: 2, NEEDS_ATTENTION: 1 })).toEqual({
      waiting: 2,
      processing: 0,
      attention: 1,
      success: 0
    });
    expect(wbAutoPublishNoticePresentation('WAITING_GENERATION_TURN')).toEqual({
      tone: 'progress',
      alertType: 'info',
      codeLabel: '进度代码'
    });
  });

  it('价格传播中的 RUNNING 任务按进度展示', () => {
    expect(wbAutoPublishNoticePresentation('RUNNING')).toEqual({
      tone: 'progress',
      alertType: 'info',
      codeLabel: '进度代码'
    });
  });

  it.each(['NEEDS_ATTENTION', 'PAUSED', 'BLOCKED_EXISTING_CARD', 'FAILED'])(
    '%s 仍按错误展示',
    (state) => {
      expect(wbAutoPublishNoticePresentation(state)).toEqual({
        tone: 'error',
        alertType: 'warning',
        codeLabel: '错误代码'
      });
    }
  );
});

describe('WB 自动任务商品链接', () => {
  it('保留按 nmID 生成的变体代码映射并过滤重复或不安全链接', () => {
    expect(wbAutoPublishProductLinks({
      productLinks: [
        { nmId: '1421212413', url: 'https://www.wildberries.ru/catalog/1421212413/detail.aspx', variantCode: ' 0000138-01 ' },
        { nmId: '1421212413', url: 'https://www.wildberries.ru/catalog/1421212413/detail.aspx', variantCode: '错误重复项' },
        { nmId: '2', url: 'javascript:alert(1)', variantCode: '0000138-02' }
      ],
      productUrls: [
        'https://www.wildberries.ru/catalog/1421212413/detail.aspx',
        'https://www.wildberries.ru/catalog/1421212414/detail.aspx'
      ]
    })).toEqual([
      { nmId: '1421212413', url: 'https://www.wildberries.ru/catalog/1421212413/detail.aspx', variantCode: '0000138-01' },
      { nmId: '', url: 'https://www.wildberries.ru/catalog/1421212414/detail.aspx' }
    ]);
  });

  it('历史任务缺少变体代码映射时保留商品序号回退所需的链接顺序', () => {
    expect(wbAutoPublishProductLinks({
      productUrls: [
        'https://www.wildberries.ru/catalog/1279538487/detail.aspx',
        'https://www.wildberries.ru/catalog/1279538488/detail.aspx'
      ]
    })).toEqual([
      { nmId: '', url: 'https://www.wildberries.ru/catalog/1279538487/detail.aspx' },
      { nmId: '', url: 'https://www.wildberries.ru/catalog/1279538488/detail.aspx' }
    ]);
  });
});
