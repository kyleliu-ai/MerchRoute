import { createReadStream } from 'node:fs';
import path from 'node:path';
import { lstat, stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import {
  AppError,
  OZON_PUBLISH_JOB_STATES,
  ozonRuntimeTransitionBindingSchema,
  ozonCategoryFromCatalogInputSchema,
  ozonPresetInputSchema,
  ozonPresetUpdateSchema,
  type OzonPresetInput,
  type OzonNetworkRecovery,
  type OzonProductMappingInput,
  type OzonPublishJob,
  type OzonPublishJobState,
  type OzonTaskDirectoryStage,
  type ShippingService
} from '@n8n-media-review/shared';
import {
  OZON_KNOWN_PRE_PLATFORM_FAILURE_REASONS,
  OZON_KNOWN_POST_PLATFORM_MIN_PRICE_FAILURE_REASON,
  type OzonKnownPrePlatformFailureReason,
  type OzonKnownPostPlatformMinPriceRecoveryInput,
  type OzonRepository
} from '../repositories/ozon.js';
import type { PricingRepository } from '../repositories/pricing.js';
import type { ShippingRepository } from '../repositories/shipping.js';
import type { OzonPublishingService } from '../services/ozon-publishing/index.js';
import type { OzonAutoPublishingCoordinator } from '../services/ozon-publishing/auto-publishing.js';
import type { OzonCatalogService } from '../services/ozon-catalog/index.js';
import type { ConfigService } from '../config/service.js';
import type { OzonStoreService } from '../services/ozon-stores/index.js';
import type { OzonSourceMediaCleanupService } from '../services/ozon-source-media/index.js';

export async function registerOzonRoutes(
  app: FastifyInstance<any, any, any, any, any>,
  services: { ozon: OzonRepository; ozonStores: OzonStoreService; ozonPublishing: OzonPublishingService; ozonAutoPublishing: OzonAutoPublishingCoordinator; ozonCatalog: OzonCatalogService; ozonSourceMediaCleanup: OzonSourceMediaCleanupService; pricing: PricingRepository; shipping: ShippingRepository; config: ConfigService }
): Promise<void> {
  const { ozon, ozonStores, ozonPublishing, ozonAutoPublishing, ozonCatalog, ozonSourceMediaCleanup, pricing, shipping, config } = services;
  const requireRuntimeKey = (request: { headers: Record<string, unknown> }) => {
    const expected = String(process.env.MERCHROUTE_RUNTIME_KEY || '').trim();
    if (!expected) throw new AppError('CONFIG_INVALID', '未配置 MERCHROUTE_RUNTIME_KEY，不能访问 OZON 历史网络恢复 API', undefined, 503);
    const received = String(request.headers['x-merchroute-runtime-key'] || '').trim();
    if (!received || received !== expected) throw new AppError('AUTH_INVALID', 'OZON 历史网络恢复 API 密钥无效', undefined, 401);
  };

  app.get('/api/v1/ozon/system', async () => ozonPublishing.readiness(false));
  app.put('/api/v1/ozon/system', async (request) => ozonPublishing.updateSettings(request.body));
  app.post('/api/v1/ozon/system/initialize', async (request) => {
    const body = request.body as { rootDirectory?: string };
    if (!body?.rootDirectory) throw new AppError('CONFIG_INVALID', '请填写 OZON 自动上品根目录');
    return ozonPublishing.initializeRoot(body.rootDirectory);
  });
  app.post('/api/v1/ozon/system/video-upload-probe', async (request) => {
    const body = request.body as { sourceFilePath?: string };
    const sourceFilePath = path.resolve(String(body?.sourceFilePath || ''));
    const e004Root = config.get().stages.find((stage) => stage.id === 'E004')?.candidateRoot;
    if (!e004Root) throw new AppError('CONFIG_INVALID', 'E004 候选视频目录尚未配置', undefined, 409);
    const root = path.resolve(e004Root);
    const relative = path.relative(root, sourceFilePath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new AppError('PATH_TRAVERSAL_BLOCKED', '视频探测文件必须位于 E004 候选视频目录内', undefined, 403);
    const info = await lstat(sourceFilePath).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || path.extname(sourceFilePath).toLocaleLowerCase() !== '.mp4') throw new AppError('UNSUPPORTED_FILE_TYPE', '视频能力探测只接受 E004 目录中的普通 MP4 文件');
    return ozonPublishing.probeVideoUpload(sourceFilePath);
  });

  app.get('/api/v1/ozon/listings', async (request) => {
    const query = request.query as { page?: string; pageSize?: string; query?: string; status?: string; source?: string; purchaseCreatedFrom?: string; purchaseCreatedTo?: string };
    const source = String(query.source || 'ALL').trim().toUpperCase();
    if (!['ALL', 'AUTO', 'MANUAL'].includes(source)) throw new AppError('CONFIG_INVALID', 'OZON 上品资料来源筛选无效');
    return ozon.listListings({
      page: numberValue(query.page),
      pageSize: numberValue(query.pageSize),
      query: query.query,
      status: query.status,
      source: source as 'ALL' | 'AUTO' | 'MANUAL',
      purchaseCreatedFrom: query.purchaseCreatedFrom,
      purchaseCreatedTo: query.purchaseCreatedTo
    });
  });
  app.post('/api/v1/ozon/listings', async (request) => {
    const body = request.body as { sku?: string };
    if (!body?.sku) throw new AppError('CONFIG_INVALID', '请选择产品 SKU');
    return materialPersistenceResponse(await ozonPublishing.createListing(body.sku));
  });
  app.get('/api/v1/ozon/listings/:sku', async (request) => {
    const detail = await ozonPublishing.getListing((request.params as { sku: string }).sku);
    const sourceMediaCleanup = detail.listing.generatedVersionId
      ? await ozonSourceMediaCleanup.summary(detail.listing.generatedVersionId)
      : undefined;
    return { ...detail, ...(sourceMediaCleanup ? { sourceMediaCleanup } : {}) };
  });
  app.post('/api/v1/ozon/listings/:sku/preparations/:jobId/manual-takeover', async (request) => {
    const params = request.params as { sku: string; jobId: string };
    const body = request.body as { jobRowVersion?: number; listingRowVersion?: number } | undefined;
    return ozonPublishing.takeOverAutomaticPreparationForManual({
      sku: params.sku,
      jobId: params.jobId,
      jobRowVersion: requiredVersion(body?.jobRowVersion),
      listingRowVersion: requiredVersion(body?.listingRowVersion)
    });
  });
  app.get('/api/v1/ozon/listings/:sku/compatible-append-plan', async (request) => {
    throw publicationWorkflowRequired((request.params as { sku: string }).sku, '兼容追加');
  });
  app.post('/api/v1/ozon/listings/:sku/compatible-append', async (request) => {
    throw publicationWorkflowRequired((request.params as { sku: string }).sku, '兼容追加');
  });
  app.post('/api/v1/ozon/listings/:sku/platform-status/refresh', async (request) => {
    const body = request.body as { rowVersion?: number } | undefined;
    const sku = (request.params as { sku: string }).sku;
    await ozonStores.repository.assertLegacySkuRefreshAllowed(sku);
    return ozonPublishing.refreshPlatformStatus(
      sku,
      requiredVersion(body?.rowVersion)
    );
  });
  app.put('/api/v1/ozon/listings/:sku', async (request) => materialPersistenceResponse(
    await ozonPublishing.updateListing((request.params as { sku: string }).sku, request.body)
  ));
  app.put('/api/v1/ozon/listings/:sku/shared-material', async (request) => materialPersistenceResponse(
    await ozonPublishing.updateSharedMaterial((request.params as { sku: string }).sku, request.body)
  ));
  app.post('/api/v1/ozon/listings/:sku/initialize-missing', async (request) => {
    const body = request.body as { rowVersion?: number } | undefined;
    return {
      listing: await ozonPublishing.initializeMissing(
        (request.params as { sku: string }).sku,
        requiredVersion(body?.rowVersion)
      )
    };
  });
  app.post('/api/v1/ozon/listings/:sku/media/scan', async (request) => {
    const body = request.body as { rowVersion?: number };
    return ozonPublishing.scanMedia(
      (request.params as { sku: string }).sku,
      requiredVersion(body?.rowVersion)
    );
  });
  app.get('/api/v1/ozon/listings/:sku/media/:assetId', async (request, reply) => {
    const { sku, assetId } = request.params as { sku: string; assetId: string };
    const { thumbnail } = request.query as { thumbnail?: string };
    const resolved = await ozonPublishing.resolveMedia(sku, assetId);
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
      .headers({
        'Content-Length': String(file.size),
        'Accept-Ranges': resolved.asset.kind === 'video' ? 'bytes' : 'none',
        'Cache-Control': 'private, max-age=300'
      })
      .type(resolved.asset.mimeType)
      .send(createReadStream(resolved.filePath));
  });
  app.post('/api/v1/ozon/listings/:sku/generate', async (request) => {
    throw publicationWorkflowRequired((request.params as { sku: string }).sku, '生成旧单店调度产物');
  });
  app.post('/api/v1/ozon/listings/:sku/submit', async (request) => {
    throw publicationWorkflowRequired((request.params as { sku: string }).sku, '提交旧单店任务');
  });
  app.get('/api/v1/ozon/listings/:sku/jobs', async (request) => {
    const { sku } = request.params as { sku: string };
    const query = request.query as { page?: string; pageSize?: string; state?: string };
    return ozon.listManualJobsForSku(sku, {
      page: numberValue(query.page),
      pageSize: numberValue(query.pageSize),
      state: query.state
    });
  });
  app.get('/api/v1/ozon/listings/:sku/jobs/:jobId', async (request) => {
    const { sku, jobId } = request.params as { sku: string; jobId: string };
    await ozonStores.repository.assertLegacyJobRouteAllowed(jobId, 'DETAIL');
    return ozonPublishing.getManualJobDetail(sku, jobId);
  });
  app.post('/api/v1/ozon/listings/:sku/jobs/:jobId/cancel', async (request) => {
    const { sku, jobId } = request.params as { sku: string; jobId: string };
    await ozonStores.repository.assertLegacyJobRouteAllowed(jobId, 'CANCEL');
    const job = await ozon.getJob(jobId, 'MANUAL');
    if (job.sku !== sku) throw new AppError('NOT_FOUND', '该手动 OZON 任务不属于当前 SKU', { sku, jobId }, 404);
    return { job: await ozonPublishing.cancelJob(jobId, 'MANUAL') };
  });
  app.post('/api/v1/ozon/listings/:sku/jobs/:jobId/recheck', async (request) => {
    const { sku, jobId } = request.params as { sku: string; jobId: string };
    await ozonStores.repository.assertLegacyJobRouteAllowed(jobId, 'RECHECK');
    const body = request.body as { rowVersion?: number } | undefined;
    const job = await ozon.getJob(jobId, 'MANUAL');
    if (job.sku !== sku) throw new AppError('NOT_FOUND', '该手动 OZON 任务不属于当前 SKU', { sku, jobId }, 404);
    return { job: await ozonPublishing.recheckJob(jobId, 'MANUAL', body?.rowVersion === undefined ? undefined : requiredVersion(body.rowVersion)) };
  });
  app.post('/api/v1/ozon/listings/:sku/jobs/:jobId/return-to-edit', async (request) => {
    const { sku, jobId } = request.params as { sku: string; jobId: string };
    await ozonStores.repository.assertLegacyJobRouteAllowed(jobId, 'RETURN_TO_EDIT');
    const body = request.body as { jobRowVersion?: number; listingRowVersion?: number };
    return ozonPublishing.returnManualJobToEdit(sku, jobId, {
      jobRowVersion: requiredVersion(body?.jobRowVersion),
      listingRowVersion: requiredVersion(body?.listingRowVersion)
    });
  });

  app.get('/api/v1/ozon/catalog/status', async () => ({ catalog: await ozonCatalog.status() }));
  app.post('/api/v1/ozon/catalog/sync', async (_request, reply) => reply.code(202).send(await ozonCatalog.triggerManual()));
  app.get('/api/v1/ozon/catalog/categories', async (request) => {
    const query = request.query as { query?: string; limit?: string };
    return ozonCatalog.search(query.query || '', query.limit === undefined ? undefined : Number(query.limit));
  });
  app.get('/api/v1/ozon/catalog/dictionaries/:directory', async (request) => {
    const { directory } = request.params as { directory: string };
    const query = request.query as { query?: string; dictionaryId?: string; limit?: string };
    return ozonCatalog.dictionary(
      directory,
      query.query || '',
      query.dictionaryId === undefined ? undefined : Number(query.dictionaryId),
      query.limit === undefined ? undefined : Number(query.limit)
    );
  });

  app.get('/api/v1/ozon/categories', async () => ({ items: await ozon.listCategories() }));
  app.post('/api/v1/ozon/categories', async (request) => {
    const parsed = ozonCategoryFromCatalogInputSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError('CONFIG_INVALID', parsed.error.issues.map((issue) => issue.message).join('；'), { issues: parsed.error.issues });
    return { category: await ozonCatalog.createCategory(parsed.data.catalogEntryId) };
  });
  app.get('/api/v1/ozon/categories/:categoryKey', async (request) => ({
    category: await ozon.getCategory((request.params as { categoryKey: string }).categoryKey)
  }));
  app.put('/api/v1/ozon/categories/:categoryKey/draft', async (request) => ({
    category: await ozon.saveCategoryDraft((request.params as { categoryKey: string }).categoryKey, request.body)
  }));
  app.put('/api/v1/ozon/categories/:categoryKey/attributes-order', async (request) => ({
    category: await ozon.saveCategoryAttributeOrder((request.params as { categoryKey: string }).categoryKey, request.body)
  }));
  app.post('/api/v1/ozon/categories/:categoryKey/refresh', async (request) => ({
    category: await ozonCatalog.refreshCategory((request.params as { categoryKey: string }).categoryKey)
  }));
  app.post('/api/v1/ozon/categories/:categoryKey/publish', async (request) => {
    const body = request.body as { confirmedBy?: string };
    return {
      category: await ozon.publishCategory(
        (request.params as { categoryKey: string }).categoryKey,
        String(body?.confirmedBy || '').trim()
      )
    };
  });
  app.delete('/api/v1/ozon/categories/:categoryKey', async (request) => ({
    deleted: await ozon.deleteCategory((request.params as { categoryKey: string }).categoryKey)
  }));

  app.get('/api/v1/ozon/presets', async () => ({ items: await ozon.listPresets() }));
  app.post('/api/v1/ozon/presets', async (request) => {
    const definition = parseOzonPreset(request.body, false);
    await assertOzonPresetPricingChain(pricing, shipping, definition);
    return { preset: await ozon.createPreset(definition) };
  });
  app.get('/api/v1/ozon/presets/:id', async (request) => ({
    preset: await ozon.getPreset((request.params as { id: string }).id)
  }));
  app.put('/api/v1/ozon/presets/:id', async (request) => {
    const definition = parseOzonPreset(request.body, true);
    await assertOzonPresetPricingChain(pricing, shipping, definition);
    return { preset: await ozon.updatePreset((request.params as { id: string }).id, definition) };
  });
  app.post('/api/v1/ozon/presets/:id/clone', async (request) => {
    const body = request.body as { name?: string };
    return { preset: await ozon.clonePreset((request.params as { id: string }).id, body?.name) };
  });
  app.delete('/api/v1/ozon/presets/:id', async (request) => {
    const query = request.query as { rowVersion?: string };
    return {
      deleted: await ozon.deletePreset(
        (request.params as { id: string }).id,
        requiredVersion(numberValue(query.rowVersion))
      )
    };
  });

  app.get('/api/v1/ozon/automation/status', async () => ozonAutoPublishing.status());
  app.get('/api/v1/ozon/automation/jobs', async (request) => {
    const query = request.query as { page?: string; pageSize?: string; query?: string; state?: string; purchaseCreatedFrom?: string; purchaseCreatedTo?: string; businessOnly?: string };
    if (query.businessOnly !== undefined && !['true', 'false', '1', '0'].includes(query.businessOnly)) {
      throw new AppError('CONFIG_INVALID', 'OZON 自动任务业务清单筛选无效');
    }
    return ozonAutoPublishing.list({
      page: numberValue(query.page),
      pageSize: numberValue(query.pageSize),
      query: query.query,
      state: query.state,
      businessOnly: query.businessOnly === 'true' || query.businessOnly === '1',
      purchaseCreatedFrom: query.purchaseCreatedFrom,
      purchaseCreatedTo: query.purchaseCreatedTo
    });
  });
  app.get('/api/v1/ozon/automation/jobs/:jobId/listing-snapshot', async (request) => {
    const jobId = (request.params as { jobId: string }).jobId;
    const storeId = requiredStoreId((request.query as { storeId?: string }).storeId);
    return { snapshot: await ozonStores.automaticListingSnapshot(jobId, storeId) };
  });
  app.get('/api/v1/ozon/automation/jobs/:id/task-detail', async (request) => {
    const detail = await ozonAutoPublishing.preparationTaskDetail((request.params as { id: string }).id);
    const generatedVersionId = String(detail.job.payload?.generatedVersionId || '');
    const sourceMediaCleanup = generatedVersionId ? await ozonSourceMediaCleanup.summary(generatedVersionId) : undefined;
    return { ...detail, ...(sourceMediaCleanup ? { sourceMediaCleanup } : {}) };
  });
  app.get('/api/v1/ozon/automation/jobs/:id/material-snapshot', async (request) => ({
    snapshot: await ozonAutoPublishing.preparationMaterialSnapshot((request.params as { id: string }).id)
  }));
  app.get('/api/v1/ozon/automation/jobs/:id/recheck-plan', async (request) => {
    const query = request.query as { rowVersion?: string };
    return ozonAutoPublishing.preparationRecheckPlan(
      (request.params as { id: string }).id,
      { rowVersion: numberValue(query.rowVersion) }
    );
  });
  app.get('/api/v1/ozon/automation/jobs/:id', async (request) => {
    const id = (request.params as { id: string }).id;
    const storeId = requiredStoreId((request.query as { storeId?: string }).storeId);
    const job = await ozonAutoPublishing.get(id);
    assertJobStoreIdentity(job, storeId, id);
    const generatedVersionId = String(job.payload?.generatedVersionId || '');
    const sourceMediaCleanup = generatedVersionId ? await ozonSourceMediaCleanup.summary(generatedVersionId) : undefined;
    return { job, ...(sourceMediaCleanup ? { sourceMediaCleanup } : {}) };
  });
  app.post('/api/v1/ozon/automation/jobs/:id/cancel', async (request) => {
    const id = (request.params as { id: string }).id;
    const storeId = requiredStoreId(objectValue(request.body).storeId);
    const job = await ozonAutoPublishing.get(id);
    assertJobStoreIdentity(job, storeId, id);
    await ozonStores.repository.assertLegacyJobRouteAllowed(id, 'CANCEL');
    return { job: await ozonAutoPublishing.cancel(id) };
  });
  app.post('/api/v1/ozon/automation/jobs/:id/recheck', async (request) => {
    const id = (request.params as { id: string }).id;
    const job = await ozonAutoPublishing.get(id);
    if (job.taskKind === 'SHARED_PREPARATION') {
      return ozonAutoPublishing.recheckPreparation(id, request.body);
    }
    const storeId = requiredStoreId(objectValue(request.body).storeId);
    assertJobStoreIdentity(job, storeId, id);
    const authorization = await ozonStores.repository.assertLegacyJobRouteAllowed(id, 'RECHECK');
    return { job: await ozonAutoPublishing.recheck(id, authorization?.expectedRowVersion) };
  });
  app.post('/api/v1/ozon/runtime/jobs/:id/transition', async (request) => {
    requireRuntimeKey(request);
    const body = objectValue(request.body);
    const binding = ozonRuntimeTransitionBindingSchema.safeParse({
      storeId: body.storeId,
      publicationId: body.publicationId,
      credentialVersionId: body.credentialVersionId,
      credentialBindingMode: body.credentialBindingMode,
      storeConfigVersion: body.storeConfigVersion,
      warehouseId: body.warehouseId,
      offerContractHash: body.offerContractHash,
      materializationHash: body.materializationHash,
      contentPolicyVersion: body.contentPolicyVersion,
      materialHash: body.materialHash,
      materialHashVersion: body.materialHashVersion,
      rowVersion: body.rowVersion,
      leaseOwner: body.leaseOwner,
      leaseToken: body.leaseToken
    });
    if (!binding.success) throw new AppError('CONFIG_INVALID', 'OZON runtime transition 缺少不可变店铺/凭据/租约绑定', { issues: binding.error.issues });
    await ozonStores.repository.assertRuntimeBinding((request.params as { id: string }).id, binding.data);
    return ozonPublishing.recordRuntimeUpdate(
      (request.params as { id: string }).id,
      parseRuntimeTransition(request.body)
    );
  });
  app.get('/api/v1/ozon/runtime/jobs', async (request) => {
    requireRuntimeKey(request);
    const query = request.query as { page?: string; pageSize?: string; query?: string; state?: string };
    return ozonPublishing.listRuntimeJobs({
      page: numberValue(query.page),
      pageSize: numberValue(query.pageSize),
      query: query.query,
      state: query.state
    });
  });
  app.get('/api/v1/ozon/runtime/network-recovery-candidates', async (request) => {
    requireRuntimeKey(request);
    const query = request.query as { limit?: string };
    return ozonPublishing.listHistoricalNetworkRecoveryCandidates(numberValue(query.limit));
  });
  app.post('/api/v1/ozon/runtime/jobs/claim', async (request) => {
    requireRuntimeKey(request);
    return ozonStores.claimRuntimeJobs(request.body);
  });
  app.get('/api/v1/ozon/runtime/jobs/:id', async (request) => {
    requireRuntimeKey(request);
    return { job: await ozonPublishing.getRuntimeJob((request.params as { id: string }).id) };
  });
  app.post('/api/v1/ozon/runtime/jobs/:id/lease/renew', async (request) => {
    requireRuntimeKey(request);
    const body = objectValue(request.body);
    return ozonPublishing.renewRuntimeLease((request.params as { id: string }).id, {
      leaseOwner: requiredRuntimeString(body.leaseOwner, 'leaseOwner'),
      leaseToken: requiredRuntimeString(body.leaseToken, 'leaseToken'),
      rowVersion: requiredVersion(Number(body.rowVersion)),
      leaseSeconds: optionalPositiveInteger(body.leaseSeconds, 'leaseSeconds')
    });
  });
  app.post('/api/v1/ozon/runtime/jobs/:id/lease/release', async (request) => {
    requireRuntimeKey(request);
    const body = objectValue(request.body);
    return ozonPublishing.releaseRuntimeLease((request.params as { id: string }).id, {
      leaseOwner: requiredRuntimeString(body.leaseOwner, 'leaseOwner'),
      leaseToken: requiredRuntimeString(body.leaseToken, 'leaseToken'),
      rowVersion: requiredVersion(Number(body.rowVersion))
    });
  });
  app.post('/api/v1/ozon/runtime/jobs/:id/recover-network', async (request) => {
    requireRuntimeKey(request);
    const body = objectValue(request.body);
    return ozonPublishing.recoverHistoricalNetworkJob(
      (request.params as { id: string }).id,
      requiredVersion(Number(body.rowVersion))
    );
  });
  app.post('/api/v1/ozon/runtime/jobs/:id/recover-known-pre-platform-failure', async (request) => {
    requireRuntimeKey(request);
    const body = objectValue(request.body);
    const reason = String(body.reason || '').trim() as OzonKnownPrePlatformFailureReason;
    if (!OZON_KNOWN_PRE_PLATFORM_FAILURE_REASONS.includes(reason)) {
      throw new AppError('CONFIG_INVALID', '不支持的 OZON 已知预平台代码故障恢复原因', { reason });
    }
    return ozonPublishing.recoverKnownPrePlatformFailure(
      (request.params as { id: string }).id,
      {
        reason,
        rowVersion: requiredVersion(Number(body.rowVersion)),
        ...(body.listingRowVersion === undefined
          ? {}
          : { listingRowVersion: requiredVersion(Number(body.listingRowVersion)) }),
        dryRun: optionalBoolean(body.dryRun, 'dryRun') ?? true
      }
    );
  });
  app.post('/api/v1/ozon/runtime/jobs/:id/recover-known-post-platform-min-price-failure', async (request) => {
    requireRuntimeKey(request);
    const body = objectValue(request.body);
    const reason = String(body.reason || '').trim();
    if (reason !== OZON_KNOWN_POST_PLATFORM_MIN_PRICE_FAILURE_REASON) {
      throw new AppError('CONFIG_INVALID', '不支持的 OZON 已知平台后最低价故障恢复原因', { reason });
    }
    return ozonPublishing.recoverKnownPostPlatformMinPriceFailure(
      (request.params as { id: string }).id,
      {
        reason,
        rowVersion: requiredVersion(Number(body.rowVersion)),
        listingRowVersion: requiredVersion(Number(body.listingRowVersion)),
        dryRun: optionalBoolean(body.dryRun, 'dryRun') ?? true
      } as OzonKnownPostPlatformMinPriceRecoveryInput
    );
  });
  app.get('/api/v1/ozon/mappings/:storeAlias/:offerId', async (request) => {
    const params = request.params as { storeAlias: string; offerId: string };
    return { mapping: await ozon.getProductMapping(params.storeAlias, params.offerId) };
  });
}

function numberValue(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function materialPersistenceResponse(listing: Awaited<ReturnType<OzonPublishingService['createListing']>>) {
  const generatedVersionId = String(listing.generatedVersionId || '').trim();
  const materialHash = String(listing.materialHash || '').trim();
  const materialHashVersion = String(listing.materialHashVersion || '').trim();
  const contentPolicyVersion = String(listing.contentPolicyVersion || '').trim();
  const materialRevision = Number(listing.materialRevision || listing.revision);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(generatedVersionId)
    || !/^sha256:[a-f0-9]{64}$/.test(materialHash)
    || materialHashVersion !== 'ozon-shared-material-v1'
    || !['merchroute-ozon-content-v2', 'merchroute-ozon-content-v3'].includes(contentPolicyVersion)
    || !Number.isInteger(materialRevision) || materialRevision < 1) {
    throw new AppError('VERSION_CONFLICT', 'OZON 公共素材未原子生成可证明的稳定版本', {
      sku: listing.sku,
      generatedVersionId,
      materialRevision,
      materialHash,
      materialHashVersion,
      contentPolicyVersion
    }, 409);
  }
  return {
    listing,
    generatedVersionId,
    materialRevision,
    materialHash,
    materialHashVersion,
    contentPolicyVersion
  };
}

function requiredVersion(value: number | undefined): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new AppError('CONFIG_INVALID', '缺少有效的 rowVersion');
  }
  return Number(value);
}

