import { describe, expect, it } from 'vitest';
import type { WbListing, WbStorePublication } from './api/client';
import {
  isWbPublicationActive,
  summarizeWbPublications,
  wbManualListingDisplay,
  wbManualListingRows,
  wbPublicationProductLinks
} from './wb-publication-results-utils';

function publication(patch: Partial<WbStorePublication> = {}): WbStorePublication {
  return {
    id: 'publication-1',
    sku: '0000110',
    generatedVersionId: 'generated-1',
    revision: 1,
    storeId: 'store-1',
    storeAlias: 'main',
    storeDisplayName: '主店铺',
    status: 'RUNNING',
    source: 'MANUAL',
    planHash: `sha256:${'a'.repeat(64)}`,
    configSnapshot: { draftVersion: 3 },
    taskId: '0000110__main__r1',
    nmIds: [],
    productUrls: [],
    result: {},
    rowVersion: 1,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:01:00.000Z',
    ...patch
  };
}

function listing(patch: Partial<WbListing> = {}): WbListing {
  return {
    sku: '0000110', productName: '测试产品', status: 'GENERATED', draftVersion: 3,
    generatedVersionId: 'base-generated', brand: '', titleRu: '', descriptionRu: '', packaging: {},
    priceCny: 0, discountPercent: 0, videoUploadMode: 'COMPRESSED_COPY', compliance: {},
    sharedCharacteristics: [], variants: [], mediaAssets: [], variantMedia: [], nmIds: [], productUrls: [],
    ...patch
  };
}

