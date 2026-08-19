import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OzonCatalogService,
  flattenCategoryTree,
  mergeCategoryTrees,
  nextOzonCatalogRun,
  ozonCatalogWeekKey,
  prioritizeRequiredOzonAttributes,
  reconcileOzonAttributeOrder
} from './index.js';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OZON local category catalog', () => {
  it('moves required attributes first while preserving order inside both groups', () => {
    const attributes = [
      { id: 10, required: false },
      { id: 20, required: true },
      { id: 30, required: false },
      { id: 40, required: true }
    ];
    expect(prioritizeRequiredOzonAttributes(attributes).map((attribute) => attribute.id)).toEqual([20, 40, 10, 30]);
  });

  it('keeps saved order inside required and optional groups while merging refreshed attributes', () => {
    const attribute = (id: number, required: boolean) => ({ id, complexId: 0, required }) as any;
    const current = [attribute(40, true), attribute(20, true), attribute(30, false), attribute(10, false)];
    const latest = [attribute(10, false), attribute(20, true), attribute(30, false), attribute(40, true), attribute(50, true), attribute(60, false)];
    expect(reconcileOzonAttributeOrder(current, latest).map((item) => item.id)).toEqual([40, 20, 50, 30, 10, 60]);
  });

  it('calculates Monday 10:00 in Asia/Shanghai', () => {
    expect(nextOzonCatalogRun(new Date('2026-07-19T23:59:00.000Z')).toISOString()).toBe('2026-07-20T02:00:00.000Z');
    expect(nextOzonCatalogRun(new Date('2026-07-20T02:00:01.000Z')).toISOString()).toBe('2026-07-27T02:00:00.000Z');
    expect(ozonCatalogWeekKey(new Date('2026-07-20T02:00:00.000Z'))).toBe('2026-07-20');
  });

  it('flattens nested category trees and merges locales by category and type IDs', () => {
    const ru = flattenCategoryTree(tree('Одежда', 'Платья', 'Платье', false), 'RU');
    const zh = flattenCategoryTree(tree('服装', '连衣裙', '连衣裙', false), 'ZH_HANS');
    expect(ru).toEqual([expect.objectContaining({
      descriptionCategoryId: 17001,
      typeId: 97001,
      categoryName: 'Платья',
      typeName: 'Платье',
      path: ['Одежда', 'Платья', 'Платье']
    })]);
    expect(mergeCategoryTrees(ru, zh)).toEqual({
      chineseMissingCount: 0,
      entries: [expect.objectContaining({
        descriptionCategoryId: 17001,
        typeId: 97001,
        categoryNameZh: '连衣裙',
        typeNameZh: '连衣裙',
        displayPathZh: '服装 → 连衣裙 → 连衣裙'
      })]
    });
  });

  it('counts missing Chinese names and excludes disabled Russian leaves', () => {
    const ru = [
      ...flattenCategoryTree(tree('Одежда', 'Платья', 'Платье', false), 'RU'),
      ...flattenCategoryTree(tree('Обувь', 'Кроссовки', 'Кроссовки', true, 17002, 97002), 'RU')
    ];
    const merged = mergeCategoryTrees(ru, []);
    expect(merged.chineseMissingCount).toBe(1);
    expect(merged.entries).toHaveLength(1);
    expect(merged.entries[0]).toMatchObject({ descriptionCategoryId: 17001, categoryNameZh: '', typeNameZh: '' });
  });

  it('writes one bilingual snapshot and creates a template using only a local entry ID', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-catalog-'));
    roots.push(root);
    const repository = new FakeRepository();
    const source = {
      categoryTree: vi.fn(async (language: 'RU' | 'ZH_HANS') => language === 'RU'
        ? tree('Одежда', 'Платья', 'Платье', false)
        : tree('服装', '连衣裙', '连衣裙', false)),
      categorySchema: vi.fn(async (_categoryId: number, _typeId: number, language: 'RU' | 'ZH_HANS') => ({
        category: { attributes: [{ id: 10, name: language === 'RU' ? 'Бренд' : '品牌', required: true, type: 'String', dictionaryId: 0, maxCount: 1, groupId: 0, groupName: '', complexId: 0, isCollection: false }], dictionarySnapshot: {} }
      })),
      attributeValues: vi.fn(async (_categoryId: number, _typeId: number, attributeId: number, language: 'RU' | 'ZH_HANS') => ({
        result: {
          result: [{ id: attributeId + 1, value: language === 'RU' ? `RU-${attributeId}` : `中文-${attributeId}`, info: '' }],
          has_next: false
        }
      }))
    };
    const service = new OzonCatalogService(repository as any, root, logger(), { source });
    await service.triggerManual();
    await service.stop();

    expect(repository.completed?.entries).toEqual([expect.objectContaining({ categoryNameZh: '连衣裙', typeNameRu: 'Платье' })]);
    expect(repository.completed?.dictionaryValues).toEqual([
      expect.objectContaining({ directory: 'countries', attributeId: 4389, nameZh: '中文-4389', nameRu: 'RU-4389' }),
      expect.objectContaining({ directory: 'seasons', attributeId: 4495, nameZh: '中文-4495', nameRu: 'RU-4495' }),
      expect.objectContaining({ directory: 'kinds', attributeId: 9163, nameZh: '中文-9163', nameRu: 'RU-9163' }),
      expect.objectContaining({ directory: 'colors', attributeId: 10096, nameZh: '中文-10096', nameRu: 'RU-10096' })
    ]);
    expect((await readdir(path.join(root, 'ozon-catalog', 'snapshots'))).filter((name) => name.endsWith('.json'))).toHaveLength(1);
    await expect(service.createCategory('17001:97001')).resolves.toMatchObject({
      categoryKey: 'ozon_17001_97001',
      nameZh: '连衣裙',
      nameRu: 'Платье'
    });
    expect(repository.created).toMatchObject({
      categoryKey: 'ozon_17001_97001',
      descriptionCategoryId: 17001,
      typeId: 97001,
      attributes: [expect.objectContaining({ id: 10, name: 'Бренд', nameRu: 'Бренд', nameZh: '品牌', required: true })]
    });
  });

  it('accepts the real OZON attribute result array and preserves attribute_complex_id', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-attributes-'));
    roots.push(root);
    const repository = new FakeRepository();
    const service = new OzonCatalogService(repository as any, root, logger(), {
      source: {
        categoryTree: async () => ({ result: [] }),
        categorySchema: async (_categoryId, _typeId, language) => ({
          body: {
            result: [{
              id: 22273,
              attribute_complex_id: 100001,
              name: language === 'RU' ? 'Озон.Видео: товары на видео' : 'Ozon 视频：视频中的商品',
              description: '',
              type: 'String',
              is_required: true,
              is_collection: false,
              complex_is_collection: true,
              max_value_count: 1,
              group_name: '',
              group_id: 0,
              dictionary_id: 0
            }]
          }
        })
      }
    });

    await expect(service.createCategory('17001:97001')).resolves.toMatchObject({ categoryKey: 'ozon_17001_97001' });
    expect(repository.created).toMatchObject({
      attributes: [expect.objectContaining({
        id: 22273,
        complexId: 100001,
        nameRu: 'Озон.Видео: товары на видео',
        nameZh: 'Ozon 视频：视频中的商品',
        required: true
      })]
    });
  });

  it('keeps the previous catalog when the Chinese tree is empty', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-catalog-empty-'));
    roots.push(root);
    const repository = new FakeRepository();
    const service = new OzonCatalogService(repository as any, root, logger(), {
      source: {
        categoryTree: async (language) => language === 'RU' ? tree('Одежда', 'Платья', 'Платье', false) : { result: [] },
        categorySchema: async () => ({})
      }
    });
    await service.triggerManual();
    await service.stop();
    expect(repository.completed).toBeUndefined();
    expect(repository.failed).toMatchObject({ errorCode: 'OZON_SYNC_FAILED', errorMessage: expect.stringContaining('中文类目树为空') });
  });

  it('sends global catalog reads with only the default store identity and never a lease token', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-ozon-catalog-scope-'));
    roots.push(root);
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }));
    const service = new OzonCatalogService(new FakeRepository() as any, root, logger());
    const source = (service as any).source;

    await source.categoryTree('RU');
    await source.categorySchema(17001, 97001, 'ZH_HANS');
    await source.attributeValues(17001, 97001, 10096, 'RU', 0);

    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.storeId).toBe('00000000-0000-4000-8000-000000000002');
      expect(request).not.toHaveProperty('leaseToken');
      expect(request).not.toHaveProperty('taskId');
      expect(request).not.toHaveProperty('publicationId');
    }
    expect(requests.map((request) => request.action)).toEqual(['categoryTree', 'categorySchema', 'attributeValues']);
  });
});