function requiredStoreId(value: unknown): string {
  const storeId = String(value || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(storeId)) {
    throw new AppError('CONFIG_INVALID', '缺少有效的 storeId');
  }
  return storeId;
}

function assertJobStoreIdentity(job: OzonPublishJob, storeId: string, jobId: string): void {
  if (String(job.storeId || '') !== storeId) {
    throw new AppError('NOT_FOUND', '该 OZON 任务不属于请求店铺', { jobId, storeId }, 404);
  }
}

export function parseRuntimeTransition(value: unknown) {
  const body = objectValue(value);
  const state = String(body.state || '') as OzonPublishJobState;
  if (!OZON_PUBLISH_JOB_STATES.includes(state)) {
    throw new AppError('CONFIG_INVALID', 'OZON 任务状态无效', { state });
  }
  return {
    rowVersion: requiredVersion(Number(body.rowVersion)),
    state,
    eventType: String(body.eventType || 'N8N_STATUS_UPDATED').trim(),
    message: String(body.message || 'n8n 已更新 OZON 任务状态').trim(),
    payload: objectValue(body.payload),
    stageStates: stringRecord(body.stageStates),
    taskId: optionalString(body.taskId),
    importTaskId: optionalString(body.importTaskId),
    ozonProductId: optionalString(body.ozonProductId),
    errorCode: optionalString(body.errorCode),
    errorMessage: optionalString(body.errorMessage),
    jobPayload: objectValue(body.jobPayload),
    nextAttemptAt: optionalRuntimeDate(body.nextAttemptAt),
    incrementRetry: optionalBoolean(body.incrementRetry, 'incrementRetry'),
    auditSuppressed: optionalBoolean(body.auditSuppressed, 'auditSuppressed'),
    leaseOwner: optionalString(body.leaseOwner),
    leaseToken: optionalString(body.leaseToken),
    clearLease: optionalBoolean(body.clearLease, 'clearLease'),
    networkRecovery: optionalNetworkRecovery(body.networkRecovery),
    offerId: optionalString(body.offerId),
    offerIds: stringArray(body.offerIds),
    storeAlias: optionalString(body.storeAlias),
    ozonSku: optionalString(body.ozonSku),
    warehouseId: optionalString(body.warehouseId),
    lastAppliedRevision: numberValue(body.lastAppliedRevision),
    platformStatus: optionalString(body.platformStatus),
    productMappings: productMappings(body.productMappings),
    revision: numberValue(body.revision),
    taskFolder: optionalString(body.taskFolder),
    workRelPath: optionalString(body.workRelPath),
    directoryStage: optionalString(body.directoryStage) as OzonTaskDirectoryStage | undefined,
    directorySignature: optionalString(body.directorySignature || body.signature)
  };
}

