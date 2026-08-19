import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerWbRoutes } from './wb.js';

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('WB catalog HTTP contract', () => {
  it('returns status, 202 manual sync and local subject results with catalog metadata', async () => {
    const app = Fastify();
    apps.push(app);
    const catalog = {
      status: vi.fn(async () => ({ status: 'READY', subjectCount: 1, parentCount: 1, colorCount: 1, dictionaryCounts: { countries: 1, seasons: 1, kinds: 1, colors: 1 }, nextScheduledAt: '2026-07-20T02:00:00.000Z', isStale: false })),
      triggerManual: vi.fn(async () => ({ runId: '11111111-1111-4111-8111-111111111111', status: 'RUNNING', accepted: true })),
      search: vi.fn(async () => ({
        items: [{
          subjectId: 8986, subjectName: 'Рюкзаки', subjectNameRu: 'Рюкзаки', subjectNameZh: '背包',
          parentId: 1, parentName: 'Аксессуары', parentNameRu: 'Аксессуары', parentNameZh: '配饰', active: true
        }],
        catalog: { status: 'READY', subjectCount: 1, parentCount: 1, colorCount: 1, dictionaryCounts: { countries: 1, seasons: 1, kinds: 1, colors: 1 }, nextScheduledAt: '2026-07-20T02:00:00.000Z', isStale: false }
      })),
      colors: vi.fn(async () => ({ items: [{ colorKey: 'black', nameRu: 'черный', nameZh: '黑色', parentNameRu: 'черный', parentNameZh: '黑色' }] })),
      dictionary: vi.fn(async (directory: string) => ({ directory, items: [{ itemKey: '15000170', wbId: 15000170, nameRu: 'Китай', nameZh: '中国', fullNameRu: 'Китайская Народная Республика', fullNameZh: '' }] }))
    };
    await registerWbRoutes(app, { wb: {} as any, wbPublishing: {} as any, wbCatalog: catalog as any });

    const status = await app.inject({ method: 'GET', url: '/api/v1/wb/catalog/status' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ catalog: { status: 'READY', subjectCount: 1 } });

    const sync = await app.inject({ method: 'POST', url: '/api/v1/wb/catalog/sync' });
    expect(sync.statusCode).toBe(202);
    expect(sync.json()).toEqual({ runId: '11111111-1111-4111-8111-111111111111', status: 'RUNNING', accepted: true });

    const subjects = await app.inject({ method: 'GET', url: '/api/v1/wb/catalog/subjects?query=%D1%80%D1%8E%D0%BA%D0%B7%D0%B0%D0%BA&limit=30' });
    expect(subjects.statusCode).toBe(200);
    expect(subjects.json()).toMatchObject({ items: [{
      subjectId: 8986, subjectName: 'Рюкзаки', subjectNameRu: 'Рюкзаки', subjectNameZh: '背包',
      parentName: 'Аксессуары', parentNameRu: 'Аксессуары', parentNameZh: '配饰'
    }], catalog: { status: 'READY' } });
    expect(catalog.search).toHaveBeenCalledWith('рюкзак', 30);

    const chinese = await app.inject({ method: 'GET', url: '/api/v1/wb/catalog/subjects?query=%E8%83%8C%E5%8C%85&limit=10' });
    expect(chinese.statusCode).toBe(200);
    expect(chinese.json().items[0]).toMatchObject({ subjectName: 'Рюкзаки', subjectNameZh: '背包' });
    expect(catalog.search).toHaveBeenLastCalledWith('背包', 10);

    const colors = await app.inject({ method: 'GET', url: '/api/v1/wb/catalog/colors?query=%E9%BB%91%E8%89%B2&limit=50' });
    expect(colors.statusCode).toBe(200);
    expect(colors.json().items[0]).toMatchObject({ nameRu: 'черный', nameZh: '黑色' });
    expect(catalog.colors).toHaveBeenCalledWith('黑色', 50);

    const countries = await app.inject({ method: 'GET', url: '/api/v1/wb/catalog/dictionaries/countries?query=%E4%B8%AD%E5%9B%BD&limit=50' });
    expect(countries.statusCode).toBe(200);
    expect(countries.json().items[0]).toMatchObject({ wbId: 15000170, nameRu: 'Китай', nameZh: '中国' });
    expect(catalog.dictionary).toHaveBeenCalledWith('countries', '中国', 50);
  });

  it('forwards only supported schema locales and keeps ru as the default', async () => {
    const app = Fastify();
    apps.push(app);
    const getSubjectSchema = vi.fn(async (subjectId: number, locale: 'ru' | 'zh') => ({ subjectId, locale }));
    await registerWbRoutes(app, {
      wb: {} as any,
      wbPublishing: { n8n: { getSubjectSchema } } as any,
      wbCatalog: {} as any
    });

    const implicit = await app.inject({ method: 'GET', url: '/api/v1/wb/catalog/subjects/138/schema' });
    expect(implicit.statusCode).toBe(200);
    expect(implicit.json()).toEqual({ subjectId: 138, locale: 'ru' });

    const chinese = await app.inject({ method: 'GET', url: '/api/v1/wb/catalog/subjects/138/schema?locale=zh' });
    expect(chinese.statusCode).toBe(200);
    expect(chinese.json()).toEqual({ subjectId: 138, locale: 'zh' });

    const unsupported = await app.inject({ method: 'GET', url: '/api/v1/wb/catalog/subjects/138/schema?locale=en' });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json()).toMatchObject({ statusCode: 400, message: 'locale 仅支持 ru 或 zh' });
    expect(getSubjectSchema).toHaveBeenNthCalledWith(1, 138, 'ru');
    expect(getSubjectSchema).toHaveBeenNthCalledWith(2, 138, 'zh');
  });
});
