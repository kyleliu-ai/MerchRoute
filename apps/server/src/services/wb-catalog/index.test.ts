import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@n8n-media-review/shared';
import type { WbCatalogOverview, WbCatalogRun } from '../../repositories/wb.js';
import { WbCatalogService, classifyCatalogError, nextMondayAtTen, shanghaiWeekKey } from './index.js';

const RUN: WbCatalogRun = {
  runId: '11111111-1111-4111-8111-111111111111', trigger: 'MANUAL', status: 'RUNNING',
  startedAt: '2026-07-15T00:00:00.000Z', processedParents: 0, totalParents: 0, processedSubjects: 0
};

const roots: string[] = [];
const colorDirectory = async (directory: string, input: { locale?: 'ru' | 'zh' } = {}) => {
  const zh = input.locale === 'zh';
  if (directory === 'countries') return [{ id: 15000170, name: zh ? '中国' : 'Китай', fullName: zh ? '' : 'Китайская Народная Республика' }];
  if (directory === 'seasons') return [zh ? '夏季' : 'лето'];
  if (directory === 'kinds') return [zh ? '女性' : 'Женский'];
  return zh ? [{ name: '黑色', parentName: '' }] : [{ name: 'черный', parentName: '' }];
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('WB local catalog service', () => {
  it('calculates the fixed Asia/Shanghai Monday 10:00 schedule and stable week key', () => {
    expect(nextMondayAtTen(new Date('2026-07-19T23:59:00.000Z')).toISOString()).toBe('2026-07-20T02:00:00.000Z');
    expect(nextMondayAtTen(new Date('2026-07-20T02:00:01.000Z')).toISOString()).toBe('2026-07-27T02:00:00.000Z');
    expect(shanghaiWeekKey(new Date('2026-07-20T02:00:00.000Z'))).toBe('2026-07-20');
  });

  it('does not run at Monday 09:59 and starts one scheduled run at 10:00', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-wb-catalog-schedule-'));
    roots.push(root);
    let current = new Date('2026-07-20T01:59:00.000Z');
    const timers: Array<{ callback: () => void; milliseconds: number }> = [];
    const repository = new FakeRepository({
      subjectCount: 10,
      parentCount: 2,
      colorCount: 1,
      dictionaryCounts: { countries: 1, seasons: 1, kinds: 1, colors: 1 },
      latestRun: { ...RUN, status: 'SUCCEEDED', completedAt: '2026-07-19T00:00:00.000Z' }
    });
    const service = new WbCatalogService(repository as any, { catalogConfigured: false } as any, root, logger(), {
      now: () => current,
      requestIntervalMs: 0,
      setTimer: (callback, milliseconds) => {
        timers.push({ callback, milliseconds });
        return { unref: vi.fn() } as any;
      },
      clearTimer: vi.fn()
    });

    await service.start();
    expect(repository.beginCalls).toEqual([]);
    expect(timers[0]?.milliseconds).toBe(60_000);

    current = new Date('2026-07-20T02:00:00.001Z');
    timers[0]!.callback();
    await vi.waitFor(() => expect(repository.beginCalls).toEqual(['SCHEDULED']));
    await service.stop();

    expect(repository.scheduleKeys).toEqual(['2026-07-20']);
    expect(timers[1]?.milliseconds).toBe(7 * 24 * 60 * 60 * 1_000 - 1);
  });

  it('classifies bridge, authentication, rate-limit and network failures without collapsing them to empty results', () => {
    expect(classifyCatalogError(new AppError('CONFIG_INVALID', '未配置 n8n WB 桥接地址或密钥', undefined, 503)).code).toBe('BRIDGE_NOT_CONFIGURED');
    expect(classifyCatalogError(new AppError('VERIFY_FAILED', 'HTTP 403', { httpStatus: 403 }, 502)).code).toBe('BRIDGE_NOT_CONFIGURED');
    expect(classifyCatalogError(new AppError('VERIFY_FAILED', 'n8n HTTP 502', { httpStatus: 502, response: { error: { httpStatus: 401 } } }, 502)).code).toBe('BRIDGE_NOT_CONFIGURED');
    expect(classifyCatalogError(new AppError('VERIFY_FAILED', 'n8n HTTP 401', { httpStatus: 401, response: { error: 'wb_auth_error', wbStatus: 401 } }, 502)).code).toBe('WB_AUTH_FAILED');
    expect(classifyCatalogError(new AppError('VERIFY_FAILED', 'HTTP 429', { httpStatus: 429, retryAfterMs: 1_200 }, 502))).toMatchObject({ code: 'WB_RATE_LIMITED', retryAfterMs: 1_200 });
    expect(classifyCatalogError(new AppError('VERIFY_FAILED', 'fetch failed', { deliveryUnknown: true }, 502)).code).toBe('WB_NETWORK_ERROR');
  });

  it('merges out-of-order ru/zh rows by ID, keeps ru authoritative and writes a bilingual v4 snapshot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-wb-catalog-'));
    roots.push(root);
    const repository = new FakeRepository();
    const n8n = {
      catalogConfigured: true,
      getDirectory: vi.fn(colorDirectory),
      getParentCategories: vi.fn(async (locale: 'ru' | 'zh') => locale === 'ru' ? { items: [
        { id: 2, name: 'Обувь', isVisible: true },
        { id: 1, name: 'Аксессуары', isVisible: true }
      ] } : { items: [
        { id: 99, name: '仅中文父类目', isVisible: true },
        { id: 1, name: '配饰', isVisible: false }
      ] }),
      searchSubjects: vi.fn(async ({ parentID, locale }: { parentID: number; locale: 'ru' | 'zh' }) => {
        if (parentID === 1 && locale === 'ru') return { data: [
          { subjectID: 8986, subjectName: 'Рюкзаки', parentID: 1, parentName: 'Аксессуары' },
          { subjectID: 50, subjectName: 'Сумки', parentID: 1, parentName: 'Аксессуары' }
        ] };
        if (parentID === 1 && locale === 'zh') return { data: [
          { subjectID: 50, subjectName: '手提包', parentID: 1, parentName: '配饰' },
          { subjectID: 8986, subjectName: '背包', parentID: 1 },
          { subjectID: 777, subjectName: '仅中文类目', parentID: 1, parentName: '配饰' }
        ] };
        if (parentID === 2 && locale === 'ru') return { data: [
          { subjectID: 105, subjectName: 'Кроссовки', parentID: 2, parentName: 'Обувь' }
        ] };
        return { data: [] };
      })
    };
    const service = new WbCatalogService(repository as any, n8n as any, root, logger(), { requestIntervalMs: 0 });
    await expect(service.triggerManual()).resolves.toEqual({ runId: RUN.runId, status: 'RUNNING', accepted: true });
    await service.stop();

    expect(n8n.getParentCategories).toHaveBeenCalledTimes(2);
    expect(n8n.getParentCategories.mock.calls.map(([locale]) => locale)).toEqual(['ru', 'zh']);
    expect(n8n.searchSubjects).toHaveBeenCalledTimes(4);
    expect(repository.completed).toMatchObject({
      parents: [
        { parentId: 1, nameRu: 'Аксессуары', nameZh: '配饰', isVisible: true },
        { parentId: 2, nameRu: 'Обувь', nameZh: '', isVisible: true }
      ],
      subjects: [
        { subjectId: 50, subjectNameRu: 'Сумки', subjectNameZh: '手提包', parentNameRu: 'Аксессуары', parentNameZh: '配饰' },
        { subjectId: 105, subjectNameRu: 'Кроссовки', subjectNameZh: '', parentNameRu: 'Обувь', parentNameZh: '' },
        { subjectId: 8986, subjectNameRu: 'Рюкзаки', subjectNameZh: '背包', parentNameRu: 'Аксессуары', parentNameZh: '' }
      ]
    });
    const snapshots = await readdir(path.join(root, 'wb-catalog', 'snapshots'));
    expect(snapshots).toHaveLength(1);
    const snapshot = JSON.parse(await readFile(path.join(root, 'wb-catalog', 'snapshots', snapshots[0]!), 'utf8'));
    expect(snapshot).toMatchObject({ schemaVersion: 4, locales: ['ru', 'zh'], runId: RUN.runId });
    expect(snapshot.dictionaries).toMatchObject({
      countries: [expect.objectContaining({ wbId: 15000170, nameRu: 'Китай', nameZh: '中国' })],
      seasons: [expect.objectContaining({ nameRu: 'лето', nameZh: '夏季' })],
      kinds: [expect.objectContaining({ nameRu: 'Женский', nameZh: '女性' })],
      colors: [expect.objectContaining({ nameRu: 'черный', nameZh: '黑色' })]
    });
    expect(snapshot.parents).toHaveLength(2);
    expect(snapshot.subjects).toHaveLength(3);
    expect(snapshot.subjects.find((item: any) => item.subjectId === 105)).toMatchObject({ subjectNameRu: 'Кроссовки', subjectNameZh: '' });
    expect(snapshot.parents.some((item: any) => item.parentId === 99)).toBe(false);
    expect(snapshot.subjects.some((item: any) => item.subjectId === 777)).toBe(false);
    expect(repository.failed).toBeUndefined();
  });

  it('accepts duplicate Chinese color translations while preserving distinct Russian color identities', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-wb-catalog-color-translation-'));
    roots.push(root);
    const repository = new FakeRepository();
    const n8n = {
      catalogConfigured: true,
      getDirectory: vi.fn(async (directory: string, input: { locale?: 'ru' | 'zh' } = {}) => directory === 'colors'
        ? input.locale === 'zh'
          ? [
              { name: '灰粉色', parentName: '粉红色' },
              { name: '灰粉色', parentName: '粉红色' }
            ]
          : [
              { name: 'серо-розовый', parentName: 'розовый' },
              { name: 'пыльно-розовый', parentName: 'розовый' }
            ]
        : colorDirectory(directory, input)),
      getParentCategories: vi.fn(async (locale: 'ru' | 'zh') => ({ items: [
        { id: 1, name: locale === 'zh' ? '配饰' : 'Аксессуары', isVisible: true }
      ] })),
      searchSubjects: vi.fn(async ({ locale }: { locale: 'ru' | 'zh' }) => ({ data: [
        {
          subjectID: 50,
          subjectName: locale === 'zh' ? '手提包' : 'Сумки',
          parentID: 1,
          parentName: locale === 'zh' ? '配饰' : 'Аксессуары'
        }
      ] }))
    };
    const service = new WbCatalogService(repository as any, n8n as any, root, logger(), { requestIntervalMs: 0 });

    await expect(service.triggerManual()).resolves.toEqual({ runId: RUN.runId, status: 'RUNNING', accepted: true });
    await service.stop();

    expect(repository.completed?.colors).toEqual([
      expect.objectContaining({ nameRu: 'серо-розовый', nameZh: '灰粉色' }),
      expect.objectContaining({ nameRu: 'пыльно-розовый', nameZh: '灰粉色' })
    ]);
    expect(repository.failed).toBeUndefined();
  });

  it('retries network/5xx up to three times, but never retries 401/403', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-wb-catalog-retry-'));
    roots.push(root);
    const repository = new FakeRepository();
    const getParents = vi.fn()
      .mockRejectedValueOnce(new AppError('VERIFY_FAILED', 'HTTP 500', { httpStatus: 500 }, 502))
      .mockRejectedValueOnce(new AppError('VERIFY_FAILED', 'network timeout', { deliveryUnknown: true }, 502))
      .mockRejectedValueOnce(new AppError('VERIFY_FAILED', 'HTTP 503', { httpStatus: 503 }, 502))
      .mockResolvedValue([{ id: 1, name: 'Аксессуары' }]);
    const service = new WbCatalogService(repository as any, {
      catalogConfigured: true,
      getDirectory: colorDirectory,
      getParentCategories: getParents,
      searchSubjects: vi.fn(async () => [{ subjectID: 1, subjectName: 'Рюкзаки', parentID: 1 }])
    } as any, root, logger(), { requestIntervalMs: 0, sleep: async () => undefined });
    await service.triggerManual();
    await service.stop();
    expect(getParents).toHaveBeenCalledTimes(5);
    expect(repository.completed).toBeDefined();

    const forbiddenRepository = new FakeRepository();
    const forbidden = vi.fn(async () => { throw new AppError('VERIFY_FAILED', 'HTTP 403', { httpStatus: 403 }, 502); });
    const forbiddenService = new WbCatalogService(forbiddenRepository as any, {
      catalogConfigured: true, getDirectory: colorDirectory, getParentCategories: forbidden, searchSubjects: vi.fn()
    } as any, root, logger(), { requestIntervalMs: 0, sleep: async () => undefined });
    await forbiddenService.triggerManual();
    await forbiddenService.stop();
    expect(forbidden).toHaveBeenCalledTimes(1);
    expect(forbiddenRepository.failed).toMatchObject({ code: 'BRIDGE_NOT_CONFIGURED' });
  });

  it('fails the whole run when any zh request fails and never replaces the previous catalog', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-wb-catalog-zh-failure-'));
    roots.push(root);
    const repository = new FakeRepository({ subjectCount: 25, parentCount: 3 });
    const getParentCategories = vi.fn(async (locale: 'ru' | 'zh') => {
      if (locale === 'zh') throw new AppError('VERIFY_FAILED', 'HTTP 503', { httpStatus: 503 }, 502);
      return [{ id: 1, name: 'Аксессуары' }];
    });
    const service = new WbCatalogService(repository as any, {
      catalogConfigured: true,
      getDirectory: colorDirectory,
      getParentCategories,
      searchSubjects: vi.fn()
    } as any, root, logger(), { requestIntervalMs: 0, sleep: async () => undefined });

    await service.triggerManual();
    await service.stop();

    expect(getParentCategories.mock.calls.map(([locale]) => locale)).toEqual(['ru', 'zh', 'zh', 'zh', 'zh']);
    expect(repository.completed).toBeUndefined();
    expect(repository.overview).toMatchObject({ subjectCount: 25, parentCount: 3 });
    expect(repository.failed).toMatchObject({ code: 'WB_NETWORK_ERROR' });
    expect((await readdir(path.join(root, 'wb-catalog', 'snapshots'))).filter((name) => name.endsWith('.json'))).toHaveLength(0);
  });

  it('rejects a successful but empty zh parent catalog', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-wb-catalog-empty-zh-parents-'));
    roots.push(root);
    const repository = new FakeRepository({ subjectCount: 25, parentCount: 3 });
    const searchSubjects = vi.fn();
    const service = new WbCatalogService(repository as any, {
      catalogConfigured: true,
      getDirectory: colorDirectory,
      getParentCategories: vi.fn(async (locale: 'ru' | 'zh') => locale === 'ru' ? [{ id: 1, name: 'Аксессуары' }] : []),
      searchSubjects
    } as any, root, logger(), { requestIntervalMs: 0 });

    await service.triggerManual();
    await service.stop();

    expect(searchSubjects).not.toHaveBeenCalled();
    expect(repository.completed).toBeUndefined();
    expect(repository.overview).toMatchObject({ subjectCount: 25, parentCount: 3 });
    expect(repository.failed).toMatchObject({ code: 'WB_SYNC_FAILED', message: expect.stringContaining('中文父类目') });
  });

  it('rejects a catalog when all zh subject pages are empty', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-wb-catalog-empty-zh-subjects-'));
    roots.push(root);
    const repository = new FakeRepository({ subjectCount: 25, parentCount: 3 });
    const service = new WbCatalogService(repository as any, {
      catalogConfigured: true,
      getDirectory: colorDirectory,
      getParentCategories: vi.fn(async (locale: 'ru' | 'zh') => [
        { id: 1, name: locale === 'ru' ? 'Аксессуары' : '配饰' }
      ]),
      searchSubjects: vi.fn(async ({ locale }: { locale: 'ru' | 'zh' }) => locale === 'ru'
        ? [{ subjectID: 8986, subjectName: 'Рюкзаки', parentID: 1, parentName: 'Аксессуары' }]
        : [])
    } as any, root, logger(), { requestIntervalMs: 0 });

    await service.triggerManual();
    await service.stop();

    expect(repository.completed).toBeUndefined();
    expect(repository.overview).toMatchObject({ subjectCount: 25, parentCount: 3 });
    expect(repository.failed).toMatchObject({ code: 'WB_SYNC_FAILED', message: expect.stringContaining('中文 subject') });
  });

  it('retries a 429 on the same page and honors Retry-After without advancing the offset', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-wb-catalog-rate-limit-'));
    roots.push(root);
    const repository = new FakeRepository();
    const sleep = vi.fn(async () => undefined);
    const searchSubjects = vi.fn()
      .mockRejectedValueOnce(new AppError('VERIFY_FAILED', 'HTTP 429', { httpStatus: 429, retryAfterMs: 1_200 }, 502))
      .mockResolvedValue([{ subjectID: 8986, subjectName: 'Рюкзаки', parentID: 1 }]);
    const service = new WbCatalogService(repository as any, {
      catalogConfigured: true,
      getDirectory: colorDirectory,
      getParentCategories: vi.fn(async () => [{ id: 1, name: 'Аксессуары' }]),
      searchSubjects
    } as any, root, logger(), { requestIntervalMs: 650, sleep });

    await service.triggerManual();
    await service.stop();

    expect(searchSubjects).toHaveBeenCalledTimes(3);
    expect(searchSubjects.mock.calls[0]).toEqual(searchSubjects.mock.calls[1]);
    expect(searchSubjects.mock.calls[0]?.[0]).toMatchObject({ parentID: 1, limit: 1_000, offset: 0 });
    expect(searchSubjects.mock.calls[2]?.[0]).toMatchObject({ parentID: 1, limit: 1_000, offset: 0, locale: 'zh' });
    expect(sleep).toHaveBeenCalledWith(1_200);
    expect(repository.completed).toBeDefined();
  });

  it('keeps the previous catalog unchanged when a later page exhausts its retries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-wb-catalog-page-failure-'));
    roots.push(root);
    const repository = new FakeRepository({ subjectCount: 1, parentCount: 1 });
    const firstPage = Array.from({ length: 1_000 }, (_, index) => ({
      subjectID: index + 1,
      subjectName: `Товар ${index + 1}`,
      parentID: 1
    }));
    const searchSubjects = vi.fn()
      .mockResolvedValueOnce(firstPage)
      .mockRejectedValue(new AppError('VERIFY_FAILED', 'HTTP 503', { httpStatus: 503 }, 502));
    const service = new WbCatalogService(repository as any, {
      catalogConfigured: true,
      getDirectory: colorDirectory,
      getParentCategories: vi.fn(async () => [{ id: 1, name: 'Каталог' }]),
      searchSubjects
    } as any, root, logger(), { requestIntervalMs: 0, sleep: async () => undefined });

    await service.triggerManual();
    await service.stop();

    expect(searchSubjects).toHaveBeenCalledTimes(5);
    expect(searchSubjects.mock.calls.slice(1).every((call) => call[0]?.offset === 1_000)).toBe(true);
    expect(repository.completed).toBeUndefined();
    expect(repository.overview).toMatchObject({ subjectCount: 1, parentCount: 1 });
    expect(repository.failed).toMatchObject({ code: 'WB_NETWORK_ERROR' });
    expect((await readdir(path.join(root, 'wb-catalog', 'snapshots'))).filter((name) => name.endsWith('.json'))).toHaveLength(0);
  });

  it('holds the cross-instance lock through the final 650 ms request cooldown', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-wb-catalog-cooldown-'));
    roots.push(root);
    let clock = 1_000;
    const requestTimes: number[] = [];
    const repository = new FakeRepository();
    repository.releaseClock = () => clock;
    const service = new WbCatalogService(repository as any, {
      catalogConfigured: true,
      getDirectory: vi.fn(async (_directory: string, input: { locale?: 'ru' | 'zh' }) => {
        requestTimes.push(clock);
        return colorDirectory(_directory, input);
      }),
      getParentCategories: vi.fn(async () => { requestTimes.push(clock); return [{ id: 1, name: 'Аксессуары' }]; }),
      searchSubjects: vi.fn(async () => { requestTimes.push(clock); return [{ subjectID: 8986, subjectName: 'Рюкзаки', parentID: 1 }]; })
    } as any, root, logger(), {
      now: () => new Date(clock),
      requestIntervalMs: 650,
      sleep: async (milliseconds) => { clock += milliseconds; }
    });

    await service.triggerManual();
    await service.stop();

    expect(requestTimes).toEqual(Array.from({ length: 12 }, (_, index) => 1_000 + index * 650));
    expect(repository.releasedAt).toBe(8_800);
  });

  it('starts recovery only for an empty catalog or a failed/abandoned run', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-wb-catalog-start-'));
    roots.push(root);
    const healthy = new FakeRepository({ subjectCount: 10, parentCount: 2, colorCount: 1, dictionaryCounts: { countries: 1, seasons: 1, kinds: 1, colors: 1 }, latestRun: { ...RUN, status: 'SUCCEEDED', completedAt: '2026-07-14T00:00:00.000Z' } });
    const service = new WbCatalogService(healthy as any, { catalogConfigured: false } as any, root, logger(), { requestIntervalMs: 0 });
    await service.start();
    await service.stop();
    expect(healthy.beginCalls).toEqual([]);

    const empty = new FakeRepository();
    const emptyService = new WbCatalogService(empty as any, { catalogConfigured: false } as any, root, logger(), { requestIntervalMs: 0 });
    await emptyService.start();
    await emptyService.stop();
    expect(empty.beginCalls).toEqual(['STARTUP']);
    expect(empty.failed).toMatchObject({ code: 'BRIDGE_NOT_CONFIGURED' });
    await expect(emptyService.search('рюкзак')).rejects.toMatchObject({ code: 'CATALOG_NOT_INITIALIZED', statusCode: 409 });
  });

  it('recovers an abandoned RUNNING row after acquiring the lock before a manual sync', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-wb-catalog-abandoned-'));
    roots.push(root);
    const abandoned = new FakeRepository({
      subjectCount: 10,
      parentCount: 2,
      currentRun: RUN,
      latestRun: RUN
    });
    const service = new WbCatalogService(
      abandoned as any,
      { catalogConfigured: false } as any,
      root,
      logger(),
      { requestIntervalMs: 0 }
    );

    await expect(service.triggerManual()).resolves.toEqual({ runId: RUN.runId, status: 'RUNNING', accepted: true });
    await service.stop();

    expect(abandoned.recoverCalls).toBe(1);
    expect(abandoned.beginCalls).toEqual(['MANUAL']);
    expect(abandoned.failed).toMatchObject({ code: 'BRIDGE_NOT_CONFIGURED' });
  });

  it('keeps only the seven newest successful snapshots and removes orphan JSON files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pixroute-wb-catalog-prune-'));
    roots.push(root);
    const snapshotsDirectory = path.join(root, 'wb-catalog', 'snapshots');
    await mkdir(snapshotsDirectory, { recursive: true });
    const files = Array.from({ length: 9 }, (_, index) => path.join(snapshotsDirectory, `snapshot-${index}.json`));
    await Promise.all(files.map((filePath) => writeFile(filePath, '{}', 'utf8')));
    const repository = new FakeRepository({ subjectCount: 10, parentCount: 2 });
    repository.successfulSnapshotPaths = files.slice(2);
    const service = new WbCatalogService(repository as any, { catalogConfigured: false } as any, root, logger(), { requestIntervalMs: 0 });

    await (service as any).pruneSnapshots();

    expect((await readdir(snapshotsDirectory)).sort()).toEqual(files.slice(2).map((filePath) => path.basename(filePath)).sort());
  });
});