function optionalNetworkRecovery(value: unknown): OzonNetworkRecovery | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const body = objectValue(value);
  const resumeState = String(body.resumeState || '') as OzonPublishJobState;
  if (body.schemaVersion !== 1 || body.status !== 'WAITING_NETWORK' || !OZON_PUBLISH_JOB_STATES.includes(resumeState)) {
    throw new AppError('CONFIG_INVALID', 'networkRecovery 合同无效', { value });
  }
  const deliveryState = String(body.deliveryState || '');
  if (!['NOT_SENT', 'UNKNOWN', 'RESPONDED'].includes(deliveryState)) {
    throw new AppError('CONFIG_INVALID', 'networkRecovery.deliveryState 无效', { deliveryState });
  }
  const phase = requiredRuntimeString(body.phase, 'networkRecovery.phase');
  const attempt = optionalPositiveInteger(body.attempt, 'networkRecovery.attempt');
  if (!attempt) throw new AppError('CONFIG_INVALID', 'networkRecovery.attempt 必须大于 0');
  return {
    schemaVersion: 1,
    status: 'WAITING_NETWORK',
    phase,
    resumeState,
    deliveryState: deliveryState as OzonNetworkRecovery['deliveryState'],
    attempt,
    firstFailureAt: requiredRuntimeDate(body.firstFailureAt, 'networkRecovery.firstFailureAt'),
    lastFailureAt: requiredRuntimeDate(body.lastFailureAt, 'networkRecovery.lastFailureAt'),
    nextAttemptAt: requiredRuntimeDate(body.nextAttemptAt, 'networkRecovery.nextAttemptAt'),
    errorCode: requiredRuntimeString(body.errorCode, 'networkRecovery.errorCode'),
    errorMessage: requiredRuntimeString(body.errorMessage, 'networkRecovery.errorMessage'),
    ...(body.retryAfterMs === undefined ? {} : { retryAfterMs: optionalNonNegativeNumber(body.retryAfterMs, 'networkRecovery.retryAfterMs') }),
    ...(Object.keys(objectValue(body.checkpoint)).length ? { checkpoint: objectValue(body.checkpoint) } : {})
  };
}

