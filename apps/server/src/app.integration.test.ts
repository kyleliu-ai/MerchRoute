import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError, createDefaultConfig, workflowParameterFileName, workflowParameterOptionsFileName, type AppConfig } from '@n8n-media-review/shared';
import { buildApp } from './app.js';

describe.sequential('review and submission integration', () => {
  let root: string;
  let appData: string;
  let config: AppConfig;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const aboutVersion = {
    check: vi.fn(async (_options?: { refresh?: boolean }) => ({
      repositoryUrl: 'https://github.com/kyleliu-ai/MerchRoute',
      scopeVersion: 1,
      current: { productVersion: '0.1.0', configVersion: 'v003', commitSha: '7bfb072f548d75744305a2faa38f23722c4b81cf' },
      available: { source: 'main' as const, label: 'main', commitSha: '4d3e4705ad715b700f385c6fa0348644a4a625a9', url: 'https://github.com/kyleliu-ai/MerchRoute' },
      syncStatus: 'SYNCED' as const,
      runtimeStatus: 'CURRENT' as const,
      contentComparison: {
        runtime: { status: 'MATCH' as const, differenceCount: 0 },
        documentation: { status: 'DIFFERENT' as const, differenceCount: 2 },
        verification: { status: 'MATCH' as const, differenceCount: 0 }
      },
      historyComparison: { status: 'DIVERGED' as const, localOnlyCommits: 3, remoteOnlyCommits: 8 },
      checkedAt: '2026-08-31T10:00:00.000Z'
    }))
  };

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'n8n-review-v001-'));
    appData = path.join(root, 'app-data');
    config = fixtureConfig(root);
    await mkdir(appData, { recursive: true });
    await writeFile(path.join(appData, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await writeFile(path.join(appData, workflowParameterFileName('E006')), `${JSON.stringify({ preservedField: 'do-not-overwrite' }, null, 2)}\n`, 'utf8');
    await Promise.all(config.stages.flatMap((stage) => [stage.candidateRoot, stage.approvedArchiveRoot, stage.inputQueueRoot, stage.outputRoot, ...stage.targets.map((target) => target.targetQueueRoot)]).filter(Boolean).map((directory) => mkdir(directory!, { recursive: true })));
    await createProduct(config.stages[0]!.candidateRoot!, '测试产品A', ['main/image_01.png', 'detail/image_02.png']);
    await createProduct(config.stages[3]!.candidateRoot!, '测试套图A', ['scenePrompt01/image_01.png', 'scenePrompt02/image_02.png']);
    await writeTaskContext(config.stages[3]!.candidateRoot!, '测试套图A');
    process.env.APP_DATA_DIR = appData;
    app = await buildApp({ databaseUrl: null, aboutVersion });
    await app.services.mediaIndex.refreshAll();
  }, 30_000);

  it('serves the read-only MerchRoute version summary', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/about/version' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      current: { productVersion: '0.1.0', configVersion: 'v003' },
      available: { source: 'main', label: 'main' },
      syncStatus: 'SYNCED',
      runtimeStatus: 'CURRENT',
      scopeVersion: 1
    });
    expect(aboutVersion.check).toHaveBeenCalledWith({ refresh: false });

    const refreshed = await app.inject({ method: 'GET', url: '/api/v1/about/version?refresh=1' });
    expect(refreshed.statusCode).toBe(200);
    expect(aboutVersion.check).toHaveBeenLastCalledWith({ refresh: true });
  });

  afterAll(async () => {
    await app?.close();
    delete process.env.APP_DATA_DIR;
    await rm(root, { recursive: true, force: true });
  });

  it('scans nested images, saves and restores a draft', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/stages/E006/tasks' });
    expect(list.statusCode).toBe(200);
    const task = list.json().items[0];
    expect(task.sourceFolderName).toBe('测试产品A');
    expect(task.imageCount).toBe(2);
    const draft = await app.inject({ method: 'PUT', url: `/api/v1/tasks/${task.taskId}/draft`, payload: { selectedRelativePaths: ['main/image_01.png'] } });
    expect(draft.statusCode).toBe(200);
    const detail = await app.inject({ method: 'GET', url: `/api/v1/tasks/${task.taskId}` });
    expect(detail.json().selectedRelativePaths).toEqual(['main/image_01.png']);
  });

  it('serves repeated stage summaries from the fallback snapshot without rescanning the filesystem', async () => {
    const warm = await app.inject({ method: 'GET', url: '/api/v1/stages' });
    expect(warm.statusCode).toBe(200);
    const scanStage = vi.spyOn(app.services.scanner, 'scanStage');
    try {
      const first = await app.inject({ method: 'GET', url: '/api/v1/stages' });
      const second = await app.inject({ method: 'GET', url: '/api/v1/stages' });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(scanStage).not.toHaveBeenCalled();
      const stage = first.json().stages.find((item: { id: string }) => item.id === 'E006');
      expect(stage).toMatchObject({
        index: {
          stageId: 'E006',
          status: 'READY',
          queueCount: expect.any(Number),
          pendingReconciliations: expect.any(Number)
        }
      });
      expect(stage.summary.lastScannedAt).toEqual(expect.any(String));
    } finally {
      scanStage.mockRestore();
    }
  });

  it('accepts a global media-index reconciliation without blocking the response', async () => {
    const refreshAll = vi.spyOn(app.services.mediaIndex, 'refreshAll').mockResolvedValue(new Map());
    try {
      const response = await app.inject({ method: 'POST', url: '/api/v1/stages/rescan' });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ accepted: true, requestedAt: expect.any(String) });
      expect(refreshAll).toHaveBeenCalledOnce();
    } finally {
      refreshAll.mockRestore();
    }
  });

  it('keeps existing review endpoints available when PostgreSQL is not configured', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/purchases' });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('DATABASE_UNAVAILABLE');
  });

  it('classifies purchase URLs at the public POST and PATCH API boundary', async () => {
    const createPurchase = vi.spyOn(app.services.purchases, 'createPurchase').mockResolvedValue({ sku: '0000001' } as never);
    const updatePurchase = vi.spyOn(app.services.purchases, 'updatePurchase').mockResolvedValue({ sku: '0000001' } as never);
    const basePayload = { productName: '测试商品', purchasePrice: '10', providerUrl: '' };
    try {
      const inferred = await app.inject({
        method: 'POST',
        url: '/api/v1/purchases',
        payload: { ...basePayload, providerUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=123456789' }
      });
      expect(inferred.statusCode).toBe(200);
      expect(createPurchase).toHaveBeenCalledWith(expect.objectContaining({ downloadWorkflowCode: 'E006', retailPrice: null }));

      createPurchase.mockRejectedValueOnce(new AppError(
        'DOWNLOAD_WORKFLOW_UNAVAILABLE',
        '所选下载工作流不存在或已停用',
        { workflowCode: 'E006' },
        409
      ));
      const unavailable = await app.inject({
        method: 'POST',
        url: '/api/v1/purchases',
        payload: { ...basePayload, providerUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=123456790' }
      });
      expect(unavailable.statusCode).toBe(409);
      expect(unavailable.json().error).toMatchObject({
        code: 'DOWNLOAD_WORKFLOW_UNAVAILABLE',
        details: { workflowCode: 'E006' }
      });

      const normalized = await app.inject({
        method: 'PATCH',
        url: '/api/v1/purchases/0000001',
        payload: { ...basePayload, providerUrl: 'https://detail.1688.com/offer/987654321.html', downloadWorkflowCode: ' e007 ' }
      });
      expect(normalized.statusCode).toBe(200);
      expect(updatePurchase).toHaveBeenCalledWith('0000001', expect.objectContaining({ downloadWorkflowCode: 'E007', retailPrice: null }));

      const mismatch = await app.inject({
        method: 'POST',
        url: '/api/v1/purchases',
        payload: { ...basePayload, providerUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=123456789', downloadWorkflowCode: 'E007' }
      });
      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.json().error).toMatchObject({
        code: 'DOWNLOAD_WORKFLOW_URL_MISMATCH',
        details: {
          expectedWorkflowCode: 'E006',
          actualWorkflowCode: 'E007',
          platform: 'PDD',
          productId: '123456789'
        }
      });

      const unsupported = await app.inject({
        method: 'PATCH',
        url: '/api/v1/purchases/0000001',
        payload: { ...basePayload, providerUrl: 'https://example.com/product?id=123' }
      });
      expect(unsupported.statusCode).toBe(400);
      expect(unsupported.json().error).toMatchObject({ code: 'PRODUCT_URL_UNSUPPORTED', message: '无法下载' });
      expect(createPurchase).toHaveBeenCalledTimes(2);
      expect(updatePurchase).toHaveBeenCalledTimes(1);
    } finally {
      createPurchase.mockRestore();
      updatePurchase.mockRestore();
    }
  });

  it('refuses an implicit production DATABASE_URL while running under Vitest', async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://production-must-not-be-used.invalid/pixroute';
    try {
      await expect(buildApp()).rejects.toThrow('测试环境必须显式传入 databaseUrl');
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });

  it('系统设置拒绝把下载根目录保存到系统临时或测试目录', async () => {
    const currentResponse = await app.inject({ method: 'GET', url: '/api/v1/config' });
    const current = currentResponse.json().config;
    const unsafe = structuredClone(current);
    const e006 = unsafe.stages.find((stage: { id: string }) => stage.id === 'E006');
    e006.candidateRoot = path.join(os.tmpdir(), 'n8n-review-unsafe-settings', 'E006', 'candidate');
    const configured = vi.spyOn(app.services.purchases, 'configured', 'get').mockReturnValue(true);
    try {
      const response = await app.inject({ method: 'PUT', url: '/api/v1/config', payload: unsafe });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatchObject({
        code: 'DOWNLOAD_ROOT_UNSAFE',
        message: '图片保存地址不能使用系统临时目录或测试目录'
      });
      const unchanged = (await app.inject({ method: 'GET', url: '/api/v1/config' })).json().config;
      expect(unchanged.stages.find((stage: { id: string }) => stage.id === 'E006').candidateRoot)
        .toBe(current.stages.find((stage: { id: string }) => stage.id === 'E006').candidateRoot);
    } finally {
      configured.mockRestore();
    }
  });

  it('validates and forwards WB updated date ranges for manual and automatic lists', async () => {
    const listingSpy = vi.spyOn(app.services.wb, 'listListings').mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 30 });
    const automationSpy = vi.spyOn(app.services.wbAutoPublishing, 'list').mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 30 });
    try {
      const invalid = await app.inject({ method: 'GET', url: '/api/v1/wb/listings?updatedFrom=not-a-date' });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error).toMatchObject({ code: 'CONFIG_INVALID', message: '更新日期起始时间格式无效' });

      const reversed = await app.inject({
        method: 'GET',
        url: '/api/v1/wb/automation/jobs?updatedFrom=2026-07-22T16%3A00%3A00.000Z&updatedTo=2026-07-21T16%3A00%3A00.000Z'
      });
      expect(reversed.statusCode).toBe(400);
      expect(reversed.json().error).toMatchObject({ code: 'CONFIG_INVALID', message: '更新日期结束时间必须晚于起始时间' });

      const manual = await app.inject({ method: 'GET', url: '/api/v1/wb/listings?source=MANUAL&updatedFrom=2026-07-21T16%3A00%3A00Z' });
      expect(manual.statusCode).toBe(200);
      expect(listingSpy).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'MANUAL', updatedFrom: '2026-07-21T16:00:00.000Z', updatedTo: undefined }));

      const all = await app.inject({ method: 'GET', url: '/api/v1/wb/listings' });
      expect(all.statusCode).toBe(200);
      expect(listingSpy).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'ALL' }));

      const invalidSource = await app.inject({ method: 'GET', url: '/api/v1/wb/listings?source=OTHER' });
      expect(invalidSource.statusCode).toBe(400);
      expect(invalidSource.json().error).toMatchObject({ code: 'CONFIG_INVALID', message: 'source 仅支持 MANUAL、AUTOMATION 或 ALL' });

      const automatic = await app.inject({ method: 'GET', url: '/api/v1/wb/automation/jobs?updatedTo=2026-07-22T16%3A00%3A00Z' });
      expect(automatic.statusCode).toBe(200);
      expect(automationSpy).toHaveBeenLastCalledWith(expect.objectContaining({ updatedFrom: undefined, updatedTo: '2026-07-22T16:00:00.000Z' }));
    } finally {
      listingSpy.mockRestore();
      automationSpy.mockRestore();
    }
  });

  it('filters submission history by one exact seven-digit SKU without assigning legacy records', async () => {
    const previousHistory = structuredClone(app.services.store.read().submissionHistory);
    const startedAt = '2026-07-19T00:00:00.000Z';
    await app.services.store.update((db) => {
      db.submissionHistory = [
        { submissionId: 'history-sku-17', pendingSubmissionId: 'pending-17', taskId: 'task-17', sourceStageId: 'E006', targetStageId: 'E001', sourceFolder: '0000017运动鞋', selectedImageCount: 3, productSku: '0000017', productNameSnapshot: '运动鞋', status: 'SUCCESS', startedAt },
        { submissionId: 'history-sku-18', pendingSubmissionId: 'pending-18', taskId: 'task-18', sourceStageId: 'E006', targetStageId: 'E002', sourceFolder: '0000018休闲鞋', selectedImageCount: 2, productSku: '0000018', productNameSnapshot: '休闲鞋', status: 'FAILED', startedAt },
        { submissionId: 'history-legacy', pendingSubmissionId: 'pending-legacy', taskId: 'task-legacy', sourceStageId: 'E006', targetStageId: 'E001', sourceFolder: '旧记录目录', selectedImageCount: 1, status: 'SUCCESS', startedAt }
      ];
    });

    try {
      const all = await app.inject({ method: 'GET', url: '/api/v1/submissions/history' });
      expect(all.statusCode).toBe(200);
      expect(all.json().items.map((item: any) => item.submissionId)).toEqual(['history-sku-17', 'history-sku-18', 'history-legacy']);

      const exact = await app.inject({ method: 'GET', url: '/api/v1/submissions/history?sku=%200000017%20' });
      expect(exact.statusCode).toBe(200);
      expect(exact.json().items.map((item: any) => item.submissionId)).toEqual(['history-sku-17']);

      const combined = await app.inject({ method: 'GET', url: '/api/v1/submissions/history?sku=0000018&status=SUCCESS' });
      expect(combined.statusCode).toBe(200);
      expect(combined.json().items).toEqual([]);

      const missing = await app.inject({ method: 'GET', url: '/api/v1/submissions/history?sku=9999999' });
      expect(missing.statusCode).toBe(200);
      expect(missing.json().items).toEqual([]);

      const invalid = await app.inject({ method: 'GET', url: '/api/v1/submissions/history?sku=123' });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error).toMatchObject({ code: 'CONFIG_INVALID', message: 'SKU 必须是完整的 7 位数字' });
    } finally {
      await app.services.store.update((db) => { db.submissionHistory = previousHistory; });
    }
  });

  it('filters submission history by completed date with inclusive start and exclusive end', async () => {
    const previousHistory = structuredClone(app.services.store.read().submissionHistory);
    await app.services.store.update((db) => {
      db.submissionHistory = [
        { submissionId: 'history-completed-start', pendingSubmissionId: 'pending-start', taskId: 'task-start', sourceStageId: 'E006', targetStageId: 'E001', sourceFolder: '0000017边界开始', selectedImageCount: 1, productSku: '0000017', status: 'SUCCESS', startedAt: '2026-07-18T23:59:00.000Z', completedAt: '2026-07-19T00:00:00.000Z' },
        { submissionId: 'history-completed-middle', pendingSubmissionId: 'pending-middle', taskId: 'task-middle', sourceStageId: 'E006', targetStageId: 'E001', sourceFolder: '0000018范围中间', selectedImageCount: 1, productSku: '0000018', status: 'FAILED', startedAt: '2026-07-19T12:00:00.000Z', completedAt: '2026-07-19T12:01:00.000Z' },
        { submissionId: 'history-completed-end', pendingSubmissionId: 'pending-end', taskId: 'task-end', sourceStageId: 'E006', targetStageId: 'E001', sourceFolder: '0000017边界结束', selectedImageCount: 1, productSku: '0000017', status: 'SUCCESS', startedAt: '2026-07-19T23:59:00.000Z', completedAt: '2026-07-20T00:00:00.000Z' },
        { submissionId: 'history-without-completed-at', pendingSubmissionId: 'pending-legacy-date', taskId: 'task-legacy-date', sourceStageId: 'E006', targetStageId: 'E001', sourceFolder: '0000017旧记录', selectedImageCount: 1, productSku: '0000017', status: 'SUCCESS', startedAt: '2026-07-19T10:00:00.000Z' }
      ];
    });

    try {
      const all = await app.inject({ method: 'GET', url: '/api/v1/submissions/history' });
      expect(all.statusCode).toBe(200);
      expect(all.json().items).toHaveLength(4);

      const range = await app.inject({ method: 'GET', url: '/api/v1/submissions/history?completedFrom=2026-07-19T00%3A00%3A00.000Z&completedTo=2026-07-20T00%3A00%3A00.000Z' });
      expect(range.statusCode).toBe(200);
      expect(range.json().items.map((item: any) => item.submissionId)).toEqual(['history-completed-start', 'history-completed-middle']);

      const combined = await app.inject({ method: 'GET', url: '/api/v1/submissions/history?sku=0000017&completedFrom=2026-07-19T00%3A00%3A00.000Z&completedTo=2026-07-20T00%3A00%3A00.000Z' });
      expect(combined.statusCode).toBe(200);
      expect(combined.json().items.map((item: any) => item.submissionId)).toEqual(['history-completed-start']);

      const malformed = await app.inject({ method: 'GET', url: '/api/v1/submissions/history?completedFrom=not-a-date' });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().error).toMatchObject({ code: 'CONFIG_INVALID', message: '投递日期起始时间格式无效' });

      const reversed = await app.inject({ method: 'GET', url: '/api/v1/submissions/history?completedFrom=2026-07-20T00%3A00%3A00.000Z&completedTo=2026-07-19T00%3A00%3A00.000Z' });
      expect(reversed.statusCode).toBe(400);
      expect(reversed.json().error).toMatchObject({ code: 'CONFIG_INVALID', message: '投递日期结束时间必须晚于起始时间' });
    } finally {
      await app.services.store.update((db) => { db.submissionHistory = previousHistory; });
    }
  });

  it('blocks approval while PostgreSQL is offline, then installs an authoritative product fixture for packaging tests', async () => {
    const task = (await app.inject({ method: 'GET', url: '/api/v1/stages/E006/tasks' })).json().items[0];
    const detail = await app.inject({ method: 'GET', url: `/api/v1/tasks/${task.taskId}` });
    expect(detail.json().productIdentity.status).toBe('DATABASE_UNAVAILABLE');
    const blocked = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.taskId}/approve`, payload: { selectedRelativePaths: ['main/image_01.png'], targetStageIds: ['E001'] } });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json().error.code).toBe('DATABASE_UNAVAILABLE');

    const identity = { sku: '0000011', productName: '网面跑步鞋', variants: [{ variantId: '11111111-1111-4111-8111-111111111111', name: '默认变体' }] };
    vi.spyOn(app.services.productIdentity, 'resolveTask').mockResolvedValue({ status: 'RESOLVED', sku: identity.sku, productName: identity.productName, variants: ['默认变体'], source: 'USER_CONFIRMED' });
    vi.spyOn(app.services.productIdentity, 'requireResolvedTask').mockResolvedValue({ identity, source: 'USER_CONFIRMED' });
    vi.spyOn(app.services.productIdentity, 'requirePendingIdentity').mockResolvedValue(identity);
    vi.spyOn(app.services.purchases, 'ensureProductVariants').mockImplementation(async (_sku, names) => names.map((name) => normalizeTestVariant(name)));
    vi.spyOn(app.services.purchases, 'ensureColoredProductVariants').mockImplementation(async (_sku, inputs) => inputs.map((input) => ({ ...normalizeTestVariant(input.name), wbColor: input.wbColor, ...(input.ozonColor ? { ozonColor: input.ozonColor } : {}) })));
    vi.spyOn(app.services.wb, 'getCatalogColorByKey').mockImplementation(async (colorKey) => Object.values(TEST_COLORS).find((color) => color.colorKey === colorKey));
    vi.spyOn(app.services.ozonCatalog, 'dictionary').mockResolvedValue({
      directory: 'colors', dictionaryId: 1494,
      items: [
        { directory: 'colors', itemKey: 'colors:1494:11', attributeId: 10096, dictionaryId: 1494, valueId: 11, nameRu: 'Красный', nameZh: '红色' },
        { directory: 'colors', itemKey: 'colors:1494:12', attributeId: 10096, dictionaryId: 1494, valueId: 12, nameRu: 'Белый', nameZh: '白色' }
      ],
      catalog: { status: 'READY', entryCount: 1, chineseMissingCount: 0, dictionaryCounts: { countries: 1, seasons: 1, kinds: 1, colors: 2 }, nextScheduledAt: new Date().toISOString(), isStale: false }
    });
  });

  it('reports WB readiness separately without blocking existing configuration', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/config' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      config: { version: 'v003', wbPublishing: { enabled: false, rootDirectory: '' } },
      readiness: { complete: true },
      wbPublishingReadiness: { status: 'DISABLED', complete: false, enabled: false }
    });
  });

  it('validates the shipping contract before accessing PostgreSQL', async () => {
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/shipping/calculate', payload: { actualWeightGrams: '100', lengthCm: '10', widthCm: '10', heightCm: '10' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.message).toContain('运费模板');
    const valid = await app.inject({ method: 'POST', url: '/api/v1/shipping/calculate', payload: { platformCode: 'WB', templateType: 'WB', carrierCode: 'CEL', actualWeightGrams: '200', lengthCm: '10', widthCm: '10', heightCm: '10' } });
    expect(valid.statusCode).toBe(503);
    expect(valid.json().error.code).toBe('DATABASE_UNAVAILABLE');
  });

  it('在访问 PostgreSQL 前校验售价查询契约', async () => {
    const base = { pricingTemplateId: '11111111-1111-4111-8111-111111111111', shippingTemplateIds: ['22222222-2222-4222-8222-222222222222'], shippingServiceCodes: ['CEL_EXPRESS'] };
    const invalidSku = await app.inject({ method: 'POST', url: '/api/v1/pricing/query', payload: { ...base, lookup: { kind: 'SKU', sku: '123' } } });
    expect(invalidSku.statusCode).toBe(400);
    expect(invalidSku.json().error.message).toContain('7 位数字');
    const invalidName = await app.inject({ method: 'POST', url: '/api/v1/pricing/query', payload: { ...base, lookup: { kind: 'PRODUCT_NAME', productName: '   ' } } });
    expect(invalidName.statusCode).toBe(400);
    for (const payload of [
      { ...base, lookup: { kind: 'SKU', sku: '0000001' }, shippingTemplateIds: [] },
      { ...base, lookup: { kind: 'SKU', sku: '0000001' }, shippingTemplateIds: [...base.shippingTemplateIds, '33333333-3333-4333-8333-333333333333'] },
      { ...base, lookup: { kind: 'SKU', sku: '0000001' }, shippingServiceCodes: [] },
      { ...base, lookup: { kind: 'SKU', sku: '0000001' }, shippingServiceCodes: ['CEL_EXPRESS', 'CEL_EXPRESS'] }
    ]) expect((await app.inject({ method: 'POST', url: '/api/v1/pricing/query', payload })).statusCode).toBe(400);
    const valid = await app.inject({ method: 'POST', url: '/api/v1/pricing/query', payload: { ...base, lookup: { kind: 'SKU', sku: '0000001' } } });
    expect(valid.statusCode).toBe(503);
    expect(valid.json().error.code).toBe('DATABASE_UNAVAILABLE');
  });

  it('blocks traversal in image endpoints', async () => {
    const task = (await app.inject({ method: 'GET', url: '/api/v1/stages/E006/tasks' })).json().items[0];
    const response = await app.inject({ method: 'GET', url: `/api/v1/tasks/${task.taskId}/images/original?path=${encodeURIComponent('../secret.png')}` });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('PATH_TRAVERSAL_BLOCKED');
  });

  it('hides disabled stages from scanning and blocks reviews and deliveries until re-enabled', async () => {
    await createProduct(config.stages[0]!.candidateRoot!, '停用控制测试', ['main/image_01.png']);
    await app.services.mediaIndex.refreshStage(config.stages[0]!.id);
    const task = (await app.inject({ method: 'GET', url: '/api/v1/stages/E006/tasks' })).json().items.find((item: any) => item.sourceFolderName === '停用控制测试');
    const approved = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.taskId}/approve`, payload: { selectedRelativePaths: ['main/image_01.png'], targetStageIds: ['E001'] } });
    expect(approved.statusCode).toBe(200);
    const pendingId = approved.json().pendingSubmissions[0].id;
    const originalConfig = structuredClone(app.services.config.get());
    const disabledSource = structuredClone(originalConfig);
    disabledSource.stages.find((stage) => stage.id === 'E006')!.enabled = false;
    disabledSource.stages.find((stage) => stage.id === 'E007')!.download!.isDefault = true;
    expect((await app.inject({ method: 'PUT', url: '/api/v1/config', payload: disabledSource })).statusCode).toBe(200);

    const scanSpy = vi.spyOn(app.services.scanner, 'scanStage');
    const stages = await app.inject({ method: 'GET', url: '/api/v1/stages' });
    expect(stages.statusCode).toBe(200);
    expect(stages.json().stages.find((stage: any) => stage.id === 'E006')).toMatchObject({ enabled: false, summary: { pending: 0, drafts: 0, queue: 0, totalTasks: 0 } });
    expect(scanSpy.mock.calls.some(([stageId]) => stageId === 'E006')).toBe(false);
    scanSpy.mockRestore();
    const readiness = (await app.inject({ method: 'GET', url: '/api/v1/config' })).json().readiness;
    expect(readiness.paths.some((item: any) => item.path === originalConfig.stages[0]!.candidateRoot)).toBe(false);

    for (const response of [
      await app.inject({ method: 'GET', url: '/api/v1/stages/E006/tasks' }),
      await app.inject({ method: 'POST', url: '/api/v1/stages/E006/rescan' }),
      await app.inject({ method: 'GET', url: `/api/v1/tasks/${task.taskId}` }),
      await app.inject({ method: 'GET', url: `/api/v1/tasks/${task.taskId}/images/thumbnail?path=${encodeURIComponent('main/image_01.png')}` }),
      await app.inject({ method: 'PUT', url: `/api/v1/tasks/${task.taskId}/draft`, payload: { selectedRelativePaths: ['main/image_01.png'] } }),
      await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.taskId}/approve`, payload: { selectedRelativePaths: ['main/image_01.png'], targetStageIds: ['E001'] } })
    ]) {
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('STAGE_DISABLED');
    }
    const pendingWhileSourceDisabled = (await app.inject({ method: 'GET', url: '/api/v1/pending-submissions' })).json().items.find((item: any) => item.id === pendingId);
    expect(pendingWhileSourceDisabled).toMatchObject({ sourceStageEnabled: false, targetStageEnabled: true, disabledReason: '来源流程 E006 已停用' });
    const sourceBlockedBatch = await app.inject({ method: 'POST', url: '/api/v1/submissions/batch', payload: { batchId: 'BATCH-DISABLED-SOURCE', pendingSubmissionIds: [pendingId], conflictPolicy: 'skip' } });
    expect(sourceBlockedBatch.statusCode).toBe(409);
    expect(sourceBlockedBatch.json().error.code).toBe('STAGE_DISABLED');

    const disabledTarget = structuredClone(originalConfig);
    disabledTarget.stages.find((stage) => stage.id === 'E001')!.enabled = false;
    expect((await app.inject({ method: 'PUT', url: '/api/v1/config', payload: disabledTarget })).statusCode).toBe(200);
    await app.services.mediaIndex.refreshStage('E006');
    const targetBlockedApproval = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.taskId}/approve`, payload: { selectedRelativePaths: ['main/image_01.png'], targetStageIds: ['E001'] } });
    expect(targetBlockedApproval.statusCode).toBe(409);
    expect(targetBlockedApproval.json().error).toMatchObject({ code: 'STAGE_DISABLED', message: '目标流程 E001 已停用' });
    const pendingWhileTargetDisabled = (await app.inject({ method: 'GET', url: '/api/v1/pending-submissions' })).json().items.find((item: any) => item.id === pendingId);
    expect(pendingWhileTargetDisabled).toMatchObject({ sourceStageEnabled: true, targetStageEnabled: false, disabledReason: '目标流程 E001 已停用' });
    const targetBlockedBatch = await app.inject({ method: 'POST', url: '/api/v1/submissions/batch', payload: { batchId: 'BATCH-DISABLED-TARGET', pendingSubmissionIds: [pendingId], conflictPolicy: 'skip' } });
    expect(targetBlockedBatch.statusCode).toBe(409);

    expect((await app.inject({ method: 'PUT', url: '/api/v1/config', payload: originalConfig })).statusCode).toBe(200);
    const resumedBatch = await app.inject({ method: 'POST', url: '/api/v1/submissions/batch', payload: { batchId: 'BATCH-REENABLED', pendingSubmissionIds: [pendingId], conflictPolicy: 'skip' } });
    expect(resumedBatch.statusCode).toBe(200);
    expect(resumedBatch.json().results[0].status).toBe('SUCCESS');
    await rm(path.join(config.stages[0]!.candidateRoot!, '停用控制测试'), { recursive: true, force: true });
    await app.services.mediaIndex.refreshStage(config.stages[0]!.id);
  });

  it('allows a delivery already in PACKAGING to finish after its source stage is disabled', async () => {
    await createProduct(config.stages[0]!.candidateRoot!, '打包中停用测试', ['main/image_01.png']);
    await app.services.mediaIndex.refreshStage(config.stages[0]!.id);
    const task = (await app.inject({ method: 'GET', url: '/api/v1/stages/E006/tasks' })).json().items.find((item: any) => item.sourceFolderName === '打包中停用测试');
    const approved = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.taskId}/approve`, payload: { selectedRelativePaths: ['main/image_01.png'], targetStageIds: ['E001'] } });
    const pendingId = approved.json().pendingSubmissions[0].id;
    const submissionService = app.services.submissions as any;
    const originalPackageAndSubmit = submissionService.packageAndSubmit;
    let releasePackaging!: () => void;
    let signalPackaging!: () => void;
    const packagingPaused = new Promise<void>((resolve) => { signalPackaging = resolve; });
    const packagingGate = new Promise<void>((resolve) => { releasePackaging = resolve; });
    submissionService.packageAndSubmit = async (...args: any[]) => {
      signalPackaging();
      await packagingGate;
      return originalPackageAndSubmit.apply(submissionService, args);
    };

    const batchPromise = app.inject({ method: 'POST', url: '/api/v1/submissions/batch', payload: { batchId: 'BATCH-DISABLE-DURING-PACKAGING', pendingSubmissionIds: [pendingId], conflictPolicy: 'skip' } });
    await packagingPaused;
    expect(app.services.store.read().pendingSubmissions.find((item) => item.id === pendingId)?.status).toBe('PACKAGING');
    const disabledConfig = structuredClone(app.services.config.get());
    disabledConfig.stages.find((stage) => stage.id === 'E006')!.enabled = false;
    disabledConfig.stages.find((stage) => stage.id === 'E007')!.download!.isDefault = true;
    expect((await app.inject({ method: 'PUT', url: '/api/v1/config', payload: disabledConfig })).statusCode).toBe(200);
    releasePackaging();
    const completed = await batchPromise;
    expect(completed.statusCode).toBe(200);
    expect(completed.json().results[0].status).toBe('SUCCESS');

    submissionService.packageAndSubmit = originalPackageAndSubmit;
    const restoredConfig = structuredClone(app.services.config.get());
    restoredConfig.stages.find((stage) => stage.id === 'E006')!.enabled = true;
    restoredConfig.stages.find((stage) => stage.id === 'E007')!.download!.isDefault = false;
    expect((await app.inject({ method: 'PUT', url: '/api/v1/config', payload: restoredConfig })).statusCode).toBe(200);
    await rm(path.join(config.stages[0]!.candidateRoot!, '打包中停用测试'), { recursive: true, force: true });
    await app.services.mediaIndex.refreshStage(config.stages[0]!.id);
  });

  it('initializes, validates and atomically updates workflow parameter templates', async () => {
    const preserved = await app.inject({ method: 'GET', url: '/api/v1/workflow-parameters/E006' });
    expect(preserved.json().parameters).toEqual({ SKU: '', productName: '', preservedField: 'do-not-overwrite' });
    const e005 = await app.inject({ method: 'GET', url: '/api/v1/workflow-parameters/E005' });
    expect(e005.json().parameters).toEqual({
      SKU: '',
      productName: '',
      variants: '',
      outputParentDir: path.join(root, '02_GenerateFolder', 'E005-主图加-LOGO-输出'),
      maxSidePx: '768',
      logo: path.join(root, 'logo', 'tek+.png'),
      outputSuffix: '-logo'
    });
    expect(e005.json().parameterOptions).toEqual({});
    expect((await stat(path.join(appData, workflowParameterOptionsFileName('E005')))).isFile()).toBe(true);
    const typedParameters = { label: 'typed', retries: 3, enabled: true, extensions: ['.jpg', '.png'] };
    const typedOptions = { label: ['typed', 'quality'], retries: [3, 5] };
    const typedUpdate = await app.inject({ method: 'PUT', url: '/api/v1/workflow-parameters/E001', payload: { parameters: typedParameters, parameterOptions: typedOptions } });
    expect(typedUpdate.statusCode).toBe(200);
    expect(typedUpdate.json().parameters).toEqual({ SKU: '', productName: '', ...typedParameters });
    expect(typedUpdate.json().parameterOptions).toEqual(typedOptions);
    expect(JSON.parse(await readFile(path.join(appData, workflowParameterFileName('E001')), 'utf8'))).toEqual({ SKU: '', productName: '', ...typedParameters });
    expect(JSON.parse(await readFile(path.join(appData, workflowParameterOptionsFileName('E001')), 'utf8'))).toEqual(typedOptions);
    const duplicateOptions = await app.inject({ method: 'PUT', url: '/api/v1/workflow-parameters/E001', payload: { parameters: typedParameters, parameterOptions: { retries: [3, 3] } } });
    expect(duplicateOptions.statusCode).toBe(400);
    const unsupportedOptions = await app.inject({ method: 'PUT', url: '/api/v1/workflow-parameters/E001', payload: { parameters: typedParameters, parameterOptions: { enabled: [true, false] } } });
    expect(unsupportedOptions.statusCode).toBe(400);
    const wrongDefault = await app.inject({ method: 'PUT', url: '/api/v1/workflow-parameters/E001', payload: { parameters: typedParameters, parameterOptions: { retries: [5, 3] } } });
    expect(wrongDefault.statusCode).toBe(400);
    const update = await app.inject({ method: 'PUT', url: '/api/v1/workflow-parameters/E001', payload: { parameters: { model: 'default-model', blankValue: '' } } });
    expect(update.statusCode).toBe(200);
    expect(JSON.parse(await readFile(path.join(appData, workflowParameterFileName('E001')), 'utf8'))).toEqual({ SKU: '', productName: '', model: 'default-model', blankValue: '' });
    expect(JSON.parse(await readFile(path.join(appData, workflowParameterOptionsFileName('E001')), 'utf8'))).toEqual({});
    const invalid = await app.inject({ method: 'PUT', url: '/api/v1/workflow-parameters/E001', payload: { parameters: { objectValue: { nested: true } } } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('CONFIG_INVALID');
    const invalidNull = await app.inject({ method: 'PUT', url: '/api/v1/workflow-parameters/E001', payload: { parameters: { nullValue: null } } });
    expect(invalidNull.statusCode).toBe(400);
    const duplicate = await app.inject({ method: 'PUT', url: '/api/v1/workflow-parameters/E001', payload: { parameters: { ' model ': 'a', model: 'b' } } });
    expect(duplicate.statusCode).toBe(400);
    await rm(path.join(appData, workflowParameterFileName('E002')));
    const recovered = await app.inject({ method: 'GET', url: '/api/v1/workflow-parameters/E002' });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().parameters).toMatchObject({ SKU: '', productName: '' });
    expect((await stat(path.join(appData, workflowParameterFileName('E002')))).isFile()).toBe(true);
  });

  it('creates, updates and safely deletes a dynamic workflow configuration', async () => {
    const previousDownloadConfigSync = process.env.DOWNLOAD_CONFIG_SYNC;
    process.env.DOWNLOAD_CONFIG_SYNC = 'false';
    const stage = {
      id: 'E008', alias: '测试流程', groupId: 'generation', displayName: '动态测试流程', workflowName: 'E008-动态测试流程',
      description: '验证动态工作流生命周期', enabled: false, reviewEnabled: true, mediaTypes: ['image'], targets: []
    };
    try {
      const invalid = await app.inject({ method: 'POST', url: '/api/v1/workflows', payload: { stage: { ...stage, groupId: 'missing-group' } } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe('CONFIG_INVALID');
      const created = await app.inject({ method: 'POST', url: '/api/v1/workflows', payload: { stage, copyFromStageId: 'E006' } });
      expect(created.statusCode).toBe(200);
      expect(created.json().workflow).toMatchObject({ id: 'E008', alias: '测试流程' });
      const parameters = await app.inject({ method: 'GET', url: '/api/v1/workflow-parameters/E008' });
      expect(parameters.json().parameters).toEqual({ SKU: '', productName: '', preservedField: 'do-not-overwrite' });
      const blankStage = { ...stage, id: 'E009', alias: '空白流程', displayName: '空白动态流程', workflowName: 'E009-空白动态流程' };
      expect((await app.inject({ method: 'POST', url: '/api/v1/workflows', payload: { stage: blankStage } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/v1/workflow-parameters/E009' })).json().parameters).toEqual({ SKU: '', productName: '' });

      const updated = await app.inject({ method: 'PATCH', url: '/api/v1/workflows/E008', payload: { ...stage, alias: '已修改流程' } });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().workflow.alias).toBe('已修改流程');

      const blocked = await app.inject({ method: 'DELETE', url: '/api/v1/workflows/E001' });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error.message).toContain('投递目标');

      const deleted = await app.inject({ method: 'DELETE', url: '/api/v1/workflows/E008' });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json().config.stages.some((item: any) => item.id === 'E008')).toBe(false);
      const archives = await readdir(path.join(appData, 'workflow-archive'));
      expect(archives.some((name) => name.startsWith('E008-'))).toBe(true);
      expect((await app.inject({ method: 'DELETE', url: '/api/v1/workflows/E009' })).statusCode).toBe(200);
    } finally {
      if (previousDownloadConfigSync === undefined) delete process.env.DOWNLOAD_CONFIG_SYNC;
      else process.env.DOWNLOAD_CONFIG_SYNC = previousDownloadConfigSync;
    }
  });

  it('approves and atomically delivers an exact package without changing the source', async () => {
    const defaultParameters = { model: 'default-model', duration: 15 };
    const frozenOptions = { model: ['default-model', 'quality-model'], duration: [15, 30] };
    const templateUpdate = await app.inject({ method: 'PUT', url: '/api/v1/workflow-parameters/E001', payload: { parameters: defaultParameters, parameterOptions: frozenOptions } });
    expect(templateUpdate.statusCode).toBe(200);
    const task = (await app.inject({ method: 'GET', url: '/api/v1/stages/E006/tasks' })).json().items[0];
    const approve = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.taskId}/approve`, payload: { selectedRelativePaths: ['main/image_01.png', 'detail/image_02.png'], targetStageIds: ['E001'] } });
    expect(approve.statusCode).toBe(200);
    const pendingId = approve.json().pendingSubmissions[0].id;
    expect(approve.json().pendingSubmissions[0].n8nTaskParameters).toEqual({ SKU: '0000011', productName: '网面跑步鞋', ...defaultParameters });
    expect(approve.json().pendingSubmissions[0].n8nTaskParameterOptions).toEqual(frozenOptions);
    await app.inject({ method: 'PUT', url: '/api/v1/workflow-parameters/E001', payload: { parameters: { model: 'changed-after-approval', duration: 60 }, parameterOptions: { model: ['changed-after-approval', 'new-model'], duration: [60, 90] } } });
    const frozen = (await app.inject({ method: 'GET', url: '/api/v1/pending-submissions' })).json().items.find((item: any) => item.id === pendingId);
    expect(frozen.n8nTaskParameters).toEqual({ SKU: '0000011', productName: '网面跑步鞋', ...defaultParameters });
    expect(frozen.n8nTaskParameterOptions).toEqual(frozenOptions);
    const rejectedPatch = await app.inject({ method: 'PATCH', url: `/api/v1/pending-submissions/${pendingId}`, payload: { n8nTaskParameters: { model: 'outside-options', duration: 15 } } });
    expect(rejectedPatch.statusCode).toBe(400);
    const taskParameters = { model: 'quality-model', duration: 30 };
    const patch = await app.inject({ method: 'PATCH', url: `/api/v1/pending-submissions/${pendingId}`, payload: { n8nTaskParameters: { SKU: '9999999', productName: '客户端篡改', ...taskParameters }, n8nTaskParameterOptions: { SKU: ['9999999', '0000011'], ...frozenOptions } } });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().item.n8nTaskParameters).toMatchObject({ SKU: '0000011', productName: '网面跑步鞋' });
    const batch = await app.inject({ method: 'POST', url: '/api/v1/submissions/batch', payload: { batchId: 'BATCH-TEST-E006', pendingSubmissionIds: [pendingId], conflictPolicy: 'skip' } });
    expect(batch.statusCode).toBe(200);
    expect(batch.json().results[0].status).toBe('SUCCESS');
    const target = path.join(config.stages[0]!.targets[0]!.targetQueueRoot, '测试产品A-已经审核');
    const archive = path.join(config.stages[0]!.approvedArchiveRoot!, '测试产品A-已经审核');
    const ready = JSON.parse(await readFile(path.join(target, '_READY.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(path.join(target, 'selection-manifest.json'), 'utf8'));
    const submissionId = batch.json().results[0].submissionId;
    const parameterFileName = `n8n_setParameter_E001_${submissionId}.json`;
    expect(ready).toMatchObject({ ready: true, sourceStageId: 'E006', targetStageId: 'E001', imageCount: 2 });
    expect(ready.n8nParameterFileName).toBe(parameterFileName);
    expect(manifest.n8nParameterFileName).toBe(parameterFileName);
    expect(manifest.selectedFiles.map((file: any) => ({ sortOrder: file.sortOrder, sourceRelativePath: file.sourceRelativePath }))).toEqual([
      { sortOrder: 0, sourceRelativePath: 'main/image_01.png' },
      { sortOrder: 1, sourceRelativePath: 'detail/image_02.png' }
    ]);
    const isCompatibleArchive = (app.services.submissions as any).isCompatibleArchive.bind(app.services.submissions);
    expect(await isCompatibleArchive(target, task.taskId, ['main/image_01.png', 'detail/image_02.png'])).toBe(true);
    expect(await isCompatibleArchive(target, task.taskId, ['detail/image_02.png', 'main/image_01.png'])).toBe(false);
    const legacyArchive = path.join(root, 'legacy-compatible-archive');
    await mkdir(legacyArchive, { recursive: true });
    await writeFile(path.join(legacyArchive, '_READY.json'), JSON.stringify({ ready: true, taskId: task.taskId }));
    await writeFile(path.join(legacyArchive, 'selection-manifest.json'), JSON.stringify({ taskId: task.taskId, selectedFiles: manifest.selectedFiles.map(({ sortOrder: _sortOrder, ...file }: any) => file) }));
    expect(await isCompatibleArchive(legacyArchive, task.taskId, ['main/image_01.png', 'detail/image_02.png'])).toBe(true);
    expect(await isCompatibleArchive(legacyArchive, task.taskId, ['detail/image_02.png', 'main/image_01.png'])).toBe(false);
    expect(JSON.parse(await readFile(path.join(target, parameterFileName), 'utf8'))).toEqual({ SKU: '0000011', productName: '网面跑步鞋', ...taskParameters });
    expect(JSON.parse(await readFile(path.join(archive, parameterFileName), 'utf8'))).toEqual({ SKU: '0000011', productName: '网面跑步鞋', ...taskParameters });
    expect((await stat(path.join(archive, '_READY.json'))).isFile()).toBe(true);
    expect((await stat(path.join(config.stages[0]!.candidateRoot!, '测试产品A', 'main', 'image_01.png'))).isFile()).toBe(true);
    const historyItem = (await app.inject({ method: 'GET', url: `/api/v1/submissions/${submissionId}` })).json();
    expect(historyItem).toMatchObject({ productSku: '0000011', productNameSnapshot: '网面跑步鞋', n8nTaskParameters: { SKU: '0000011', productName: '网面跑步鞋', ...taskParameters }, n8nTaskParameterOptions: frozenOptions, n8nParameterFileName: parameterFileName });
  });

  it('creates R02 rather than overwriting an existing package', async () => {
    const task = (await app.inject({ method: 'GET', url: '/api/v1/stages/E006/tasks' })).json().items[0];
    const approve = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.taskId}/approve`, payload: { selectedRelativePaths: ['main/image_01.png'], targetStageIds: ['E001'] } });
    const pendingId = approve.json().pendingSubmissions[0].id;
    expect(approve.json().pendingSubmissions[0].conflictPolicy).toBe('new-revision');
    const batch = await app.inject({ method: 'POST', url: '/api/v1/submissions/batch', payload: { batchId: 'BATCH-TEST-R02', pendingSubmissionIds: [pendingId] } });
    expect(batch.json().results[0].status).toBe('SUCCESS');
    const revised = path.join(config.stages[0]!.targets[0]!.targetQueueRoot, '测试产品A-已经审核__R02');
    expect((await stat(path.join(revised, '_READY.json'))).isFile()).toBe(true);
  });

  it('skips an existing target without overwriting it and records the failure', async () => {
    const task = (await app.inject({ method: 'GET', url: '/api/v1/stages/E006/tasks' })).json().items[0];
    const approve = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.taskId}/approve`, payload: { selectedRelativePaths: ['main/image_01.png'], targetStageIds: ['E001'] } });
    const pendingId = approve.json().pendingSubmissions[0].id;
    const batch = await app.inject({ method: 'POST', url: '/api/v1/submissions/batch', payload: { batchId: 'BATCH-TEST-SKIP', pendingSubmissionIds: [pendingId], conflictPolicy: 'skip' } });
    expect(batch.json().results[0]).toMatchObject({ status: 'SKIPPED_CONFLICT', errorCode: 'TARGET_FOLDER_EXISTS' });
    const history = (await app.inject({ method: 'GET', url: '/api/v1/submissions/history' })).json().items;
    expect(history.some((item: any) => item.status === 'SKIPPED_CONFLICT' && item.errorCode === 'TARGET_FOLDER_EXISTS')).toBe(true);
  });

  it('allows over-limit E001 drafts but rejects approval until every variant has at most five unique images', async () => {
    const productName = '变体图片上限产品';
    const sourceRoot = config.stages[1]!.candidateRoot!;
    const files = [
      'shared/01.png',
      'red/01.png', 'red/02.png', 'red/03.png', 'red/04.png',
      'white/01.png', 'white/02.png', 'white/03.png', 'white/04.png',
      'extra/01.png'
    ];
    await createProduct(sourceRoot, productName, files);
    await app.services.mediaIndex.refreshStage(config.stages[1]!.id);
    const task = (await app.inject({ method: 'GET', url: '/api/v1/stages/E001/tasks' })).json().items.find((item: any) => item.sourceFolderName === productName);
    const overLimitPaths = files.slice(0, 6);
    const overLimitGroup = { groupId: 'group-over-limit', variantName: '', wbColor: TEST_COLORS.black, selectedRelativePaths: overLimitPaths };

    try {
      const draft = await app.inject({ method: 'PUT', url: `/api/v1/tasks/${task.taskId}/draft`, payload: { variantSelectionGroups: [overLimitGroup] } });
      expect(draft.statusCode).toBe(200);
      expect(draft.json().review.variantSelectionGroups[0].selectedRelativePaths).toHaveLength(6);

      const rejected = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.taskId}/approve`, payload: { variantSelectionGroups: [overLimitGroup], targetStageIds: ['E002'] } });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error).toMatchObject({
        code: 'CONFIG_INVALID',
        message: '产品变体“黑色”已选择 6 张图片，每个变体最多 5 张，请修改图片数量后再审核。',
        details: { groupId: 'group-over-limit', variantName: '黑色', selectedImageCount: 6, maxImageCount: 5 }
      });
      expect(app.services.store.read().pendingSubmissions.filter((item) => item.taskId === task.taskId)).toHaveLength(0);

      const redPaths = ['shared/01.png', 'shared/01.png', 'red/01.png', 'red/02.png', 'red/03.png', 'red/04.png'];
      const whitePaths = ['shared/01.png', 'white/01.png', 'white/02.png', 'white/03.png', 'white/04.png'];
      const approved = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${task.taskId}/approve`,
        payload: {
          variantSelectionGroups: [
            { groupId: 'group-limit-red', variantName: '', wbColor: TEST_COLORS.red, selectedRelativePaths: redPaths },
            { groupId: 'group-limit-white', variantName: '', wbColor: TEST_COLORS.white, selectedRelativePaths: whitePaths }
          ],
          targetStageIds: ['E002']
        }
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json().pendingSubmissions).toHaveLength(2);
      expect(approved.json().pendingSubmissions.map((item: any) => ({ variantName: item.variantName, selectedCount: item.selectedRelativePaths.length }))).toEqual([
        { variantName: '红色', selectedCount: 5 },
        { variantName: '白色', selectedCount: 5 }
      ]);
    } finally {
      await app.services.store.update((db) => {
        db.reviews = db.reviews.filter((item) => item.taskId !== task.taskId);
        db.pendingSubmissions = db.pendingSubmissions.filter((item) => item.taskId !== task.taskId);
      });
      await rm(path.join(sourceRoot, productName), { recursive: true, force: true });
    }
  });

  it('splits one E001 approval into variant-bound pending tasks and freezes variants as runtime parameters', async () => {
    await createProduct(config.stages[1]!.candidateRoot!, '多变体选图产品', ['shared/01.png', 'red/02.png', 'power/03.png']);
    await app.services.mediaIndex.refreshStage(config.stages[1]!.id);
    const task = (await app.inject({ method: 'GET', url: '/api/v1/stages/E001/tasks' })).json().items.find((item: any) => item.sourceFolderName === '多变体选图产品');
    const groups = [
      { groupId: 'group-red', variantName: '', wbColor: TEST_COLORS.red, selectedRelativePaths: ['shared/01.png', 'red/02.png'] },
      { groupId: 'group-white', variantName: '', wbColor: TEST_COLORS.white, selectedRelativePaths: ['shared/01.png', 'power/03.png'] }
    ];
    const response = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.taskId}/approve`, payload: { selectedRelativePaths: ['shared/01.png', 'red/02.png', 'power/03.png'], variantSelectionGroups: groups, targetStageIds: ['E002'] } });
    expect(response.statusCode).toBe(200);
    expect(response.json().pendingSubmissions).toHaveLength(2);
    expect(response.json().pendingSubmissions.map((item: any) => ({ groupId: item.variantGroupId, name: item.variantName, selected: item.selectedRelativePaths, parameter: item.n8nTaskParameters.variants }))).toEqual([
      { groupId: 'group-red', name: '红色', selected: ['shared/01.png', 'red/02.png'], parameter: '红色' },
      { groupId: 'group-white', name: '白色', selected: ['shared/01.png', 'power/03.png'], parameter: '白色' }
    ]);
    const savedGroups = app.services.store.read().reviews.find((item) => item.taskId === task.taskId)?.variantSelectionGroups || [];
    expect(savedGroups.map((group) => group.ozonColor)).toEqual([
      expect.objectContaining({ valueId: 11, nameZh: '红色', source: 'AUTO_EXACT_RU' }),
      expect.objectContaining({ valueId: 12, nameZh: '白色', source: 'AUTO_EXACT_RU' })
    ]);
    const pendingItems = response.json().pendingSubmissions;
    const batch = await app.inject({ method: 'POST', url: '/api/v1/submissions/batch', payload: { batchId: 'BATCH-TEST-E001-VARIANTS', pendingSubmissionIds: pendingItems.map((item: any) => item.id), conflictPolicy: 'new-revision' } });
    expect(batch.statusCode).toBe(200);
    expect(batch.json().results.map((item: any) => item.status)).toEqual(['SUCCESS', 'SUCCESS']);
    expect(batch.json().results.map((item: any) => item.errorCode)).toEqual([undefined, undefined]);
    const targetRoot = config.stages[1]!.targets[0]!.targetQueueRoot;
    const targetNames = ['多变体选图产品-已经审核', '多变体选图产品-已经审核__R02'];
    const packagedVariants = [];
    for (const [index, targetName] of targetNames.entries()) {
      const result = batch.json().results[index];
      const parameterFile = path.join(targetRoot, targetName, `n8n_setParameter_E002_${result.submissionId}.json`);
      packagedVariants.push(JSON.parse(await readFile(parameterFile, 'utf8')).variants);
    }
    expect(packagedVariants).toEqual(['红色', '白色']);
    const duplicate = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.taskId}/approve`, payload: { variantSelectionGroups: [groups[0], { ...groups[1], wbColor: TEST_COLORS.red }], targetStageIds: ['E002'] } });
    expect(duplicate.statusCode).toBe(400);
    await rm(path.join(config.stages[1]!.candidateRoot!, '多变体选图产品'), { recursive: true, force: true });
  });

  it('fails safely when a selected source file disappears before submission', async () => {
    await createProduct(config.stages[1]!.candidateRoot!, '待删除源文件', ['white/image_01.png']);
    await app.services.mediaIndex.refreshStage(config.stages[1]!.id);
    const task = (await app.inject({ method: 'GET', url: '/api/v1/stages/E001/tasks' })).json().items.find((item: any) => item.sourceFolderName === '待删除源文件');
    const approve = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.taskId}/approve`, payload: { ...e001Approval(['white/image_01.png']), targetStageIds: ['E002'] } });
    const pendingId = approve.json().pendingSubmissions[0].id;
    await rm(path.join(config.stages[1]!.candidateRoot!, '待删除源文件', 'white', 'image_01.png'));
    const batch = await app.inject({ method: 'POST', url: '/api/v1/submissions/batch', payload: { batchId: 'BATCH-TEST-MISSING', pendingSubmissionIds: [pendingId], conflictPolicy: 'skip' } });
    expect(batch.json().results[0]).toMatchObject({ status: 'FAILED', errorCode: 'SOURCE_FILE_MISSING' });
    expect(await stat(path.join(config.stages[1]!.targets[0]!.targetQueueRoot, '待删除源文件-已经审核')).catch(() => null)).toBeNull();
  });

  it('retries only the archive leg after a partial submission', async () => {
    await createProduct(config.stages[1]!.candidateRoot!, '归档失败产品', ['white/image_01.png']);
    await app.services.mediaIndex.refreshStage(config.stages[1]!.id);
    const occupiedArchive = path.join(config.stages[1]!.approvedArchiveRoot!, '归档失败产品-已经审核');
    await mkdir(occupiedArchive, { recursive: true });
    await writeFile(path.join(occupiedArchive, 'unrelated.txt'), 'occupied', 'utf8');
    const task = (await app.inject({ method: 'GET', url: '/api/v1/stages/E001/tasks' })).json().items.find((item: any) => item.sourceFolderName === '归档失败产品');
    const approve = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.taskId}/approve`, payload: { ...e001Approval(['white/image_01.png']), targetStageIds: ['E002'] } });
    const pendingId = approve.json().pendingSubmissions[0].id;
    const batch = await app.inject({ method: 'POST', url: '/api/v1/submissions/batch', payload: { batchId: 'BATCH-TEST-PARTIAL', pendingSubmissionIds: [pendingId], conflictPolicy: 'skip' } });
    expect(batch.json().results[0].status).toBe('PARTIAL_SUCCESS');
    const submissionId = batch.json().results[0].submissionId;
    const target = path.join(config.stages[1]!.targets[0]!.targetQueueRoot, '归档失败产品-已经审核');
    expect((await stat(path.join(target, '_READY.json'))).isFile()).toBe(true);
    await rm(occupiedArchive, { recursive: true, force: true });
    const retry = await app.inject({ method: 'POST', url: `/api/v1/submissions/${submissionId}/retry` });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ status: 'SUCCESS', retriedPart: 'archive' });
    expect((await stat(path.join(occupiedArchive, '_READY.json'))).isFile()).toBe(true);
  });

  it('supports flatten mode with deterministic collision-safe names', async () => {
    await createProduct(config.stages[2]!.candidateRoot!, '扁平化产品', ['angle01/image.png', 'angle02/image.png']);
    await app.services.mediaIndex.refreshStage(config.stages[2]!.id);
    await writeTaskContext(config.stages[2]!.candidateRoot!, '扁平化产品');
    config.stages[2]!.targets[0]!.packageMode = 'flatten';
    const update = await app.inject({ method: 'PUT', url: '/api/v1/config', payload: config });
    expect(update.statusCode).toBe(200);
    const task = (await app.inject({ method: 'GET', url: '/api/v1/stages/E002/tasks' })).json().items.find((item: any) => item.sourceFolderName === '扁平化产品');
    const approve = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.taskId}/approve`, payload: { selectedRelativePaths: ['angle01/image.png', 'angle02/image.png'], targetStageIds: ['E003'] } });
    const pendingId = approve.json().pendingSubmissions[0].id;
    const batch = await app.inject({ method: 'POST', url: '/api/v1/submissions/batch', payload: { batchId: 'BATCH-TEST-FLATTEN', pendingSubmissionIds: [pendingId], conflictPolicy: 'skip' } });
    expect(batch.json().results[0].status).toBe('SUCCESS');
    const target = path.join(config.stages[2]!.targets[0]!.targetQueueRoot, '扁平化产品-已经审核');
    expect((await stat(path.join(target, 'angle01__image.png'))).isFile()).toBe(true);
    expect((await stat(path.join(target, 'angle02__image.png'))).isFile()).toBe(true);
    const parameterFileName = `n8n_setParameter_E003_${batch.json().results[0].submissionId}.json`;
    expect((await stat(path.join(target, parameterFileName))).isFile()).toBe(true);
  });

  it('delivers E003 to E004 and E005 as independent records', async () => {
    const task = (await app.inject({ method: 'GET', url: '/api/v1/stages/E003/tasks' })).json().items[0];
    const selectedRelativePaths = ['scenePrompt02/image_02.png', 'scenePrompt01/image_01.png'];
    const approve = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.taskId}/approve`, payload: { selectedRelativePaths, targetStageIds: ['E004', 'E005'] } });
    const pendingItems = approve.json().pendingSubmissions;
    const e004Parameters = pendingItems.find((item: any) => item.targetStageId === 'E004').n8nTaskParameters;
    expect(e004Parameters).toMatchObject({ targetDuration: 15, enableLogo: true, allowedImageExtensions: ['.jpg', '.jpeg', '.png', '.webp'] });
    expect(pendingItems.find((item: any) => item.targetStageId === 'E005').n8nTaskParameters).toEqual({
      SKU: '0000011',
      productName: '网面跑步鞋',
      variants: '默认变体',
      outputParentDir: path.join(root, '02_GenerateFolder', 'E005-主图加-LOGO-输出'),
      maxSidePx: '768',
      logo: path.join(root, 'logo', 'tek+.png'),
      outputSuffix: '-logo'
    });
    const ids = pendingItems.map((item: any) => item.id);
    const batch = await app.inject({ method: 'POST', url: '/api/v1/submissions/batch', payload: { batchId: 'BATCH-TEST-E003', pendingSubmissionIds: ids, conflictPolicy: 'skip' } });
    expect(batch.json().results.map((item: any) => item.status)).toEqual(['SUCCESS', 'SUCCESS']);
    for (const target of config.stages[3]!.targets) {
      const destination = path.join(target.targetQueueRoot, '测试套图A-已经审核');
      const pending = pendingItems.find((item: any) => item.targetStageId === target.targetStageId);
      const result = batch.json().results.find((item: any) => item.pendingSubmissionId === pending.id);
      const parameterFileName = `n8n_setParameter_${target.targetStageId}_${result.submissionId}.json`;
      expect((await stat(path.join(destination, '_READY.json'))).isFile()).toBe(true);
      expect((await stat(path.join(destination, parameterFileName))).isFile()).toBe(true);
      const selectionManifest = JSON.parse(await readFile(path.join(destination, 'selection-manifest.json'), 'utf8'));
      expect(selectionManifest.selectedFiles.map((file: any) => ({ sortOrder: file.sortOrder, sourceRelativePath: file.sourceRelativePath }))).toEqual([
        { sortOrder: 0, sourceRelativePath: 'scenePrompt02/image_02.png' },
        { sortOrder: 1, sourceRelativePath: 'scenePrompt01/image_01.png' }
      ]);
      if (target.targetStageId === 'E004') {
        expect(JSON.parse(await readFile(path.join(destination, parameterFileName), 'utf8'))).toEqual(e004Parameters);
        expect(JSON.parse(await readFile(path.join(config.stages[3]!.approvedArchiveRoot!, '测试套图A-已经审核', parameterFileName), 'utf8'))).toEqual(e004Parameters);
      }
    }
    const history = (await app.inject({ method: 'GET', url: '/api/v1/submissions/history' })).json().items.filter((item: any) => item.taskId === task.taskId);
    expect(new Set(history.map((item: any) => item.targetStageId))).toEqual(new Set(['E004', 'E005']));
    expect(history.every((item: any) => JSON.stringify(item.selectedRelativePaths) === JSON.stringify(selectedRelativePaths))).toBe(true);
  });

  it('delivers approved E004/E005 media into the shared variant tree and writes an identifiable manifest', async () => {
    const linkedConfig = structuredClone(app.services.config.get());
    const wbRoot = path.join(root, 'wb-shared');
    const template = path.join(wbRoot, 'inbox', '<SKU>', 'variants');
    linkedConfig.stages.find((stage) => stage.id === 'E004')!.outputRoot = template;
    linkedConfig.stages.find((stage) => stage.id === 'E005')!.outputRoot = template;
    const saved = await app.inject({ method: 'PUT', url: '/api/v1/config', payload: linkedConfig });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().config.wbPublishing.rootDirectory).toBe(wbRoot);

    const e005Root = linkedConfig.stages.find((stage) => stage.id === 'E005')!.candidateRoot!;
    await createProduct(e005Root, '红色主图结果', ['01.png', '04.png', '07.png']);
    await writeFile(path.join(e005Root, '红色主图结果', 'selection-manifest.json'), JSON.stringify({
      schemaVersion: '1.0',
      sourceSubmissionId: 'SUB-E003-ORDER',
      selectedFiles: [
        { sortOrder: 0, sourceRelativePath: 'scene/07.png', targetRelativePath: '07.png' },
        { sortOrder: 1, sourceRelativePath: 'scene/01.png', targetRelativePath: '01.png' },
        { sortOrder: 2, sourceRelativePath: 'scene/04.png', targetRelativePath: '04.png' }
      ]
    }));
    await app.services.mediaIndex.refreshStage('E005');
    await writeFile(path.join(e005Root, '红色主图结果', 'n8n_setParameter_test.json'), JSON.stringify({ SKU: '0000011', productName: '网面跑步鞋', variants: '红色', sourceSubmissionId: 'SUB-E003-ORDER' }));
    const task = (await app.inject({ method: 'GET', url: '/api/v1/stages/E005/tasks' })).json().items.find((item: any) => item.sourceFolderName === '红色主图结果');
    const taskDetail = await app.services.scanner.getTask(task.taskId);
    expect(taskDetail.images.map((item) => item.relativePath)).toEqual(['07.png', '01.png', '04.png']);
    const response = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.taskId}/approve`, payload: { selectedRelativePaths: ['04.png', '07.png'], targetStageIds: [] } });
    expect(response.statusCode).toBe(200);
    expect(response.json().submission).toMatchObject({ sourceStageId: 'E005', targetStageId: 'WB_SHARED_MEDIA', variantName: '红色', deliveryType: 'WB_MEDIA', status: 'SUCCESS', sourceSubmissionId: 'SUB-E003-ORDER', selectedRelativePaths: ['07.png', '04.png'] });
    const submissionId = response.json().submission.submissionId;
    expect((await stat(path.join(wbRoot, 'inbox', '0000011', 'variants', '红色', 'images', submissionId, '07.png'))).isFile()).toBe(true);
    expect((await stat(path.join(wbRoot, 'inbox', '0000011', 'variants', '红色', 'images', submissionId, '04.png'))).isFile()).toBe(true);
    const manifest = JSON.parse(await readFile(path.join(wbRoot, 'inbox', '0000011', 'variants', 'variant-media-manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ schemaVersion: 2, SKU: '0000011', productName: '网面跑步鞋' });
    expect(manifest.assets.filter((asset: any) => asset.submissionId === submissionId).map((asset: any) => ({ sortOrder: asset.sortOrder, sourceSubmissionId: asset.sourceSubmissionId, relativePath: asset.relativePath }))).toEqual([
      { sortOrder: 0, sourceSubmissionId: 'SUB-E003-ORDER', relativePath: `variants/红色/images/${submissionId}/07.png` },
      { sortOrder: 1, sourceSubmissionId: 'SUB-E003-ORDER', relativePath: `variants/红色/images/${submissionId}/04.png` }
    ]);
    const idempotentRetry = await app.inject({ method: 'POST', url: `/api/v1/submissions/${submissionId}/retry` });
    expect(idempotentRetry.statusCode).toBe(200);
    expect(idempotentRetry.json().submissionId).toBe(submissionId);
    expect(JSON.parse(await readFile(path.join(wbRoot, 'inbox', '0000011', 'variants', 'variant-media-manifest.json'), 'utf8')).assets.filter((asset: any) => asset.submissionId === submissionId)).toHaveLength(2);

    const ozonRoot = path.join(root, 'ozon-shared');
    const ozonStage = structuredClone(app.services.config.get().stages.find((stage) => stage.id === 'E005')!);
    ozonStage.ozonOutputRoot = path.join(ozonRoot, 'inbox', '<SKU>', 'variants');
    const ozonVariantRoot = path.join(ozonRoot, 'inbox', '0000011', 'variants');
    await mkdir(ozonVariantRoot, { recursive: true });
    await writeFile(path.join(ozonVariantRoot, 'variant-media-manifest.json'), JSON.stringify({
      schemaVersion: 2,
      SKU: '0000011',
      productName: '网面跑步鞋',
      updatedAt: new Date().toISOString(),
      assets: [
        { assetId: 'legacy-01', submissionId: 'legacy-batch', sourceStageId: 'E005', sourceTaskId: 'legacy-task', variantId: 'legacy-variant', variantName: '红色', kind: 'image', relativePath: 'variants/红色/images/legacy/01.png', sizeBytes: 1, sha256: 'a'.repeat(64), deliveredAt: new Date().toISOString() },
        { assetId: 'legacy-02', submissionId: 'legacy-batch', sourceStageId: 'E005', sourceTaskId: 'legacy-task', variantId: 'legacy-variant', variantName: '红色', kind: 'image', relativePath: 'variants/红色/images/legacy/02.png', sizeBytes: 1, sha256: 'b'.repeat(64), deliveredAt: new Date().toISOString() }
      ]
    }));
    const ozonSubmission = await app.services.variantDelivery.deliver({
      platform: 'OZON',
      task: taskDetail,
      stage: ozonStage,
      selectedRelativePaths: ['04.png', '07.png'],
      productSku: '0000011',
      productName: '网面跑步鞋',
      variantId: '11111111-1111-4111-8111-111111111111',
      variantName: '红色',
      sourceSubmissionId: 'SUB-E003-ORDER',
      archiveMedia: false
    });
    expect(ozonSubmission).toMatchObject({ targetStageId: 'OZON_SHARED_MEDIA', deliveryType: 'OZON_MEDIA', status: 'SUCCESS' });
    expect((await stat(path.join(ozonRoot, 'inbox', '0000011', 'variants', '红色', 'images', ozonSubmission.submissionId, '04.png'))).isFile()).toBe(true);
    expect((await stat(path.join(ozonRoot, 'inbox', '0000011', 'variants', '红色', 'images', ozonSubmission.submissionId, '07.png'))).isFile()).toBe(true);
    const ozonManifest = JSON.parse(await readFile(path.join(ozonRoot, 'inbox', '0000011', 'variants', 'variant-media-manifest.json'), 'utf8'));
    expect(ozonManifest.assets.slice(0, 2).map((asset: any) => ({ assetId: asset.assetId, sortOrder: asset.sortOrder }))).toEqual([
      { assetId: 'legacy-01', sortOrder: undefined },
      { assetId: 'legacy-02', sortOrder: undefined }
    ]);
    expect(ozonManifest.assets.filter((asset: any) => asset.submissionId === ozonSubmission.submissionId).map((asset: any) => ({ sortOrder: asset.sortOrder, relativePath: asset.relativePath }))).toEqual([
      { sortOrder: 0, relativePath: `variants/红色/images/${ozonSubmission.submissionId}/04.png` },
      { sortOrder: 1, relativePath: `variants/红色/images/${ozonSubmission.submissionId}/07.png` }
    ]);
    expect(JSON.parse(await readFile(path.join(wbRoot, 'inbox', '0000011', 'variants', 'variant-media-manifest.json'), 'utf8')).assets).not.toContainEqual(expect.objectContaining({ submissionId: ozonSubmission.submissionId }));

    const invalidManifest = structuredClone(ozonManifest);
    delete invalidManifest.assets.find((asset: any) => asset.submissionId === ozonSubmission.submissionId && asset.sortOrder === 1).sortOrder;
    await writeFile(path.join(ozonVariantRoot, 'variant-media-manifest.json'), JSON.stringify(invalidManifest));
    await expect(app.services.variantDelivery.deliver({
      platform: 'OZON', task: taskDetail, stage: ozonStage, selectedRelativePaths: ['01.png'], productSku: '0000011', productName: '网面跑步鞋',
      variantId: '11111111-1111-4111-8111-111111111111', variantName: '红色', archiveMedia: false
    })).rejects.toMatchObject({ name: 'TerminalDeliveryError' });
  });

  it('rejects parameter edits while a pending item is packaging', async () => {
    await createProduct(config.stages[1]!.candidateRoot!, '参数锁定产品', ['white/image_01.png']);
    await app.services.mediaIndex.refreshStage(config.stages[1]!.id);
    const task = (await app.inject({ method: 'GET', url: '/api/v1/stages/E001/tasks' })).json().items.find((item: any) => item.sourceFolderName === '参数锁定产品');
    const approve = await app.inject({ method: 'POST', url: `/api/v1/tasks/${task.taskId}/approve`, payload: { ...e001Approval(['white/image_01.png']), targetStageIds: ['E002'] } });
    const pendingId = approve.json().pendingSubmissions[0].id;
    await app.services.store.update((db) => { db.pendingSubmissions.find((item) => item.id === pendingId)!.status = 'PACKAGING'; });
    const patch = await app.inject({ method: 'PATCH', url: `/api/v1/pending-submissions/${pendingId}`, payload: { n8nTaskParameters: { locked: 'no' } } });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().error.code).toBe('TASK_LOCKED');
  });

  it('backfills legacy pending records from the target workflow template on startup', async () => {
    const legacyRoot = await mkdtemp(path.join(os.tmpdir(), 'n8n-review-legacy-'));
    const legacyAppData = path.join(legacyRoot, 'app-data');
    await mkdir(legacyAppData, { recursive: true });
    await writeFile(path.join(legacyAppData, 'config.json'), `${JSON.stringify(fixtureConfig(legacyRoot), null, 2)}\n`, 'utf8');
    await writeFile(path.join(legacyAppData, 'db.json'), `${JSON.stringify({
      schemaVersion: '1.0', reviews: [], submissionHistory: [], submissionBatches: [], appEvents: [],
      pendingSubmissions: [{ id: 'legacy-pending', taskId: 'legacy-task', sourceStageId: 'E002', targetStageId: 'E003', selectedRelativePaths: ['image.png'], conflictPolicy: 'skip', status: 'PENDING', createdAt: '2026-07-11T00:00:00.000Z', updatedAt: '2026-07-11T00:00:00.000Z' }]
    }, null, 2)}\n`, 'utf8');
    process.env.APP_DATA_DIR = legacyAppData;
    const legacyApp = await buildApp({ databaseUrl: null });
    try {
      const pending = (await legacyApp.inject({ method: 'GET', url: '/api/v1/pending-submissions' })).json().items[0];
      expect(pending.n8nTaskParameters).toMatchObject({ SKU: '', productName: '' });
    } finally {
      await legacyApp.close();
      process.env.APP_DATA_DIR = appData;
      await rm(legacyRoot, { recursive: true, force: true });
    }
  });
});

function e001Approval(selectedRelativePaths: string[]) {
  return { selectedRelativePaths, variantSelectionGroups: [{ groupId: `group-${selectedRelativePaths.join('-')}`, variantName: '', wbColor: TEST_COLORS.black, selectedRelativePaths }] };
}

const TEST_COLORS = {
  black: { colorKey: 'a'.repeat(64), nameRu: 'Черный', nameZh: '黑色' },
  red: { colorKey: 'b'.repeat(64), nameRu: 'Красный', nameZh: '红色' },
  white: { colorKey: 'c'.repeat(64), nameRu: 'Белый', nameZh: '白色' }
};

function normalizeTestVariant(name: string) {
  return { variantId: name === '默认变体' ? '11111111-1111-4111-8111-111111111111' : randomUUID(), name };
}

function fixtureConfig(root: string): AppConfig {
  const config = createDefaultConfig('other');
  // Keep the legacy fixture's positional assumptions stable; shared contract tests
  // separately assert that real fresh configurations place E007 beside E006.
  const e007 = config.stages.find((stage) => stage.id === 'E007')!;
  config.stages = [...config.stages.filter((stage) => stage.id !== 'E007'), e007];
  for (const stage of config.stages) {
    const base = path.join(root, stage.id);
    if (stage.inputQueueRoot) stage.inputQueueRoot = path.join(base, 'input');
    if (stage.candidateRoot) stage.candidateRoot = path.join(base, 'candidate');
    if (stage.approvedArchiveRoot) stage.approvedArchiveRoot = path.join(base, 'archive');
    if (stage.outputRoot) stage.outputRoot = path.join(base, 'output');
    stage.targets.forEach((target) => { target.targetQueueRoot = path.join(root, target.targetStageId, 'input'); });
  }
  return config;
}

async function createProduct(root: string, name: string, files: string[]): Promise<void> {
  const product = path.join(root, name);
  await mkdir(product, { recursive: true });
  await writeFile(path.join(product, 'product-info.json'), JSON.stringify({ productName: name }), 'utf8');
  for (const [index, relative] of files.entries()) {
    const file = path.join(product, ...relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await sharp({ create: { width: 48, height: 48, channels: 3, background: index ? '#d98b2b' : '#087f8c' } }).png().toFile(file);
  }
}

async function writeTaskContext(root: string, name: string, variants = '默认变体'): Promise<void> {
  await writeFile(path.join(root, name, 'task-context.json'), JSON.stringify({ schemaVersion: 1, workflowCode: 'TEST', SKU: '0000011', productName: '网面跑步鞋', variantId: '11111111-1111-4111-8111-111111111111', variants, sourceSubmissionId: 'test-source' }), 'utf8');
}