function tree(rootName: string, categoryName: string, typeName: string, disabled: boolean, categoryId = 17001, typeId = 97001) {
  return { result: [{ category_name: rootName, children: [{
    description_category_id: categoryId,
    category_name: categoryName,
    children: [{ type_id: typeId, type_name: typeName, disabled, children: [] }]
  }] }] };
}

class FakeRepository {
  configured = true;
  completed?: { entries: any[]; dictionaryValues: any[] };
  failed?: { errorCode: string; errorMessage: string };
  created?: any;
  snapshotPath?: string;
  private run = {
    runId: '11111111-1111-4111-8111-111111111111', trigger: 'MANUAL', status: 'RUNNING',
    processedEntries: 0, totalEntries: 0, chineseMissingCount: 0,
    startedAt: '2026-07-27T00:00:00.000Z', heartbeatAt: '2026-07-27T00:00:00.000Z'
  } as const;

  async beginCatalogRun() { return { run: this.run, created: true }; }
  async getSettings() { return { adminApiWebhookUrl: 'http://n8n.test/webhook/ozon-admin' }; }
  async updateCatalogRunProgress() {}
  async completeCatalogRun(_runId: string, entries: any[], dictionaryValues: any[], snapshotPath: string) {
    this.completed = { entries, dictionaryValues };
    this.snapshotPath = snapshotPath;
  }
  async failCatalogRun(_runId: string, errorCode: string, errorMessage: string) { this.failed = { errorCode, errorMessage }; }
  async listSuccessfulCatalogSnapshotPaths() { return this.snapshotPath ? [this.snapshotPath] : []; }
  async getCatalogEntry() {
    return {
      catalogEntryId: '17001:97001', descriptionCategoryId: 17001, typeId: 97001,
      categoryNameZh: '连衣裙', typeNameZh: '连衣裙', categoryNameRu: 'Платья', typeNameRu: 'Платье',
      pathZh: ['服装', '连衣裙', '连衣裙'], pathRu: ['Одежда', 'Платья', 'Платье'],
      displayPathZh: '服装 → 连衣裙 → 连衣裙', displayPathRu: 'Одежда → Платья → Платье',
      active: true, missingSyncCount: 0, updatedAt: '2026-07-27T00:00:00.000Z'
    };
  }
  async searchCatalogDictionary() { return []; }
  async createCategory(input: any) { this.created = input; return { ...input, rowVersion: 1, createdAt: '', updatedAt: '' }; }
}

function logger() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as any;
}