function requiredRuntimeString(value: unknown, field: string): string {
  const result = String(value || '').trim();
  if (!result) throw new AppError('CONFIG_INVALID', `${field} 不能为空`, { [field]: value });
  return result;
}

function requiredRuntimeDate(value: unknown, field: string): string {
  const raw = requiredRuntimeString(value, field);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) throw new AppError('CONFIG_INVALID', `${field} 必须是有效日期`, { [field]: value });
  return new Date(timestamp).toISOString();
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const result = Number(value);
  if (!Number.isInteger(result) || result <= 0) throw new AppError('CONFIG_INVALID', `${field} 必须是正整数`, { [field]: value });
  return result;
}

function optionalNonNegativeNumber(value: unknown, field: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new AppError('CONFIG_INVALID', `${field} 必须是非负数`, { [field]: value });
  return result;
}

function optionalRuntimeDate(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError('CONFIG_INVALID', 'nextAttemptAt 必须是有效日期或 null', { nextAttemptAt: value });
  }
  const timestamp = Date.parse(value.trim());
  if (!Number.isFinite(timestamp)) {
    throw new AppError('CONFIG_INVALID', 'nextAttemptAt 必须是有效日期或 null', { nextAttemptAt: value });
  }
  return new Date(timestamp).toISOString();
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new AppError('CONFIG_INVALID', `${field} 必须是布尔值`, { [field]: value });
  }
  return value;
}