class FakeRepository {
  configured = true;
  overview: WbCatalogOverview;
  completed?: { parents: unknown[]; subjects: unknown[]; colors: unknown[]; dictionaryValues: unknown[]; snapshotPath: string; sourceHash: string };
  failed?: { runId: string; code: string; message: string };
  beginCalls: string[] = [];
  scheduleKeys: Array<string | undefined> = [];
  recoverCalls = 0;
  successfulSnapshotPaths: string[] = [];
  releaseClock?: () => number;
  releasedAt?: number;
  private lockHeld = false;

  constructor(overview: Partial<WbCatalogOverview> = {}) {
    this.overview = {
      subjectCount: 0, parentCount: 0, colorCount: 0,
      dictionaryCounts: { countries: 0, seasons: 0, kinds: 0, colors: 0 },
      ...overview
    };
  }

  async acquireCatalogSyncLock() {
    if (this.lockHeld) return undefined;
    this.lockHeld = true;
    return { release: async () => { this.releasedAt = this.releaseClock?.(); this.lockHeld = false; } };
  }
  async recoverAbandonedCatalogRuns() {
    this.recoverCalls += 1;
    if (!this.overview.currentRun) return 0;
    const failedRun: WbCatalogRun = {
      ...this.overview.currentRun,
      status: 'FAILED',
      completedAt: new Date().toISOString()
    };
    this.overview = { ...this.overview, currentRun: undefined, latestRun: failedRun };
    return 1;
  }
  async catalogOverview() { return this.overview; }
  async beginCatalogRun(trigger: string, scheduleKey?: string) {
    this.beginCalls.push(trigger);
    this.scheduleKeys.push(scheduleKey);
    return { run: { ...RUN, trigger }, created: true };
  }
  async getRunningCatalogRun() { return this.overview.currentRun; }
  async updateCatalogRunProgress() { return undefined; }
  async completeCatalogRun(_runId: string, parents: unknown[], subjects: unknown[], colors: unknown[], dictionaryValues: unknown[], snapshotPath: string, sourceHash: string) {
    this.completed = { parents, subjects, colors, dictionaryValues, snapshotPath, sourceHash };
    this.successfulSnapshotPaths = [snapshotPath, ...this.successfulSnapshotPaths].slice(0, 7);
  }
  async failCatalogRun(runId: string, code: string, message: string) { this.failed = { runId, code, message }; }
  async listSuccessfulCatalogSnapshotPaths(limit = 7) { return this.successfulSnapshotPaths.slice(0, limit); }
  async searchCatalogSubjects() { return []; }
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}