describe('WB 店铺发布结果', () => {
  it('只对未结束状态继续轮询', () => {
    expect(isWbPublicationActive(publication({ status: 'QUEUED' }))).toBe(true);
    expect(isWbPublicationActive(publication({ status: 'SUCCEEDED' }))).toBe(false);
    expect(isWbPublicationActive(publication({ status: 'NEEDS_ATTENTION' }))).toBe(false);
  });

  it('按店铺记录聚合完成、处理中和需要处理的数量', () => {
    expect(summarizeWbPublications([
      publication({ status: 'SUCCEEDED' }),
      publication({ id: 'publication-2', storeId: 'store-2', status: 'RUNNING', taskId: 'task-2' }),
      publication({ id: 'publication-3', storeId: 'store-3', status: 'FAILED', taskId: 'task-3' })
    ])).toMatchObject({
      total: 3,
      succeeded: 1,
      active: 1,
      attention: 1,
      submitted: true,
      allSucceeded: false,
      taskCount: 3,
      detail: '1 家完成 · 1 家处理中 · 1 家需处理'
    });
  });

  it('用同一手动 planHash 的不同店铺修订投影清单完成状态和商品链接', () => {
    const planHash = `sha256:${'1'.repeat(64)}`;
    const projected = wbManualListingDisplay(listing(), [
      publication({ id: 'publication-r2', revision: 2, storeId: 'store-1', status: 'SUCCEEDED', planHash, nmIds: ['1403231023'], productUrls: ['https://www.wildberries.ru/catalog/1403231023/detail.aspx'] }),
      publication({ id: 'publication-r3', revision: 3, storeId: 'store-2', status: 'SUCCEEDED', planHash, nmIds: ['1403228865'], productUrls: ['https://www.wildberries.ru/catalog/1403228865/detail.aspx'] })
    ]);

    expect(projected).toMatchObject({
      status: 'SUCCEEDED',
      nmIds: ['1403231023', '1403228865'],
      productUrls: [
        'https://www.wildberries.ru/catalog/1403231023/detail.aspx',
        'https://www.wildberries.ru/catalog/1403228865/detail.aspx'
      ]
    });
  });

  it('当前批次存在时不混入公共草稿遗留的旧商品链接', () => {
    const projected = wbManualListingDisplay(listing({
      nmIds: ['1000000000'],
      productUrls: ['https://www.wildberries.ru/catalog/1000000000/detail.aspx']
    }), [publication({
      status: 'SUCCEEDED',
      nmIds: ['1403231023'],
      productUrls: ['https://www.wildberries.ru/catalog/1403231023/detail.aspx']
    })]);
    expect(projected.nmIds).toEqual(['1403231023']);
    expect(projected.productUrls).toEqual(['https://www.wildberries.ru/catalog/1403231023/detail.aspx']);
  });

  it('新批次缺少计划中的店铺记录时不误报全部完成', () => {
    const projected = wbManualListingDisplay(listing(), [publication({
      status: 'SUCCEEDED',
      configSnapshot: { draftVersion: 3, planStoreIds: ['store-1', 'store-2'] }
    })]);
    expect(projected.status).toBe('GENERATED');
  });

  it.each([
    [['SUCCEEDED', 'PAUSED'], 'NEEDS_ATTENTION'],
    [['SUCCEEDED', 'NEEDS_ATTENTION'], 'NEEDS_ATTENTION'],
    [['SUCCEEDED', 'FAILED'], 'FAILED'],
    [['SUCCEEDED', 'RUNNING'], 'RUNNING'],
    [['SUCCEEDED', 'QUEUED'], 'QUEUED'],
    [['SUCCEEDED', 'DISPATCHING'], 'SUBMITTING'],
    [['SUCCEEDED', 'PLANNED'], 'SUBMITTING']
  ] as const)('按最新批次状态 %j 投影为 %s', (statuses, expected) => {
    expect(wbManualListingDisplay(listing(), statuses.map((status, index) => publication({
      id: `publication-${index}`,
      storeId: `store-${index}`,
      status
    }))).status).toBe(expected);
  });

  it('只使用 createdAt 最新的当前手动批次，并忽略自动、旧草稿与无 planHash 记录', () => {
    const oldPlan = `sha256:${'2'.repeat(64)}`;
    const latestPlan = `sha256:${'3'.repeat(64)}`;
    const projected = wbManualListingDisplay(listing(), [
      publication({ id: 'old-failed', status: 'FAILED', planHash: oldPlan, createdAt: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' }),
      publication({ id: 'latest-success', status: 'SUCCEEDED', planHash: latestPlan, createdAt: '2026-08-10T00:00:00.000Z' }),
      publication({ id: 'automatic-failed', status: 'FAILED', source: 'AUTOMATION', planHash: latestPlan, createdAt: '2026-08-11T00:00:00.000Z' }),
      publication({ id: 'stale-draft-failed', status: 'FAILED', planHash: `sha256:${'4'.repeat(64)}`, configSnapshot: { draftVersion: 2 }, createdAt: '2026-08-12T00:00:00.000Z' }),
      publication({ id: 'legacy-no-plan-failed', status: 'FAILED', planHash: undefined, createdAt: '2026-08-13T00:00:00.000Z' })
    ]);
    expect(projected.status).toBe('SUCCEEDED');
  });

  it('兼容以基础 generatedVersionId 冻结的历史手动批次', () => {
    const historical = publication({
      status: 'SUCCEEDED',
      configSnapshot: { baseGeneratedVersionId: 'base-generated' }
    });
    expect(wbManualListingDisplay(listing(), [historical]).status).toBe('SUCCEEDED');
    expect(wbManualListingDisplay(listing({ status: 'STALE' }), [historical]).status).toBe('STALE');
  });

  it('把同一 SKU 最近一次手动批次展开为逐店两行，并隐藏没有 publication 的公共素材', () => {
    const rows = wbManualListingRows([
      listing(),
      listing({ sku: '0000120', draftVersion: 1 })
    ], [
      publication({ id: 'pub-r2', revision: 2, storeId: 'store-1', storeAlias: 'default', presetName: '49% 预设', draftVersion: 3 }),
      publication({ id: 'pub-r3', revision: 3, storeId: 'store-2', storeAlias: '250167882', presetName: '45% 预设', draftVersion: 3 })
    ]);

    expect(rows.map((row) => [row.key, row.publication.storeId, row.publication.presetName])).toEqual([
      ['pub-r2', 'store-1', '49% 预设'],
      ['pub-r3', 'store-2', '45% 预设']
    ]);
    expect(rows.every((row) => row.listing.sku === '0000110')).toBe(true);
  });

  it('公共素材更新后仍保留最近发布批次，并标记为上一次发布结果', () => {
    const oldPlanHash = `sha256:${'5'.repeat(64)}`;
    const latestPlanHash = `sha256:${'6'.repeat(64)}`;
    const rows = wbManualListingRows([listing({ draftVersion: 5 })], [
      publication({ id: 'older', planHash: oldPlanHash, draftVersion: 2, createdAt: '2026-08-09T00:00:00.000Z' }),
      publication({ id: 'latest-store-1', planHash: latestPlanHash, draftVersion: 3, createdAt: '2026-08-10T00:00:00.000Z' }),
      publication({ id: 'latest-store-2', storeId: 'store-2', planHash: latestPlanHash, draftVersion: 3, createdAt: '2026-08-10T00:00:00.000Z' })
    ]);

    expect(rows.map((row) => row.key)).toEqual(['latest-store-1', 'latest-store-2']);
    expect(rows.every((row) => row.publishedDraftVersion === 3 && row.currentDraftChanged)).toBe(true);
  });

  it('只信任 Wildberries HTTPS 商品链接，并为 nmID 生成安全兜底链接', () => {
    expect(wbPublicationProductLinks(publication({
      nmIds: [123, '456', 'invalid'],
      productUrls: [
        'https://www.wildberries.ru/catalog/123/detail.aspx',
        'https://example.com/catalog/456/detail.aspx',
        'javascript:alert(1)'
      ]
    }))).toEqual([
      { nmId: '123', url: 'https://www.wildberries.ru/catalog/123/detail.aspx' },
      { nmId: '456', url: 'https://www.wildberries.ru/catalog/456/detail.aspx' }
    ]);
  });

  it('按 nmID 关联变体代码，过滤非法和重复链接，并对模糊代码安全回退', () => {
    expect(wbPublicationProductLinks(publication({
      nmIds: ['200', '100'],
      productUrls: [
        'https://www.wildberries.ru/catalog/200/detail.aspx',
        'https://www.wildberries.ru/catalog/100/detail.aspx',
        'https://www.wildberries.ru/catalog/100/detail.aspx',
        'https://example.com/catalog/300/detail.aspx'
      ],
      productLinks: [
        { nmId: '100', url: 'https://www.wildberries.ru/catalog/100/detail.aspx', variantCode: '0000110-01' },
        { nmId: '200', url: 'https://www.wildberries.ru/catalog/200/detail.aspx', variantCode: '0000110-02' },
        { nmId: '200', url: 'https://www.wildberries.ru/catalog/200/detail.aspx', variantCode: '冲突代码' },
        { nmId: '999', url: 'https://www.wildberries.ru/catalog/400/detail.aspx', variantCode: '错误关联' }
      ]
    }))).toEqual([
      { nmId: '200', url: 'https://www.wildberries.ru/catalog/200/detail.aspx' },
      { nmId: '100', url: 'https://www.wildberries.ru/catalog/100/detail.aspx', variantCode: '0000110-01' }
    ]);
  });
});