function productMappings(value: unknown): OzonProductMappingInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const source = objectValue(entry);
    const offerId = optionalString(source.offerId || source.offer_id);
    const ozonProductId = optionalString(source.ozonProductId || source.productId || source.product_id);
    if (!offerId || !ozonProductId) return [];
    return [{
      offerId,
      ozonProductId,
      ...(optionalString(source.ozonSku || source.sku) ? { ozonSku: optionalString(source.ozonSku || source.sku)! } : {}),
      ...(optionalString(source.warehouseId || source.warehouse_id) ? { warehouseId: optionalString(source.warehouseId || source.warehouse_id)! } : {}),
      ...(optionalString(source.platformStatus || source.status) ? { platformStatus: optionalString(source.platformStatus || source.status)! } : {}),
      ...(Object.keys(objectValue(source.statusSnapshot || source.status_snapshot)).length
        ? { statusSnapshot: objectValue(source.statusSnapshot || source.status_snapshot) }
        : {})
    }];
  });
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean))];
}

function parseRange(value: string, fileSize: number): { start: number; end: number } {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) throw new AppError('CONFIG_INVALID', '视频 Range 请求格式无效', undefined, 416);
  const start = match[1] ? Number(match[1]) : Math.max(0, fileSize - Number(match[2] || 0));
  const end = match[2] && match[1] ? Number(match[2]) : fileSize - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= fileSize) {
    throw new AppError('CONFIG_INVALID', '视频 Range 超出文件范围', { fileSize }, 416);
  }
  return { start, end: Math.min(end, fileSize - 1) };
}

