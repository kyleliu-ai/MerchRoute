import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { AppError, wbCategoryKeySchema } from '@n8n-media-review/shared';
import type { WbRepository } from '../repositories/wb.js';
import type { WbCatalogService } from '../services/wb-catalog/index.js';
import type { WbPublishingService } from '../services/wb-publishing/index.js';
import type { WbPresetService } from '../services/wb-presets/index.js';
import type { WbAutoPublishingCoordinator } from '../services/wb-auto-publish/index.js';
import type { WbSourceMediaCleanupService } from '../services/wb-source-media/index.js';
import { normalizeUpdatedDateRange } from '../utils/updated-date-range.js';
import { handleWbNetworkRecoveryRequest } from './wb-network-recovery.js';

export async function registerWbRoutes(app: FastifyInstance<any, any, any, any, any>, services: { wb: WbRepository; wbPublishing: WbPublishingService; wbCatalog: WbCatalogService; wbPresets: WbPresetService; wbAutoPublishing: WbAutoPublishingCoordinator; wbSourceMediaCleanup?: WbSourceMediaCleanupService }): Promise<void> {
  const { wb, wbPublishing, wbCatalog, wbPresets, wbAutoPublishing, wbSourceMediaCleanup } = services;
  const requireRuntimeKey = (request: { headers: Record<string, unknown> }) => {
    const expected = String(process.env.MERCHROUTE_RUNTIME_KEY || '').trim();
    if (!expected) throw new AppError('CONFIG_INVALID', '未配置 MERCHROUTE_RUNTIME_KEY，n8n 不能访问 WB PostgreSQL runtime API', undefined, 503);
    const received = String(request.headers['x-merchroute-runtime-key'] || '').trim();
    if (!received || received !== expected) throw new AppError('AUTH_INVALID', 'WB runtime API 密钥无效', undefined, 401);
  };

  app.get('/api/v1/wb/runtime/retry-protocol', async (request) => {
    requireRuntimeKey(request);
    return wb.autoRetry.protocol();
  });
  app.post('/api/v1/wb/runtime/retry-protocol', async (request) => {
    requireRuntimeKey(request);
    return wb.autoRetry.configureProtocol((request.body || {}) as { enabled: boolean; contractVersion: number; workflowVersionId?: string });
  });
  app.get('/api/v1/wb/runtime/config', async (request) => {
    requireRuntimeKey(request);
    return { config: await wb.getRuntimeConfig() };
  });
  app.get('/api/v1/wb/runtime/categories/:categoryKey', async (request) => {
    requireRuntimeKey(request);
    return { category: await wb.getRuntimeCategoryProjection((request.params as { categoryKey: string }).categoryKey) };
  });
  app.post('/api/v1/wb/runtime/jobs/enqueue', async (request) => {
    requireRuntimeKey(request);
    const body = request.body as Record<string, unknown> | undefined;
    return { job: await wb.enqueueRuntimeJob((body?.job as Record<string, unknown> | undefined) || body || {}) };
  });
  app.post('/api/v1/wb/runtime/jobs/claim', async (request) => {
    requireRuntimeKey(request);
    const body = (request.body || {}) as { leaseOwner?: string; limit?: number; leaseSeconds?: number };
    return {
      items: await wb.claimRuntimeJobs({
        leaseOwner: String(body.leaseOwner || ''),
        limit: Number(body.limit),
        leaseSeconds: Number(body.leaseSeconds)
      })
    };
  });
  app.get('/api/v1/wb/runtime/jobs', async (request) => {
    requireRuntimeKey(request);
    const query = request.query as { due?: string; page?: string; pageSize?: string; taskId?: string; productCode?: string; storeId?: string };
    return wb.listRuntimeJobs({
      due: query.due === 'true' || query.due === '1',
      page: Number(query.page),
      pageSize: Number(query.pageSize),
      taskId: query.taskId,
      productCode: query.productCode,
      storeId: query.storeId
    });
  });
  app.get('/api/v1/wb/runtime/jobs/:taskId', async (request) => {
    requireRuntimeKey(request);
    return { job: await wb.getRuntimeJob((request.params as { taskId: string }).taskId) };
  });
  app.post('/api/v1/wb/runtime/jobs/:taskId/transition', async (request) => {
    requireRuntimeKey(request);
    const body = request.body as Record<string, unknown> | undefined;
    return { job: await wb.transitionRuntimeJob((request.params as { taskId: string }).taskId, body || {}) };
  });
  app.post('/api/v1/wb/runtime/jobs/:taskId/recover-partial-create', async (request) => {
    requireRuntimeKey(request);
    return { job: await wb.recoverPartialCreateRuntimeJob((request.params as { taskId: string }).taskId) };
  });
  app.post('/api/v1/wb/runtime/jobs/:taskId/recover-compatible', async (request) => {
    requireRuntimeKey(request);
    const recovered = await wbAutoPublishing.recoverCompatibleRuntimeTask((request.params as { taskId: string }).taskId);
    return { job: recovered.runtimeJob, automationJob: recovered.automationJob };
  });
  app.get('/api/v1/wb/runtime/registry', async (request) => {
    requireRuntimeKey(request);
    const query = request.query as { productCode?: string; storeId?: string };
    if (!query.productCode) throw new AppError('CONFIG_INVALID', 'productCode 必填');
    return { items: await wb.listRuntimeRegistry(query.productCode, query.storeId) };
  });
  app.post('/api/v1/wb/runtime/jobs/:taskId/registry', async (request) => {
    requireRuntimeKey(request);
    const body = request.body as { rows?: Record<string, unknown>[]; row?: Record<string, unknown> } | Record<string, unknown>[] | undefined;
    const rows = Array.isArray(body) ? body : Array.isArray(body?.rows) ? body.rows : body?.row ? [body.row] : [];
    return { items: await wb.upsertRuntimeRegistry((request.params as { taskId: string }).taskId, rows) };
  });
  app.post('/api/v1/wb/runtime/errors', async (request) => {
    requireRuntimeKey(request);
    return { error: await wb.recordRuntimeError((request.body as Record<string, unknown> | undefined) || {}) };
  });
  app.post('/api/v1/wb/runtime/recovery/network', async (request) => {
    requireRuntimeKey(request);
    return handleWbNetworkRecoveryRequest({ wb, auto: wbAutoPublishing.repository }, request.body);
  });

  app.post('/api/v1/config/wb-publishing/initialize', async (request) => wbPublishing.initializeSettings(request.body));
  app.post('/api/v1/config/wb-publishing/sync', async () => wbPublishing.syncSettings());

  app.get('/api/v1/wb/listings', async (request) => {
    const query = request.query as { page?: string; pageSize?: string; query?: string; updatedFrom?: string; updatedTo?: string; source?: string };
    const source = query.source || 'ALL';
    if (!['MANUAL', 'AUTOMATION', 'ALL'].includes(source)) {
      throw new AppError('CONFIG_INVALID', 'source 仅支持 MANUAL、AUTOMATION 或 ALL', { source });
    }
    return wb.listListings({
      page: Number(query.page),
      pageSize: Number(query.pageSize),
      query: query.query,
      source: source as 'MANUAL' | 'AUTOMATION' | 'ALL',
      ...normalizeUpdatedDateRange(query)
    });
  });
  app.post('/api/v1/wb/listings', async (request) => {
    const body = request.body as { sku?: string };
    if (!body?.sku) throw new AppError('CONFIG_INVALID', '请选择产品 SKU');
    const existing = await wb.getListing(body.sku).catch((error) => {
      if (error instanceof AppError && error.code === 'NOT_FOUND' && error.message.includes('草稿')) return undefined;
      throw error;
    });
    if (existing) return { listing: existing };
    return { listing: await wbPublishing.initializeListing(body.sku, () => wbPresets.createPublicMaterialListing(body.sku!)) };
  });
  app.get('/api/v1/wb/listings/:sku', async (request) => ({ listing: await wb.getListing((request.params as { sku: string }).sku) }));
  app.put('/api/v1/wb/listings/:sku', async (request) => ({ listing: await wbPublishing.updateListing((request.params as { sku: string }).sku, request.body) }));
  app.post('/api/v1/wb/listings/:sku/media/scan', async (request) => {
    const sku = (request.params as { sku: string }).sku;
    await assertWbSourceMediaAvailable(wbSourceMediaCleanup, sku);
    const listing = await wbPublishing.scanMedia(sku);
    return { listing, mediaAssets: listing.mediaAssets, productVariants: await wbPublishing.productVariants(sku) };
  });
  app.get('/api/v1/wb/listings/:sku/media/:assetId', async (request, reply) => {
    const { sku, assetId } = request.params as { sku: string; assetId: string };
    const { thumbnail } = request.query as { thumbnail?: string };
    await assertWbSourceMediaAvailable(wbSourceMediaCleanup, sku);
    const resolved = await wbPublishing.resolveMedia(sku, assetId);
    if (thumbnail === 'true') {
      if (resolved.asset.kind !== 'image') throw new AppError('UNSUPPORTED_FILE_TYPE', '只有图片支持缩略图');
      const buffer = await sharp(resolved.filePath).rotate().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
      return reply.header('Cache-Control', 'private, max-age=300').type('image/webp').send(buffer);
    }
    const file = await stat(resolved.filePath);
    if (resolved.asset.kind === 'video' && request.headers.range) {
      const range = parseRange(request.headers.range, file.size);
      return reply.code(206)
        .headers({
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${range.start}-${range.end}/${file.size}`,
          'Content-Length': String(range.end - range.start + 1),
          'Cache-Control': 'private, max-age=300'
        })
        .type(resolved.asset.mimeType)
        .send(createReadStream(resolved.filePath, { start: range.start, end: range.end }));
    }
    return reply
      .headers({ 'Content-Length': String(file.size), 'Accept-Ranges': resolved.asset.kind === 'video' ? 'bytes' : 'none', 'Cache-Control': 'private, max-age=300' })
      .type(resolved.asset.mimeType)
      .send(createReadStream(resolved.filePath));
  });
  app.post('/api/v1/wb/listings/:sku/generate', async () => {
    throw new AppError('WB_STORE_SELECTION_REQUIRED', 'WB 手动上品必须选择店铺后发布；系统会按每家店铺的默认预设分别生成 product.json', undefined, 410);
  });
  app.post('/api/v1/wb/listings/:sku/submit', async () => {
    throw new AppError('WB_STORE_SELECTION_REQUIRED', 'WB 手动上品必须选择店铺后发布；不再支持提交共享 product.json', undefined, 410);
  });
  app.get('/api/v1/wb/listings/:sku/status', async (request) => wbPublishing.status((request.params as { sku: string }).sku));
  app.get('/api/v1/wb/listings/:sku/description-source', async (request) => ({ source: await wbPresets.descriptionSource((request.params as { sku: string }).sku) }));
  app.post('/api/v1/wb/listings/:sku/initialize-missing', async (request) => {
    const body = request.body as { draftVersion?: number };
    if (!Number.isInteger(body?.draftVersion) || Number(body.draftVersion) < 1) throw new AppError('CONFIG_INVALID', '缺少有效的 draftVersion');
    return { listing: await wbPresets.initializeMissing((request.params as { sku: string }).sku, Number(body.draftVersion)) };
  });

  app.get('/api/v1/wb/presets', async () => {
    const [items, boundCounts] = await Promise.all([wbPresets.list(), wbAutoPublishing.boundCountsByPreset()]);
    return { items: items.map((preset) => ({ ...preset, activeBoundJobCount: boundCounts[preset.id] || 0 })) };
  });
  app.post('/api/v1/wb/presets', async (request) => ({ preset: await wbPresets.create(request.body) }));
  app.get('/api/v1/wb/presets/:id', async (request) => ({ preset: await wbPresets.get((request.params as { id: string }).id) }));
  app.put('/api/v1/wb/presets/:id', async (request) => ({ preset: await wbPresets.update((request.params as { id: string }).id, request.body) }));
  app.delete('/api/v1/wb/presets/:id', async (request) => {
    const query = request.query as { rowVersion?: string };
    return { deleted: await wbPresets.delete((request.params as { id: string }).id, Number(query.rowVersion)) };
  });
  app.post('/api/v1/wb/presets/:id/clone', async (request) => {
    const body = request.body as { name?: string } | undefined;
    return { preset: await wbPresets.clone((request.params as { id: string }).id, body?.name) };
  });
  app.post('/api/v1/wb/presets/:id/default', async () => {
    throw new AppError('WB_MANUAL_DEFAULT_REMOVED', '“手动资料默认预设”已取消；请在每家 WB 店铺中选择默认上品预设', undefined, 410);
  });

  app.get('/api/v1/wb/automation/status', async () => wbAutoPublishing.status());
  app.get('/api/v1/wb/automation/jobs', async (request) => {
    const query = request.query as { page?: string; pageSize?: string; state?: string; query?: string; updatedFrom?: string; updatedTo?: string; storeId?: string };
    return wbAutoPublishing.list({
      page: Number(query.page),
      pageSize: Number(query.pageSize),
      state: query.state,
      query: query.query,
      storeId: query.storeId,
      ...normalizeUpdatedDateRange(query)
    });
  });
  app.get('/api/v1/wb/automation/jobs/:sku', async (request) => wbAutoPublishing.get(
    (request.params as { sku: string }).sku, (request.query as { storeId?: string }).storeId
  ));
  app.get('/api/v1/wb/automation/jobs/:sku/runs', async (request) => ({ items: await wbAutoPublishing.runs(
    (request.params as { sku: string }).sku, (request.query as { storeId?: string }).storeId
  ) }));
  app.post('/api/v1/wb/automation/jobs/:sku/start-compatible', async (request) => ({ job: await wbAutoPublishing.startCompatible(
    (request.params as { sku: string }).sku, String((request.body as Record<string, unknown> | undefined)?.storeId || '') || undefined
  ) }));
  app.post('/api/v1/wb/automation/jobs/:sku/recheck', async (request) => ({ job: await wbAutoPublishing.recheck(
    (request.params as { sku: string }).sku, String((request.body as Record<string, unknown> | undefined)?.storeId || '') || undefined
  ) }));
  app.post('/api/v1/wb/automation/jobs/:sku/retry', async (request) => wbAutoPublishing.retry(
    (request.params as { sku: string }).sku, request.body
  ));
  app.post('/api/v1/wb/automation/jobs/:sku/cancel', async (request) => ({ job: await wbAutoPublishing.cancel(
    (request.params as { sku: string }).sku, String((request.body as Record<string, unknown> | undefined)?.storeId || '') || undefined
  ) }));

  app.get('/api/v1/wb/categories', async () => ({ items: await wb.listCategories() }));
  app.post('/api/v1/wb/categories', async (request) => {
    const body = request.body as Record<string, unknown>;
    const categoryKey = wbCategoryKeySchema.safeParse(body?.categoryKey);
    if (!categoryKey.success) throw new AppError('CONFIG_INVALID', '类目 Key 格式无效', { issues: categoryKey.error.issues });
    const definition = { ...body };
    delete definition.categoryKey;
    return { category: await wb.createCategory(categoryKey.data, definition) };
  });
  app.get('/api/v1/wb/categories/:categoryKey', async (request) => ({ category: await wb.getCategory((request.params as { categoryKey: string }).categoryKey) }));
  app.put('/api/v1/wb/categories/:categoryKey/draft', async (request) => ({ category: await wb.saveCategoryDraft((request.params as { categoryKey: string }).categoryKey, request.body) }));
  app.post('/api/v1/wb/categories/:categoryKey/publish', async (request) => {
    const body = request.body as { confirmedBy?: string };
    return { category: await wb.publishCategory((request.params as { categoryKey: string }).categoryKey, body?.confirmedBy || '') };
  });
  app.post('/api/v1/wb/categories/:categoryKey/sync', async (request) => wbPublishing.syncCategory((request.params as { categoryKey: string }).categoryKey));
  app.delete('/api/v1/wb/categories/:categoryKey', async (request) => wbPublishing.deleteCategory((request.params as { categoryKey: string }).categoryKey));

  app.get('/api/v1/wb/catalog/status', async () => ({ catalog: await wbCatalog.status() }));
  app.post('/api/v1/wb/catalog/sync', async (_request, reply) => reply.code(202).send(await wbCatalog.triggerManual()));
  app.get('/api/v1/wb/catalog/subjects', async (request) => {
    const query = request.query as { query?: string; limit?: string };
    return wbCatalog.search(query.query || '', query.limit === undefined ? undefined : Number(query.limit));
  });
  app.get('/api/v1/wb/catalog/colors', async (request) => {
    const query = request.query as { query?: string; limit?: string };
    return wbCatalog.colors(query.query || '', query.limit === undefined ? undefined : Number(query.limit));
  });
  app.get('/api/v1/wb/catalog/dictionaries/:directory', async (request) => {
    const { directory } = request.params as { directory: string };
    const query = request.query as { query?: string; limit?: string };
    return wbCatalog.dictionary(directory, query.query || '', query.limit === undefined ? undefined : Number(query.limit));
  });
  app.get('/api/v1/wb/catalog/subjects/:subjectId/schema', async (request) => {
    const subjectId = Number((request.params as { subjectId: string }).subjectId);
    const locale = parseWbLocale((request.query as { locale?: string }).locale);
    if (!Number.isInteger(subjectId) || subjectId < 1) throw new AppError('CONFIG_INVALID', 'subjectId 格式无效');
    return wbPublishing.n8n.getSubjectSchema(subjectId, locale);
  });
  app.get('/api/v1/wb/catalog/directories/:directory', async (request) => {
    const { directory } = request.params as { directory: string };
    const { subjectId: rawSubjectId, search, query, locale: rawLocale } = request.query as { subjectId?: string; search?: string; query?: string; locale?: string };
    const subjectId = rawSubjectId == null || rawSubjectId === '' ? undefined : Number(rawSubjectId);
    const locale = parseWbLocale(rawLocale);
    if (subjectId !== undefined && (!Number.isInteger(subjectId) || subjectId < 1)) throw new AppError('CONFIG_INVALID', 'subjectId 格式无效');
    return wbPublishing.n8n.getDirectory(directory, { subjectId, search: search || query, locale });
  });
}

async function assertWbSourceMediaAvailable(cleanup: WbSourceMediaCleanupService | undefined, sku: string): Promise<void> {
  if (!cleanup) return;
  const source = await cleanup.sourceState(sku);
  if (source.state === 'CLEANED') {
    throw new AppError('WB_SOURCE_MEDIA_CLEANED', '公共媒体已在成功上品后清理，请重新投递媒体', {
      sku,
      cleanedAt: source.cleanedAt
    }, 410);
  }
}

function parseWbLocale(value: string | undefined): 'ru' | 'zh' {
  const locale = value?.trim() || 'ru';
  if (locale !== 'ru' && locale !== 'zh') throw new AppError('CONFIG_INVALID', 'locale 仅支持 ru 或 zh');
  return locale;
}

function parseRange(header: string, size: number): { start: number; end: number } {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) throw new AppError('CONFIG_INVALID', 'Range 请求格式无效', undefined, 416);
  const requestedStart = match[1] ? Number(match[1]) : undefined;
  const requestedEnd = match[2] ? Number(match[2]) : undefined;
  let start: number;
  let end: number;
  if (requestedStart === undefined) {
    const suffix = requestedEnd || 0;
    if (suffix < 1) throw new AppError('CONFIG_INVALID', 'Range 请求格式无效', undefined, 416);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = requestedStart;
    end = requestedEnd === undefined ? size - 1 : Math.min(requestedEnd, size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
    throw new AppError('CONFIG_INVALID', 'Range 请求超出文件范围', { size }, 416);
  }
  return { start, end };
}