function optionalString(value: unknown): string | undefined {
  const parsed = String(value ?? '').trim();
  return parsed || undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function publicationWorkflowRequired(sku: string, action: string): AppError {
  return new AppError(
    'OZON_PUBLICATION_REQUIRED',
    `${action}必须使用按店铺冻结的 publication API；旧 SKU 单店写入口已停用`,
    {
      sku,
      planPath: `/api/v1/ozon/listings/${encodeURIComponent(sku)}/publication-plans`,
      createPath: `/api/v1/ozon/listings/${encodeURIComponent(sku)}/publications`
    },
    409
  );
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, String(entry)]));
}

function parseOzonPreset(input: unknown, update: false): OzonPresetInput;
function parseOzonPreset(input: unknown, update: true): OzonPresetInput & { rowVersion: number };
function parseOzonPreset(input: unknown, update: boolean): OzonPresetInput | (OzonPresetInput & { rowVersion: number }) {
  const parsed = (update ? ozonPresetUpdateSchema : ozonPresetInputSchema).safeParse(input);
  if (!parsed.success) {
    throw new AppError(
      'CONFIG_INVALID',
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('；'),
      { issues: parsed.error.issues }
    );
  }
  return parsed.data;
}

export async function assertOzonPresetPricingChain(
  pricing: PricingRepository,
  shipping: ShippingRepository,
  definition: Pick<OzonPresetInput, 'pricingTemplateId' | 'shippingTemplateId' | 'shippingServiceCode' | 'destinationCountryCode'>
): Promise<void> {
  const [pricingTemplate, shippingTemplate] = await Promise.all([
    pricing.getTemplate(definition.pricingTemplateId),
    shipping.getTemplate(definition.shippingTemplateId)
  ]);
  const pricingPublished = pricingTemplate.versions.find((version) => version.status === 'PUBLISHED');
  if (!pricingTemplate.active || !pricingPublished) {
    throw new AppError('PRICING_TEMPLATE_UNAVAILABLE', 'OZON 默认定价模板不存在、未发布或已停用', { pricingTemplateId: definition.pricingTemplateId }, 409);
  }
  if (String(pricingTemplate.platformCode).toUpperCase() !== 'OZON') {
    throw new AppError('PRICING_PLATFORM_MISMATCH', 'OZON 上品预设只能选择 OZON 平台定价模板', { pricingTemplateId: definition.pricingTemplateId, platformCode: pricingTemplate.platformCode }, 409);
  }
  const shippingPublished = shippingTemplate.versions.find((version) => version.status === 'PUBLISHED');
  if (!shippingTemplate.active || !shippingTemplate.carrierActive || !shippingPublished) {
    throw new AppError('SHIPPING_TEMPLATE_UNAVAILABLE', 'OZON 默认运费模板不存在、未发布或已停用', { shippingTemplateId: definition.shippingTemplateId }, 409);
  }
  if (String(shippingTemplate.platformCode).toUpperCase() !== 'OZON') {
    throw new AppError('SHIPPING_PLATFORM_MISMATCH', 'OZON 上品预设只能选择 OZON 平台运费模板', { shippingTemplateId: definition.shippingTemplateId, platformCode: shippingTemplate.platformCode }, 409);
  }
  const services: ShippingService[] = Array.isArray(shippingPublished.definition.services) ? shippingPublished.definition.services : [];
  const selectedService = services.find((service) => String(service.code || '').toUpperCase() === definition.shippingServiceCode);
  if (!selectedService) {
    throw new AppError('SHIPPING_SERVICE_NOT_FOUND', '所选服务渠道不属于当前 OZON 运费模板的已发布版本', { shippingTemplateId: definition.shippingTemplateId, shippingServiceCode: definition.shippingServiceCode }, 409);
  }
  const destinationCodes = [...new Set(selectedService.rules.flatMap((rule) => rule.destinationCountryCodes || []).map((code) => String(code).toUpperCase()))];
  if (destinationCodes.length && !definition.destinationCountryCode) {
    throw new AppError('DESTINATION_REQUIRED', '所选 OZON 服务渠道要求选择目的国家', { shippingServiceCode: definition.shippingServiceCode, destinationCodes }, 409);
  }
  if (definition.destinationCountryCode && destinationCodes.length && !destinationCodes.includes(definition.destinationCountryCode)) {
    throw new AppError('DESTINATION_UNSUPPORTED', '所选 OZON 服务渠道不支持当前目的国家', { shippingServiceCode: definition.shippingServiceCode, destinationCountryCode: definition.destinationCountryCode }, 409);
  }
}
