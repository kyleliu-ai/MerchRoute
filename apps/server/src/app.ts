import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import pino from 'pino';
import sharp from 'sharp';
import { APP_VERSION, AppError, E001_VARIANT_MAX_IMAGE_COUNT, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, appConfigSchema, workflowParameterFileName, workflowParameterOptionsFileName, pricingBatchCalculationInputSchema, pricingCalculationInputSchema, pricingProductQueryInputSchema, shippingCalculationInputSchema, type AppConfig, type OzonCatalogDictionaryValue, type OzonColorIdentity, type PendingSubmission, type ProductVariant, type ReviewRecord, type StageConfig, type VariantSelectionGroup, type WbColorIdentity, type WorkflowParameterOptions, type WorkflowParameters } from '@n8n-media-review/shared';
import { ConfigService, parseOzonMediaOutputRootTemplate, parseWbMediaOutputRootTemplate } from './config/service.js';
import { StateStore } from './repositories/store.js';
import { ScannerService } from './services/scanner/index.js';
import { ThumbnailService } from './services/thumbnails/index.js';
import { SubmissionService } from './services/submissions/index.js';
import { PurchaseRepository, normalizeProductVariantKey, validateProductVariantName, type DownloadBatchItemInput, type NotificationQuery, type PurchaseInput, type ProductIdentityRecord, type WorkflowInput } from './repositories/purchases.js';
import { DownloadWorker } from './services/downloads/index.js';
import { ShippingRepository, type CarrierInput, type TemplateInput } from './repositories/shipping.js';
import { PricingRepository, type PricingTemplateInput } from './repositories/pricing.js';
import { ProductPricingQueryService } from './services/pricing/product-query.js';
import { ProductIdentityService } from './services/product-identity/index.js';
import { WbRepository } from './repositories/wb.js';
import { WbPresetRepository } from './repositories/wb-presets.js';
import { WbAutoPublishRepository } from './repositories/wb-auto-publish.js';
import { WbStoreRepository } from './repositories/wb-stores.js';
import { WbSourceMediaCleanupRepository } from './repositories/wb-source-media-cleanup.js';
import { WbPublishingService } from './services/wb-publishing/index.js';
import { WbTaskStatusSynchronizer } from './services/wb-publishing/status-synchronizer.js';
import { WbPresetService } from './services/wb-presets/index.js';
import { WbCatalogService } from './services/wb-catalog/index.js';
import { registerWbRoutes } from './routes/wb.js';
import { registerWbStoreRoutes } from './routes/wb-stores.js';
import { OzonRepository } from './repositories/ozon.js';
import { OzonStoreRepository } from './repositories/ozon-stores.js';
import { OzonSourceMediaCleanupRepository } from './repositories/ozon-source-media-cleanup.js';
import { OzonPublishingService } from './services/ozon-publishing/index.js';
import { OzonStoreService } from './services/ozon-stores/index.js';
import { OzonStoreGatewayService } from './services/ozon-stores/gateway.js';
import { OzonSourceMediaCleanupService } from './services/ozon-source-media/index.js';
import { OzonSourceMediaFiles } from './services/ozon-source-media/source-files.js';
import { OzonAutoPublishingCoordinator } from './services/ozon-publishing/auto-publishing.js';
import { OzonTitleTranslationClient } from './services/ozon-publishing/title-translation.js';
import { OzonCatalogService } from './services/ozon-catalog/index.js';
import { registerOzonRoutes } from './routes/ozon.js';
import { registerOzonStoreRoutes } from './routes/ozon-stores.js';
import { TerminalDeliveryError, VariantMediaDeliveryService } from './services/variant-delivery/index.js';
import { WbAutoPublishingCoordinator } from './services/wb-auto-publish/index.js';
import { E003DescriptionSourceService } from './services/wb-presets/e003-description.js';
import { assertSafeDownloadRoot } from './utils/download-path-safety.js';
import { applyPurchaseUrlDownloadWorkflow } from './utils/purchase-download-workflow.js';
import { MediaIndexService } from './services/media-index/index.js';
import { MediaIndexEventHub } from './utils/server-events.js';
import { WbStoreService } from './services/wb-stores/index.js';
import { WbStoreGatewayService } from './services/wb-stores/gateway.js';
import { WbSourceMediaCleanupService } from './services/wb-source-media/index.js';
import { WbSourceMediaFiles } from './services/wb-source-media/source-files.js';
import { LocalImportService, assertStrictDirectory } from './services/local-import/index.js';
import { createAboutVersionService, type AboutVersionService } from './services/about-version.js';

type Services = {
  aboutVersion: AboutVersionService;
  config: ConfigService;
  store: StateStore;
  scanner: ScannerService;
  mediaIndex: MediaIndexService;
  thumbnails: ThumbnailService;
  submissions: SubmissionService;
  purchases: PurchaseRepository;
  localImports: LocalImportService;
  downloads: DownloadWorker;
  shipping: ShippingRepository;
  pricing: PricingRepository;
  pricingQuery: ProductPricingQueryService;
  productIdentity: ProductIdentityService;
  wb: WbRepository;
  wbPresetRepository: WbPresetRepository;
  wbPresets: WbPresetService;
  wbPublishing: WbPublishingService;
  wbTaskStatusSynchronizer: WbTaskStatusSynchronizer;
  wbAutoPublishRepository: WbAutoPublishRepository;
  wbAutoPublishing: WbAutoPublishingCoordinator;
  wbStoreRepository: WbStoreRepository;
  wbStores: WbStoreService;
  wbStoreGateway: WbStoreGatewayService;
  wbSourceMediaCleanup: WbSourceMediaCleanupService;
  wbCatalog: WbCatalogService;
  ozon: OzonRepository;
  ozonStoreRepository: OzonStoreRepository;
  ozonStores: OzonStoreService;
  ozonStoreGateway: OzonStoreGatewayService;
  ozonSourceMediaCleanup: OzonSourceMediaCleanupService;
  ozonPublishing: OzonPublishingService;
  ozonAutoPublishing: OzonAutoPublishingCoordinator;
  ozonCatalog: OzonCatalogService;
  variantDelivery: VariantMediaDeliveryService;
};

declare module 'fastify' {
  interface FastifyInstance { services: Services }
}

export type BuildAppOptions = {
  databaseUrl?: string | null;
  aboutVersion?: AboutVersionService;
};

export async function buildApp(options: BuildAppOptions = {}) {
  const hasExplicitDatabaseUrl = Object.prototype.hasOwnProperty.call(options, 'databaseUrl');
  if (process.env.VITEST && !hasExplicitDatabaseUrl) {
    throw new Error('测试环境必须显式传入 databaseUrl，禁止隐式连接生产 DATABASE_URL');
  }
  const databaseUrl = options.databaseUrl === null ? '' : options.databaseUrl ?? process.env.DATABASE_URL;
  const config = new ConfigService();
  await config.initialize();
  const aboutVersion = options.aboutVersion ?? createAboutVersionService({
    repoRoot: path.resolve(import.meta.dirname, '../../..'),
    configVersion: APP_VERSION
  });
  const store = new StateStore(config.appDataDir);
  await store.initialize();
  const scanner = new ScannerService(config, store);
  const thumbnails = new ThumbnailService(config, scanner);
  const logDirectory = path.join(config.appDataDir, 'logs');
  await mkdir(logDirectory, { recursive: true });
  const logDate = new Date().toISOString().slice(0, 10);
  const logger = pino(
    { level: process.env.LOG_LEVEL || 'info', base: { app: 'n8n-media-review-center', version: APP_VERSION } },
    pino.destination({ dest: path.join(logDirectory, `app-${logDate}.log`), mkdir: true, sync: false })
  );
  const app = Fastify({ loggerInstance: logger, bodyLimit: 5 * 1024 * 1024 });
  const mediaIndex = new MediaIndexService(config, scanner, app.log, { databaseUrl });
  await mediaIndex.initialize();
  const mediaIndexEvents = new MediaIndexEventHub();
  const unsubscribeMediaIndexEvents = mediaIndex.onChange(({ stageId, state }) => {
    mediaIndexEvents.publish({ type: 'index-changed', stageId, state });
  });
  const unsubscribeReviewEvents = store.subscribe(() => {
    for (const stage of config.get().stages.filter((item) => item.enabled && item.reviewEnabled)) {
      mediaIndexEvents.publish({ type: 'review-state-changed', stageId: stage.id, state: mediaIndex.getState(stage.id) });
    }
  });
  const synchronizeMediaIndexConfig = async (): Promise<void> => {
    await mediaIndex.syncConfig().catch((error) => app.log.warn({ err: error }, '媒体索引配置同步失败，将保留上一份可用索引'));
  };
  const purchases = new PurchaseRepository(databaseUrl);
  await purchases.initialize();
  if (purchases.configured && config.didMigrateLegacyConfig) await config.mergeLegacyDownloadWorkflows(await purchases.listWorkflows(true));
  await migratePendingWorkflowParameters(config, store);
  const productIdentity = new ProductIdentityService(purchases, store);
  await productIdentity.backfillLegacyPending();
  await productIdentity.backfillLegacyVariants();
  const submissions = new SubmissionService(config, store, scanner, productIdentity, app.log);
  const localImports = new LocalImportService(config, purchases, () => mediaIndex.refreshStage('E000'));
  let downloadSync = await synchronizeDownloadProjection(config, purchases);
  if (!purchases.configured) app.log.warn('未配置 DATABASE_URL；采购管理暂不可用，下载工作流配置将在数据库连接后同步');
  const downloads = new DownloadWorker(purchases, app.log, () => downloadWorkflowInputs(config.get()));
  const shipping = new ShippingRepository(databaseUrl);
  await shipping.initialize();
  if (!shipping.configured) app.log.warn('未配置 DATABASE_URL；运费模板与运费计算暂不可用');
  const pricing = new PricingRepository(databaseUrl);
  await pricing.initialize();
  if (!pricing.configured) app.log.warn('未配置 DATABASE_URL；定价模板与售价计算暂不可用');
  const pricingQuery = new ProductPricingQueryService(purchases, pricing);
  const wb = new WbRepository(databaseUrl);
  await wb.initialize();
  if (!wb.configured) app.log.warn('未配置 DATABASE_URL；WB 类目、草稿与上品任务暂不可用');
  const wbPublishing = new WbPublishingService(config, wb, undefined, purchases);
  const wbPresetRepository = new WbPresetRepository(databaseUrl);
  await wbPresetRepository.initialize();
  const wbPresets = new WbPresetService(wbPresetRepository, wb, purchases, pricing, wbPublishing.n8n, config);
  const wbStoreRepository = new WbStoreRepository(databaseUrl);
  await wbStoreRepository.initialize();
  const wbAutoPublishRepository = new WbAutoPublishRepository(databaseUrl);
  await wbAutoPublishRepository.initialize();
  const wbSourceMediaCleanupRepository = new WbSourceMediaCleanupRepository(databaseUrl);
  await wbSourceMediaCleanupRepository.initialize();
  const wbSourceMediaCleanup = new WbSourceMediaCleanupService(wbSourceMediaCleanupRepository, new WbSourceMediaFiles(), app.log);
  const wbStores = new WbStoreService(wbStoreRepository, wbPresets, wbPublishing, wbSourceMediaCleanup);
  const wbStoreGateway = new WbStoreGatewayService(wbStoreRepository, wbStores);
  const wbAutoPublishing = new WbAutoPublishingCoordinator(
    wbAutoPublishRepository, wbPresets, wbPublishing, store, app.log, {}, wbStoreRepository, wbSourceMediaCleanup
  );
  const wbTaskStatusSynchronizer = new WbTaskStatusSynchronizer(wb, wbPublishing, app.log, {}, wbSourceMediaCleanup);
  wbPresets.setAutomationChangeHandler(() => wbAutoPublishing.handlePresetChanged());
  const variantDelivery = new VariantMediaDeliveryService(config);
  const backfillVariantColors = async (colors: WbColorIdentity[]) => {
    const updated = await purchases.backfillProductVariantColors(colors);
    if (updated) app.log.info({ updated }, '历史产品变体 WB 颜色身份回填完成');
  };
  if (wb.configured && purchases.configured) {
    await backfillVariantColors(await wb.listCatalogColorIdentities()).catch((error) => app.log.warn({ err: error }, '启动时历史产品变体颜色回填失败'));
  }
  const wbCatalog = new WbCatalogService(wb, wbPublishing.n8n, config.appDataDir, app.log, { onCatalogReady: backfillVariantColors });
  const ozon = new OzonRepository(databaseUrl);
  await ozon.initialize();
  if (!ozon.configured) app.log.warn('未配置 DATABASE_URL；OZON 类目、草稿、预设与上品任务暂不可用');
  const ozonDescriptions = new E003DescriptionSourceService(config);
  const ozonTitleTranslator = new OzonTitleTranslationClient();
  const ozonPublishing = new OzonPublishingService(
    ozon,
    purchases,
    app.log,
    pricing,
    ozonDescriptions,
    ozonTitleTranslator
  );
  const ozonStoreRepository = new OzonStoreRepository(databaseUrl);
  await ozonStoreRepository.initialize();
  const ozonSourceMediaCleanupRepository = new OzonSourceMediaCleanupRepository(databaseUrl);
  await ozonSourceMediaCleanupRepository.initialize();
  const ozonSourceMediaCleanup = new OzonSourceMediaCleanupService(
    ozonSourceMediaCleanupRepository,
    new OzonSourceMediaFiles(),
    app.log
  );
  const ozonStores = new OzonStoreService(ozonStoreRepository, ozon, ozonPublishing);
  ozonStores.setSourceMediaCleanup(ozonSourceMediaCleanup);
  const ozonStoreGateway = new OzonStoreGatewayService(ozonStoreRepository, ozonStores);
  const ozonAutoPublishing = new OzonAutoPublishingCoordinator(
    ozon,
    ozonPublishing,
    purchases,
    pricing,
    ozonDescriptions,
    ozonTitleTranslator,
    store,
    app.log,
    {},
    {
      storeRepository: ozonStoreRepository,
      storeService: ozonStores,
      storeGateway: {
        proveStoreOfferAbsence: (input) => ozonStoreGateway.proveStoreOfferAbsence(input),
        proveExactNoBrandDictionaryValue: (input) => ozonStoreGateway.proveExactNoBrandDictionaryValue(input)
      }
    }
  );
  const ozonCatalog = new OzonCatalogService(ozon, config.appDataDir, app.log);
  const configuredOzonTemplate = config.get().stages.find((stage) => stage.id === 'E004')?.ozonOutputRoot;
  if (ozon.configured && configuredOzonTemplate) {
    const rootDirectory = parseOzonMediaOutputRootTemplate(configuredOzonTemplate).rootDirectory;
    await ozonPublishing.synchronizeRootDirectory(rootDirectory).catch((error) => app.log.warn({ err: error, rootDirectory }, 'OZON 共享媒体根目录启动同步失败'));
  }
  app.decorate('services', { aboutVersion, config, store, scanner, mediaIndex, thumbnails, submissions, purchases, localImports, downloads, shipping, pricing, pricingQuery, productIdentity, wb, wbPresetRepository, wbPresets, wbPublishing, wbTaskStatusSynchronizer, wbAutoPublishRepository, wbAutoPublishing, wbStoreRepository, wbStores, wbStoreGateway, wbSourceMediaCleanup, wbCatalog, ozon, ozonStoreRepository, ozonStores, ozonStoreGateway, ozonSourceMediaCleanup, ozonPublishing, ozonAutoPublishing, ozonCatalog, variantDelivery });
  await app.register(cors, { origin: /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/ });

  app.setErrorHandler((error, _request, reply) => {
    const appError = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', error instanceof Error ? error.message : '服务器内部错误', undefined, 500);
    app.log.error({ err: error, code: appError.code }, appError.message);
    void reply.status(appError.statusCode).send({ error: { code: appError.code, message: appError.message, details: appError.details } });
  });

  app.get('/api/v1/health', async () => ({ status: 'ok', version: APP_VERSION, appDataDir: config.appDataDir, now: new Date().toISOString() }));
  app.get('/api/v1/about/version', async (request) => {
    const refresh = (request.query as { refresh?: unknown }).refresh;
    return await aboutVersion.check({ refresh: refresh === '1' || refresh === 'true' });
  });
  app.get('/api/v1/config', async () => ({
    config: config.get(),
    readiness: await configReadiness(config),
    downloadSync,
    wbPublishingReadiness: await wbPublishing.readiness(false),
    ozonPublishingReadiness: ozon.configured ? await ozonPublishing.readiness(false) : undefined
  }));
  app.put('/api/v1/config', async (request) => {
    const parsed = appConfigSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError('CONFIG_INVALID', '配置格式无效', { issues: parsed.error.issues });
    await assertSafeDownloadConfiguration(parsed.data, purchases);
    const mediaTemplate = parsed.data.stages.find((stage) => stage.id === 'E004')?.outputRoot;
    const linkedRootDirectory = mediaTemplate ? parseWbMediaOutputRootTemplate(mediaTemplate).rootDirectory : undefined;
    const linkedWbConfig = linkedRootDirectory ? { ...parsed.data.wbPublishing, rootDirectory: linkedRootDirectory } : parsed.data.wbPublishing;
    await wbPublishing.assertGeneralConfigChange(linkedWbConfig, linkedRootDirectory);
    const ozonTemplate = parsed.data.stages.find((stage) => stage.id === 'E004')?.ozonOutputRoot;
    const linkedOzonRootDirectory = ozonTemplate ? parseOzonMediaOutputRootTemplate(ozonTemplate).rootDirectory : undefined;
    const previousOzonRoot = ozon.configured ? (await ozonPublishing.readiness(false)).settings.rootDirectory : undefined;
    if (ozon.configured && linkedOzonRootDirectory) await ozonPublishing.synchronizeRootDirectory(linkedOzonRootDirectory);
    const removed = config.get().stages.filter((stage) => !parsed.data.stages.some((candidate) => candidate.id === stage.id));
    for (const stage of removed) await assertWorkflowCanBeDeleted(stage, parsed.data, config, store, purchases);
    let saved: AppConfig;
    try {
      saved = await config.save(parsed.data);
    } catch (error) {
      if (ozon.configured && previousOzonRoot !== undefined && linkedOzonRootDirectory && previousOzonRoot !== linkedOzonRootDirectory) {
        await ozonPublishing.synchronizeRootDirectory(previousOzonRoot).catch((rollbackError) => app.log.error({ err: rollbackError }, 'OZON 根目录配置补偿回滚失败'));
      }
      throw error;
    }
    for (const stage of removed) await config.archiveWorkflowParameterFiles(stage.id);
    await synchronizeMediaIndexConfig();
    downloads.stop();
    downloadSync = await synchronizeDownloadProjection(config, purchases, true);
    if (downloadSync.status === 'synced') downloads.start();
    await store.addEvent('CONFIG_SAVED', '系统配置已保存');
    return {
      config: saved,
      readiness: await configReadiness(config),
      downloadSync,
      wbPublishingReadiness: await wbPublishing.readiness(false),
      ozonPublishingReadiness: ozon.configured ? await ozonPublishing.readiness(false) : undefined
    };
  });
  app.post('/api/v1/workflows', async (request) => {
    const body = request.body as { stage?: unknown; copyFromStageId?: string };
    if (!body?.stage) throw new AppError('CONFIG_INVALID', '缺少工作流配置');
    await assertSafeDownloadStageCandidate(body.stage, purchases);
    const previous = config.get();
    const saved = await config.createWorkflow(body.stage, body.copyFromStageId);
    await synchronizeMediaIndexConfig();
    if (downloadProjectionChanged(previous, saved)) {
      downloads.stop();
      downloadSync = await synchronizeDownloadProjection(config, purchases, true);
      if (downloadSync.status === 'synced') downloads.start();
    }
    const stage = saved.stages.at(-1)!;
    await store.addEvent('WORKFLOW_CREATED', `工作流 ${stage.id} 已创建`, { stageId: stage.id, copyFromStageId: body.copyFromStageId });
    return { config: saved, workflow: stage, downloadSync };
  });
  app.patch('/api/v1/workflows/:stageId', async (request) => {
    const { stageId } = request.params as { stageId: string };
    const previous = config.get();
    const currentStage = previous.stages.find((stage) => stage.id === stageId);
    const stagePatch = request.body && typeof request.body === 'object' ? request.body as Partial<StageConfig> : {};
    if (currentStage) await assertSafeDownloadStageCandidate({ ...currentStage, ...stagePatch }, purchases);
    const saved = await config.updateWorkflow(stageId, request.body);
    await synchronizeMediaIndexConfig();
    if (downloadProjectionChanged(previous, saved)) {
      downloads.stop();
      downloadSync = await synchronizeDownloadProjection(config, purchases, true);
      if (downloadSync.status === 'synced') downloads.start();
    }
    await store.addEvent('WORKFLOW_UPDATED', `工作流 ${stageId} 已更新`, { stageId });
    return { config: saved, workflow: saved.stages.find((stage) => stage.id === stageId), downloadSync };
  });
  app.delete('/api/v1/workflows/:stageId', async (request) => {
    const { stageId } = request.params as { stageId: string };
    const previous = config.get();
    const stage = previous.stages.find((candidate) => candidate.id === stageId);
    if (!stage) throw new AppError('CONFIG_INVALID', '未知的工作流阶段', { stageId }, 404);
    await assertWorkflowCanBeDeleted(stage, undefined, config, store, purchases);
    const saved = await config.deleteWorkflow(stageId);
    await synchronizeMediaIndexConfig();
    if (downloadProjectionChanged(previous, saved)) {
      downloads.stop();
      downloadSync = await synchronizeDownloadProjection(config, purchases, true);
      if (downloadSync.status === 'synced') downloads.start();
    }
    await store.addEvent('WORKFLOW_DELETED', `工作流 ${stageId} 配置已删除`, { stageId });
    return { config: saved, deletedStageId: stageId, downloadSync };
  });
  app.put('/api/v1/workflow-groups', async (request) => {
    const body = request.body as { groups?: unknown; assignments?: unknown };
    const saved = await config.saveWorkflowGroups(body?.groups, body?.assignments);
    await synchronizeMediaIndexConfig();
    await store.addEvent('WORKFLOW_GROUPS_UPDATED', '工作流分组已更新');
    return { config: saved };
  });
  app.get('/api/v1/workflow-parameters/:stageId', async (request) => {
    const { stageId } = request.params as { stageId: string };
    const template = await config.getWorkflowParameterTemplate(stageId);
    return {
      stageId,
      fileName: workflowParameterFileName(stageId),
      optionsFileName: workflowParameterOptionsFileName(stageId),
      ...template
    };
  });
  app.put('/api/v1/workflow-parameters/:stageId', async (request) => {
    const { stageId } = request.params as { stageId: string };
    const body = request.body as { parameters?: unknown; parameterOptions?: unknown };
    const template = await config.saveWorkflowParameterTemplate(stageId, body?.parameters, body?.parameterOptions ?? {});
    await store.addEvent('WORKFLOW_PARAMETERS_SAVED', `工作流 ${stageId} 参数模板已保存`, { stageId, fieldCount: Object.keys(template.parameters).length, optionFieldCount: Object.keys(template.parameterOptions).length });
    return { stageId, fileName: workflowParameterFileName(stageId), optionsFileName: workflowParameterOptionsFileName(stageId), ...template };
  });
  app.post('/api/v1/config/validate', async (request) => {
    const body = request.body as { path?: string; localImportRole?: 'source' | 'candidate' };
    if (!body?.path) throw new AppError('CONFIG_INVALID', '缺少需要验证的目录路径');
    if (body.localImportRole) await assertStrictDirectory(body.path, body.localImportRole === 'candidate', body.localImportRole === 'source' ? '本地导入来源根目录' : 'E000 候选图片目录');
    return config.validatePath(body.path);
  });
  app.post('/api/v1/config/create-directory', async (request) => {
    const body = request.body as { path?: string };
    if (!body?.path) throw new AppError('CONFIG_INVALID', '缺少需要创建的目录路径');
    return config.createDirectory(body.path);
  });

  await registerWbRoutes(app, { wb, wbPublishing, wbCatalog, wbPresets, wbAutoPublishing, wbSourceMediaCleanup });
  await registerWbStoreRoutes(app, { stores: wbStores, gateway: wbStoreGateway });
  await registerOzonRoutes(app, { ozon, ozonStores, ozonPublishing, ozonAutoPublishing, ozonCatalog, ozonSourceMediaCleanup, pricing, shipping, config });
  await registerOzonStoreRoutes(app, { stores: ozonStores, gateway: ozonStoreGateway, sourceMediaCleanup: ozonSourceMediaCleanup });

  app.get('/api/v1/local-import/directories', async (request) => {
    const query = request.query as { path?: string };
    return localImports.listDirectories(query.path || '');
  });
  app.post('/api/v1/local-import/preview', async (request) => localImports.preview(request.body as any));
  app.get('/api/v1/local-import/imports', async (request) => {
    const query = request.query as { page?: string; pageSize?: string; query?: string; platform?: string; status?: string; createdFrom?: string; createdTo?: string };
    return localImports.list({
      page: Number(query.page), pageSize: Number(query.pageSize), query: query.query, platform: query.platform,
      status: query.status, createdFrom: query.createdFrom, createdTo: query.createdTo
    });
  });
  app.post('/api/v1/local-import/imports', async (request) => ({ import: await localImports.import(request.body as any) }));
  app.get('/api/v1/local-import/imports/:id', async (request) => ({ import: await localImports.get((request.params as { id: string }).id) }));
  app.patch('/api/v1/local-import/imports/:id/purchase', async (request) => ({
    import: await localImports.updatePurchase((request.params as { id: string }).id, request.body as Omit<PurchaseInput, 'downloadWorkflowCode'>)
  }));
  app.post('/api/v1/local-import/imports/:id/retry', async (request) => ({ import: await localImports.retry((request.params as { id: string }).id) }));

  app.get('/api/v1/purchases', async (request) => {
    const query = request.query as { page?: string; pageSize?: string; query?: string; status?: string; workflowCode?: string; createdFrom?: string; createdTo?: string; source?: string; entryMethodKey?: string; sort?: string };
    return purchases.listPurchases({
      page: Number(query.page), pageSize: Number(query.pageSize), query: query.query, status: query.status,
      workflowCode: query.workflowCode, createdFrom: query.createdFrom, createdTo: query.createdTo,
      source: query.source, entryMethodKey: query.entryMethodKey, sort: query.sort
    });
  });
  app.post('/api/v1/purchases', async (request) => ({
    purchase: await purchases.createPurchase(applyPurchaseUrlDownloadWorkflow(request.body as PurchaseInput))
  }));
  app.get('/api/v1/purchases/:sku', async (request) => ({ purchase: await purchases.getPurchase((request.params as { sku: string }).sku) }));
  app.patch('/api/v1/purchases/:sku', async (request) => ({
    purchase: await purchases.updatePurchase(
      (request.params as { sku: string }).sku,
      applyPurchaseUrlDownloadWorkflow(request.body as PurchaseInput)
    )
  }));
  app.post('/api/v1/purchases/:sku/downloads', async (request) => {
    const job = await purchases.enqueueDownload(
      (request.params as { sku: string }).sku,
      (request.body as { workflowCode?: string } | undefined)?.workflowCode,
      downloadWorkflowInputs(config.get())
    );
    void downloads.processNext();
    return { job };
  });
  app.get('/api/v1/purchase-download-jobs/:id', async (request) => ({ job: await purchases.getJob((request.params as { id: string }).id) }));
  app.post('/api/v1/purchase-download-jobs/batch', async (request) => {
    const result = await purchases.enqueueDownloadBatch(
      (request.body as { items?: DownloadBatchItemInput[] } | undefined)?.items || [],
      downloadWorkflowInputs(config.get())
    );
    void downloads.processNext();
    return result;
  });
  app.get('/api/v1/purchase-download-batches/:id', async (request) => ({ batch: await purchases.getDownloadBatch((request.params as { id: string }).id) }));

  app.get('/api/v1/notifications', async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return purchases.listNotifications({
      page: Number(query.page), pageSize: Number(query.pageSize), state: query.state as NotificationQuery['state'],
      severity: query.severity as NotificationQuery['severity'], category: query.category,
      sourceType: query.sourceType, eventType: query.eventType, createdFrom: query.createdFrom, createdTo: query.createdTo
    });
  });
  app.get('/api/v1/notifications/summary', async () => purchases.notificationSummary());
  app.patch('/api/v1/notifications/:id', async (request) => ({
    notification: await purchases.updateNotification((request.params as { id: string }).id, request.body as { read?: boolean; resolved?: boolean })
  }));
  app.post('/api/v1/notifications/read-all', async () => purchases.markAllNotificationsRead());
  app.post('/api/v1/notifications/:id/retry', async (request) => {
    const job = await purchases.retryNotification((request.params as { id: string }).id, downloadWorkflowInputs(config.get()));
    void downloads.processNext();
    return { job };
  });

  app.get('/api/v1/download-workflows', async (request) => {
    const { includeDisabled } = request.query as { includeDisabled?: string };
    return { items: await purchases.listWorkflows(includeDisabled !== 'false') };
  });
  app.post('/api/v1/download-workflows', async () => { throw new AppError('CONFIG_INVALID', '下载工作流已合并到系统设置，请从系统设置创建工作流', undefined, 410); });
  app.patch('/api/v1/download-workflows/:code', async () => { throw new AppError('CONFIG_INVALID', '下载工作流已合并到系统设置，请从系统设置修改工作流', undefined, 410); });

  app.get('/api/v1/shipping/carriers', async (request) => {
    const { includeInactive } = request.query as { includeInactive?: string };
    return { items: await shipping.listCarriers(includeInactive !== 'false') };
  });
  app.post('/api/v1/shipping/carriers', async (request) => ({ carrier: await shipping.createCarrier(request.body as CarrierInput) }));
  app.patch('/api/v1/shipping/carriers/:code', async (request) => ({ carrier: await shipping.updateCarrier((request.params as { code: string }).code, request.body as Partial<CarrierInput>) }));
  app.get('/api/v1/shipping/templates', async () => ({ items: await shipping.listTemplates() }));
  app.post('/api/v1/shipping/templates', async (request) => ({ template: await shipping.createTemplate(request.body as TemplateInput) }));
  app.get('/api/v1/shipping/templates/:id', async (request) => ({ template: await shipping.getTemplate((request.params as { id: string }).id) }));
  app.patch('/api/v1/shipping/templates/:id', async (request) => ({ template: await shipping.updateTemplate((request.params as { id: string }).id, request.body as { name?: string; active?: boolean }) }));
  app.patch('/api/v1/shipping/templates/:id/draft', async (request) => {
    const body = request.body as { definition?: unknown };
    if (!body || !Object.hasOwn(body, 'definition')) throw new AppError('CONFIG_INVALID', '缺少模板规则 definition');
    return { template: await shipping.saveDraft((request.params as { id: string }).id, body.definition) };
  });
  app.post('/api/v1/shipping/templates/:id/clone', async (request) => ({ template: await shipping.cloneTemplate((request.params as { id: string }).id, request.body as { carrierCode: string; name: string }) }));
  app.post('/api/v1/shipping/templates/:id/publish', async (request) => ({ template: await shipping.publishTemplate((request.params as { id: string }).id) }));
  app.post('/api/v1/shipping/calculate', async (request) => {
    const parsed = shippingCalculationInputSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError('CONFIG_INVALID', parsed.error.issues.map((issue) => issue.message).join('；'), { issues: parsed.error.issues });
    return shipping.calculate(parsed.data);
  });

  app.get('/api/v1/catalog/platforms', async (request) => {
    const { includeInactive } = request.query as { includeInactive?: string };
    return { items: await pricing.listPlatforms(includeInactive !== 'false') };
  });
  app.post('/api/v1/catalog/platforms', async (request) => ({ platform: await pricing.createPlatform(request.body) }));
  app.patch('/api/v1/catalog/platforms/:code', async (request) => ({ platform: await pricing.updatePlatform((request.params as { code: string }).code, request.body as any) }));
  app.get('/api/v1/catalog/currencies', async (request) => {
    const { includeInactive } = request.query as { includeInactive?: string };
    return { items: await pricing.listCurrencies(includeInactive !== 'false') };
  });
  app.post('/api/v1/catalog/currencies', async (request) => ({ currency: await pricing.createCurrency(request.body) }));
  app.patch('/api/v1/catalog/currencies/:code', async (request) => ({ currency: await pricing.updateCurrency((request.params as { code: string }).code, request.body as any) }));
  app.get('/api/v1/pricing/templates', async () => ({ items: await pricing.listTemplates() }));
  app.post('/api/v1/pricing/templates', async (request) => ({ template: await pricing.createTemplate(request.body as PricingTemplateInput) }));
  app.get('/api/v1/pricing/templates/:id', async (request) => ({ template: await pricing.getTemplate((request.params as { id: string }).id) }));
  app.patch('/api/v1/pricing/templates/:id', async (request) => ({ template: await pricing.updateTemplate((request.params as { id: string }).id, request.body as { name?: string; active?: boolean }) }));
  app.patch('/api/v1/pricing/templates/:id/draft', async (request) => ({ template: await pricing.saveDraft((request.params as { id: string }).id, (request.body as { definition?: unknown })?.definition) }));
  app.post('/api/v1/pricing/templates/:id/publish', async (request) => ({ template: await pricing.publishTemplate((request.params as { id: string }).id) }));
  app.post('/api/v1/pricing/templates/:id/clone', async (request) => ({ template: await pricing.cloneTemplate((request.params as { id: string }).id, request.body as { platformCode: string; name: string }) }));
  app.post('/api/v1/pricing/calculate', async (request) => {
    const parsed = pricingCalculationInputSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError('CONFIG_INVALID', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；'), { issues: parsed.error.issues });
    return pricing.calculate(parsed.data);
  });
  app.post('/api/v1/pricing/calculate-batch', async (request) => {
    const parsed = pricingBatchCalculationInputSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError('CONFIG_INVALID', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；'), { issues: parsed.error.issues });
    return pricing.calculateBatch(parsed.data);
  });
  app.post('/api/v1/pricing/query', async (request) => {
    const parsed = pricingProductQueryInputSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError('CONFIG_INVALID', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；'), { issues: parsed.error.issues });
    return pricingQuery.query(parsed.data);
  });

  app.get('/api/v1/stages', async () => {
    const stages = config.get().stages;
    const pendingSubmissionCounts = store.pendingSubmissionCountsBySourceStage();
    const items = [];
    for (const stage of stages) {
      const tasks = stage.enabled && stage.reviewEnabled ? await mediaIndex.listStageTasks(stage.id) : [];
      const index = mediaIndex.getState(stage.id);
      items.push({
        ...stage,
        summary: {
          pending: tasks.filter((item) => item.status === 'PENDING_REVIEW').length,
          drafts: tasks.filter((item) => item.status === 'DRAFT').length,
          approved: pendingSubmissionCounts.get(stage.id) || 0,
          queue: index.queueCount || 0,
          totalTasks: tasks.length,
          lastScannedAt: index.lastReconciledAt || null
        },
        index
      });
    }
    return { stages: items };
  });
  app.get('/api/v1/stages/:stageId/summary', async (request) => {
    const { stageId } = request.params as { stageId: string };
    requireEnabledStage(config, stageId);
    const tasks = await mediaIndex.listStageTasks(stageId);
    const byStatus = tasks.reduce<Record<string, typeof tasks>>((groups, item) => {
      (groups[item.status] ||= []).push(item);
      return groups;
    }, {});
    const index = mediaIndex.getState(stageId);
    return { stageId, total: tasks.length, byStatus, lastScannedAt: index.lastReconciledAt || null, index };
  });
  app.get('/api/v1/stages/:stageId/tasks', async (request) => {
    const { stageId } = request.params as { stageId: string };
    requireEnabledStage(config, stageId);
    const query = request.query as { search?: string; status?: string; sort?: string; order?: 'asc' | 'desc'; page?: string; pageSize?: string };
    let tasks = await mediaIndex.listStageTasks(stageId);
    if (query.search) tasks = tasks.filter((item) => item.sourceFolderName.toLocaleLowerCase().includes(query.search!.toLocaleLowerCase()));
    if (query.status) tasks = tasks.filter((item) => item.status === query.status);
    const field = query.sort === 'name' ? 'sourceFolderName' : 'lastModifiedAt';
    tasks.sort((a, b) => String(a[field]).localeCompare(String(b[field]), 'zh-CN', { numeric: true }) * (query.order === 'asc' ? 1 : -1));
    const page = Math.max(1, Number(query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize || 24)));
    return { items: tasks.slice((page - 1) * pageSize, page * pageSize), total: tasks.length, page, pageSize };
  });
  app.post('/api/v1/stages/rescan', async (_request, reply) => {
    const requestedAt = new Date().toISOString();
    void mediaIndex.refreshAll().catch((error) => app.log.error({ err: error }, '全部媒体索引后台校准失败'));
    return reply.code(202).send({ accepted: true, requestedAt });
  });
  app.post('/api/v1/stages/:stageId/rescan', async (request) => {
    const { stageId } = request.params as { stageId: string };
    requireEnabledStage(config, stageId);
    const tasks = await mediaIndex.refreshStage(stageId);
    await store.addEvent('STAGE_SCANNED', `${stageId} 已重新扫描`, { count: tasks.length });
    return { items: tasks, total: tasks.length, scannedAt: mediaIndex.getState(stageId).lastReconciledAt || new Date().toISOString() };
  });

  app.get('/api/v1/media-index/events', (request, reply) => {
    reply.hijack();
    const remove = mediaIndexEvents.add(reply.raw);
    request.raw.once('close', remove);
  });

  app.get('/api/v1/tasks/:taskId', taskDetailHandler);
  app.get('/api/v1/tasks/:taskId/tree', taskDetailHandler);
  app.get('/api/v1/tasks/:taskId/images', taskDetailHandler);
  app.put('/api/v1/tasks/:taskId/product-identity', async (request) => {
    const { taskId } = request.params as { taskId: string };
    const { sku } = (request.body || {}) as { sku?: string };
    const task = await scanner.getTask(taskId);
    const identity = await productIdentity.assignTask(task, String(sku || '').trim());
    await store.addEvent('PRODUCT_IDENTITY_ASSIGNED', `任务已关联采购 SKU ${identity.sku}`, { taskId, sku: identity.sku });
    return { productIdentity: identity };
  });

  app.get('/api/v1/tasks/:taskId/images/thumbnail', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const { path: relativePath } = request.query as { path?: string };
    if (!relativePath) throw new AppError('INVALID_RELATIVE_PATH', '缺少图片相对路径');
    const file = await thumbnails.get(taskId, relativePath);
    return reply.type('image/webp').header('Cache-Control', 'public, max-age=31536000, immutable').send(createReadStream(file));
  });
  app.get('/api/v1/tasks/:taskId/images/original', async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const { path: relativePath } = request.query as { path?: string };
    if (!relativePath) throw new AppError('INVALID_RELATIVE_PATH', '缺少图片相对路径');
    const { absolutePath: file } = await scanner.resolveIndexedMedia(taskId, relativePath);
    const ext = path.extname(file).toLocaleLowerCase('en-US');
    if (![...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS].includes(ext as any)) throw new AppError('UNSUPPORTED_FILE_TYPE', '不支持的媒体格式');
    const info = await stat(file);
    if (VIDEO_EXTENSIONS.includes(ext as any) && request.headers.range) {
      const range = parseHttpRange(request.headers.range, info.size);
      return reply.code(206).headers({ 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`, 'Content-Length': String(range.end - range.start + 1) }).type(mimeForExtension(ext)).send(createReadStream(file, { start: range.start, end: range.end }));
    }
    return reply.headers({ 'Content-Length': String(info.size), 'Accept-Ranges': VIDEO_EXTENSIONS.includes(ext as any) ? 'bytes' : 'none' }).type(mimeForExtension(ext)).send(createReadStream(file));
  });
  app.get('/api/v1/tasks/:taskId/images/metadata', async (request) => {
    const { taskId } = request.params as { taskId: string };
    const { path: relativePath } = request.query as { path?: string };
    if (!relativePath) throw new AppError('INVALID_RELATIVE_PATH', '缺少图片相对路径');
    const { absolutePath: file } = await scanner.resolveIndexedMedia(taskId, relativePath);
    const [metadata, info] = await Promise.all([sharp(file).metadata(), stat(file)]);
    await scanner.resolveIndexedMedia(taskId, relativePath);
    return { relativePath, width: metadata.width, height: metadata.height, format: metadata.format, sizeBytes: info.size, lastModifiedAt: info.mtime.toISOString() };
  });

  app.put('/api/v1/tasks/:taskId/draft', async (request) => {
    const { taskId } = request.params as { taskId: string };
    const body = request.body as { selectedRelativePaths?: string[]; selectedTargets?: string[]; variantSelectionGroups?: VariantSelectionGroup[] };
    const task = await scanner.getTask(taskId);
    const variantSelectionGroups = task.stageId === 'E001' ? await normalizeVariantSelectionGroupsDraft(task, body.variantSelectionGroups || [], wb, ozonCatalog) : undefined;
    const selected = variantSelectionGroups ? [...new Set(variantSelectionGroups.flatMap((group) => group.selectedRelativePaths))] : validateSelected(task, body.selectedRelativePaths || [], false);
    if (variantSelectionGroups?.length && variantSelectionGroups.every((group) => group.wbColor)) {
      const identity = await productIdentity.resolveTask(task);
      if (identity.status === 'RESOLVED' && identity.sku) {
        await purchases.ensureColoredProductVariants(identity.sku, variantSelectionGroups.map((group) => ({
          name: group.variantName,
          wbColor: group.wbColor!,
          ...(group.ozonColor ? { ozonColor: group.ozonColor } : {}),
          clearOzonColor: Boolean(group.ozonColorSuppressed)
        })));
      }
    }
    const now = new Date().toISOString();
    let saved!: ReviewRecord;
    await store.update((db) => {
      const existing = db.reviews.find((item) => item.taskId === taskId);
      saved = existing || { taskId, stageId: task.stageId, sourceFolder: task.sourceFolder, sourceFolderName: task.sourceFolderName, selectedRelativePaths: [], selectedTargetStageIds: [], status: 'DRAFT', createdAt: now, updatedAt: now };
      Object.assign(saved, { selectedRelativePaths: selected, selectedTargetStageIds: body.selectedTargets || saved.selectedTargetStageIds, variantSelectionGroups, status: 'DRAFT', updatedAt: now });
      if (!existing) db.reviews.push(saved);
    });
    await store.addEvent('DRAFT_SAVED', '审核草稿已保存', { taskId, selectedCount: selected.length });
    return { review: saved };
  });
  app.post('/api/v1/tasks/:taskId/approve', async (request) => {
    const { taskId } = request.params as { taskId: string };
    const body = request.body as { selectedRelativePaths?: string[]; targetStageIds?: string[]; variantSelectionGroups?: VariantSelectionGroup[] };
    const task = await scanner.getTask(taskId);
    const resolvedProduct = await productIdentity.requireResolvedTask(task);
    const stage = requireEnabledStage(config, task.stageId);
    assertTaskContextIdentity(task, resolvedProduct.identity);
    if (stage.id === 'E004' || stage.id === 'E005') {
      const selected = validateSelected(task, body.selectedRelativePaths || [], true);
      for (const relativePath of selected) await scanner.resolveIndexedMedia(taskId, relativePath);
      const variant = await resolveTaskVariant(purchases, task, resolvedProduct.identity);
      const requestedTargets = [...new Set(body.targetStageIds || [])];
      const targets = requestedTargets.length ? requestedTargets : ['WB_SHARED_MEDIA'];
      const supportedTargets = new Set(['WB_SHARED_MEDIA', 'OZON_SHARED_MEDIA']);
      if (targets.some((target) => !supportedTargets.has(target))) throw new AppError('CONFIG_INVALID', '至少选择一个有效的共享媒体平台');
      if (targets.includes('WB_SHARED_MEDIA') && !stage.outputRoot) throw new AppError('CONFIG_INVALID', `${stage.id} 尚未配置 WB 共享媒体输出目录模板`, undefined, 409);
      if (targets.includes('OZON_SHARED_MEDIA')) {
        if (!stage.ozonOutputRoot) throw new AppError('CONFIG_INVALID', `${stage.id} 尚未配置 OZON 共享媒体输出目录模板`, undefined, 409);
        if (!ozon.configured) throw new AppError('DATABASE_UNAVAILABLE', 'OZON 上品管理尚未配置 PostgreSQL DATABASE_URL', undefined, 503);
        const readiness = await ozonPublishing.readiness(false);
        if (!readiness.mediaReady) throw new AppError('CONFIG_INVALID', `OZON 共享媒体目录尚未就绪：${readiness.mediaIssues.join('；')}`, { readiness }, 409);
      }
      const records: Array<Awaited<ReturnType<VariantMediaDeliveryService['deliver']>>> = [];
      const failures: Array<Awaited<ReturnType<VariantMediaDeliveryService['deliver']>>> = [];
      let archived = false;
      for (const target of targets) {
        const platform = target === 'WB_SHARED_MEDIA' ? 'WB' : 'OZON';
        try {
          const record = await variantDelivery.deliver({ platform, task, stage, selectedRelativePaths: selected, productSku: resolvedProduct.identity.sku, productName: resolvedProduct.identity.productName, variantId: variant.variantId, variantName: variant.name, variantColor: variant.wbColor, sourceSubmissionId: task.taskContext?.sourceSubmissionId, archiveMedia: !archived });
          archived ||= Boolean(record.archiveFolder);
          records.push(record);
          await store.addEvent(`${platform}_MEDIA_DELIVERED`, `${stage.id} 审核媒体已投递到 ${platform} 共享媒体库`, { taskId, submissionId: record.submissionId, sku: resolvedProduct.identity.sku, variantName: variant.name, targetFolder: record.targetFolder });
          if (platform === 'WB') {
            await wbAutoPublishing.onMediaDelivered({ sku: resolvedProduct.identity.sku, stageId: stage.id, submissionId: record.submissionId, variantId: variant.variantId, deliveredAt: record.completedAt || record.startedAt })
              .catch((error) => app.log.warn({ err: error, sku: resolvedProduct.identity.sku, submissionId: record.submissionId }, 'WB 自动上品媒体事件入队失败'));
          } else {
            await ozonAutoPublishing.onMediaDelivered({ sku: resolvedProduct.identity.sku, stageId: stage.id, submissionId: record.submissionId, variantId: variant.variantId, deliveredAt: record.completedAt || record.startedAt, resolvedOutputRoot: record.resolvedOutputRoot, selectedRelativePaths: selected })
              .catch((error) => app.log.warn({ err: error, sku: resolvedProduct.identity.sku, submissionId: record.submissionId }, 'OZON 自动上品媒体事件入队失败'));
          }
        } catch (error) {
          if (!(error instanceof TerminalDeliveryError)) throw error;
          failures.push(error.record);
          await store.addEvent(`${platform}_MEDIA_DELIVERY_FAILED`, `${stage.id} ${platform} 共享媒体投递失败`, { taskId, submissionId: error.record.submissionId, error: error.message });
        }
      }
      const now = new Date().toISOString();
      await store.update((db) => {
        db.submissionHistory.unshift(...records, ...failures);
        let review = db.reviews.find((item) => item.taskId === taskId);
        if (!review) {
          review = { taskId, stageId: stage.id, sourceFolder: task.sourceFolder, sourceFolderName: task.sourceFolderName, selectedRelativePaths: selected, selectedTargetStageIds: targets, status: records.length ? 'SUBMITTED' : 'DRAFT', createdAt: now, updatedAt: now };
          db.reviews.push(review);
        }
        Object.assign(review, { selectedRelativePaths: selected, selectedTargetStageIds: targets, status: records.length ? 'SUBMITTED' : 'DRAFT', updatedAt: now, ...(records.length ? { approvedAt: now } : {}), productSku: resolvedProduct.identity.sku, productNameSnapshot: resolvedProduct.identity.productName, productIdentitySource: resolvedProduct.source, variantId: variant.variantId, variantName: variant.name });
      });
      if (!records.length) {
        const first = failures[0]!;
        throw new AppError(first.errorCode || 'COPY_FAILED', first.errorMessage || '共享媒体投递失败', { submissions: failures }, 409);
      }
      return {
        submission: records[0],
        submissions: [...records, ...failures],
        deliverySummary: { requested: targets.length, succeeded: records.length, failed: failures.length, status: failures.length ? 'PARTIAL' : 'SUCCESS' }
      };
    }
    let variantGroups = stage.id === 'E001' ? await validateVariantSelectionGroups(task, body.variantSelectionGroups || [], wb, ozonCatalog, resolvedProduct.identity.variants) : undefined;
    const selected = variantGroups ? [...new Set(variantGroups.flatMap((group) => group.selectedRelativePaths))] : validateSelected(task, body.selectedRelativePaths || [], true);
    for (const relativePath of selected) await scanner.resolveIndexedMedia(taskId, relativePath);
    const configuredTargets = new Set(stage.targets.map((item) => item.targetStageId));
    const enabledStageIds = new Set(config.get().stages.filter((item) => item.enabled).map((item) => item.id));
    const validTargets = new Set(stage.targets.filter((item) => enabledStageIds.has(item.targetStageId)).map((item) => item.targetStageId));
    const targets = [...new Set(body.targetStageIds || [])];
    if (targets.some((item) => configuredTargets.has(item) && !enabledStageIds.has(item))) {
      const targetStageId = targets.find((item) => configuredTargets.has(item) && !enabledStageIds.has(item))!;
      throw new AppError('STAGE_DISABLED', `目标流程 ${targetStageId} 已停用`, { stageId: targetStageId }, 409);
    }
    if (!targets.length || targets.some((item) => !validTargets.has(item))) throw new AppError('CONFIG_INVALID', '至少选择一个已启用的有效目标阶段');
    const inheritedVariant = stage.id === 'E002' || stage.id === 'E003' ? await resolveTaskVariant(purchases, task, resolvedProduct.identity) : undefined;
    const ensuredGroups = variantGroups ? await purchases.ensureColoredProductVariants(resolvedProduct.identity.sku, variantGroups.map((group) => ({
      name: group.variantName,
      wbColor: group.wbColor!,
      ...(group.ozonColor ? { ozonColor: group.ozonColor } : {}),
      clearOzonColor: Boolean(group.ozonColorSuppressed)
    }))) : undefined;
    const groupVariants = new Map(ensuredGroups?.filter((variant) => variant.wbColor).map((variant) => [variant.wbColor!.colorKey, variant]) || []);
    if (variantGroups) variantGroups = variantGroups.map((group) => {
      const variant = groupVariants.get(group.wbColor!.colorKey);
      return {
        ...group,
        variantName: variant?.name || group.variantName,
        ...(variant?.ozonColor ? { ozonColor: variant.ozonColor, ozonColorSuppressed: false } : {})
      };
    });
    const targetParameterDefaults = new Map<string, { parameters: WorkflowParameters; parameterOptions: WorkflowParameterOptions }>();
    for (const targetStageId of targets) {
      const template = await config.getWorkflowParameterTemplate(targetStageId);
      targetParameterDefaults.set(targetStageId, { ...template, parameters: inheritedVariant ? productIdentity.injectVariant(template.parameters, resolvedProduct.identity, inheritedVariant.name) : productIdentity.inject(template.parameters, resolvedProduct.identity) });
    }
    const now = new Date().toISOString();
    const pendingCreated: PendingSubmission[] = [];
    await store.update((db) => {
      let review = db.reviews.find((item) => item.taskId === taskId);
      if (!review) {
        review = { taskId, stageId: task.stageId, sourceFolder: task.sourceFolder, sourceFolderName: task.sourceFolderName, selectedRelativePaths: selected, selectedTargetStageIds: targets, status: 'APPROVED_PENDING_SUBMISSION', createdAt: now, updatedAt: now, approvedAt: now, productSku: resolvedProduct.identity.sku, productNameSnapshot: resolvedProduct.identity.productName, productIdentitySource: resolvedProduct.source, variantSelectionGroups: variantGroups, variantId: inheritedVariant?.variantId, variantName: inheritedVariant?.name };
        db.reviews.push(review);
      } else Object.assign(review, { selectedRelativePaths: selected, selectedTargetStageIds: targets, status: 'APPROVED_PENDING_SUBMISSION', updatedAt: now, approvedAt: now, productSku: resolvedProduct.identity.sku, productNameSnapshot: resolvedProduct.identity.productName, productIdentitySource: resolvedProduct.source, variantSelectionGroups: variantGroups, variantId: inheritedVariant?.variantId, variantName: inheritedVariant?.name });
      const desiredGroupIds = new Set(variantGroups?.map((group) => group.groupId) || []);
      db.pendingSubmissions = db.pendingSubmissions.filter((item) => !(item.taskId === taskId && (!targets.includes(item.targetStageId) || (variantGroups && (!item.variantGroupId || !desiredGroupIds.has(item.variantGroupId))))));
      const work = variantGroups || [{ groupId: undefined, variantName: inheritedVariant?.name, selectedRelativePaths: selected }];
      for (const group of work) {
        const variant = group.groupId && 'wbColor' in group && group.wbColor ? groupVariants.get(group.wbColor.colorKey) : inheritedVariant;
        if ((stage.id === 'E001' || stage.id === 'E002' || stage.id === 'E003') && !variant) throw new AppError('CONFIG_INVALID', '无法解析审核任务变体');
        for (const targetStageId of targets) {
          let pending = db.pendingSubmissions.find((item) => item.taskId === taskId && item.targetStageId === targetStageId && item.variantGroupId === group.groupId);
          const template = targetParameterDefaults.get(targetStageId)!;
          const parameters = variant ? productIdentity.injectVariant(template.parameters, resolvedProduct.identity, variant.name) : productIdentity.inject(template.parameters, resolvedProduct.identity);
          if (!pending) {
            pending = { id: randomUUID(), taskId, sourceStageId: task.stageId, targetStageId, selectedRelativePaths: group.selectedRelativePaths, n8nTaskParameters: structuredClone(parameters), n8nTaskParameterOptions: structuredClone(template.parameterOptions), conflictPolicy: 'new-revision', status: 'PENDING', productSku: resolvedProduct.identity.sku, productNameSnapshot: resolvedProduct.identity.productName, variantGroupId: group.groupId, variantId: variant?.variantId, variantName: variant?.name, createdAt: now, updatedAt: now };
            db.pendingSubmissions.push(pending);
          } else Object.assign(pending, { selectedRelativePaths: group.selectedRelativePaths, n8nTaskParameters: parameters, productSku: resolvedProduct.identity.sku, productNameSnapshot: resolvedProduct.identity.productName, variantId: variant?.variantId, variantName: variant?.name, status: 'PENDING', lastError: undefined, updatedAt: now });
          pendingCreated.push(pending);
        }
      }
    });
    await store.addEvent('REVIEW_APPROVED', '产品已审核并加入待投递清单', { taskId, targets, variantGroups: variantGroups?.map((group) => ({ groupId: group.groupId, variantName: group.variantName, selectedCount: group.selectedRelativePaths.length })) });
    return { pendingSubmissions: pendingCreated };
  });
  app.post('/api/v1/tasks/:taskId/reopen', async (request) => {
    const { taskId } = request.params as { taskId: string };
    const existingReview = store.read().reviews.find((item) => item.taskId === taskId);
    if (!existingReview) throw new AppError('CONFIG_INVALID', '审核记录不存在', { taskId }, 404);
    requireEnabledStage(config, existingReview.stageId);
    await store.update((db) => {
      const review = db.reviews.find((item) => item.taskId === taskId);
      if (!review) throw new AppError('CONFIG_INVALID', '审核记录不存在', { taskId }, 404);
      if (review.status === 'SUBMITTED') throw new AppError('CONFIG_INVALID', '已投递任务不能直接重新打开');
      review.status = 'DRAFT'; review.updatedAt = new Date().toISOString();
      db.pendingSubmissions = db.pendingSubmissions.filter((item) => item.taskId !== taskId);
    });
    return { ok: true };
  });
  app.delete('/api/v1/tasks/:taskId/draft', async (request) => {
    const { taskId } = request.params as { taskId: string };
    await store.update((db) => { db.reviews = db.reviews.filter((item) => item.taskId !== taskId); db.pendingSubmissions = db.pendingSubmissions.filter((item) => item.taskId !== taskId); });
    return { ok: true };
  });

  app.get('/api/v1/pending-submissions', async () => {
    const db = store.read();
    return { items: await Promise.all(db.pendingSubmissions.map(async (item) => {
      const review = db.reviews.find((candidate) => candidate.taskId === item.taskId);
      const sourceStage = config.get().stages.find((candidate) => candidate.id === item.sourceStageId);
      const targetStage = config.get().stages.find((candidate) => candidate.id === item.targetStageId);
      const target = sourceStage?.targets.find((candidate) => candidate.targetStageId === item.targetStageId);
      const sourceStageEnabled = sourceStage?.enabled === true;
      const targetStageEnabled = targetStage?.enabled === true;
      let identityDisabledReason: string | undefined;
      let currentProductName = item.productNameSnapshot;
      if (!item.productSku) identityDisabledReason = '尚未关联采购 SKU，请重新打开审核任务完成关联';
      else {
        try { currentProductName = (await productIdentity.requirePendingIdentity(item)).productName; }
        catch (error) { identityDisabledReason = error instanceof AppError ? error.message : 'PostgreSQL 不可用，无法校验产品身份'; }
      }
      const disabledReason = !sourceStageEnabled ? `来源流程 ${item.sourceStageId} 已停用` : !targetStageEnabled ? `目标流程 ${item.targetStageId} 已停用` : identityDisabledReason;
      return { ...item, productNameSnapshot: currentProductName, sourceFolderName: review?.sourceFolderName || item.taskId.slice(0, 12), approvedAt: review?.approvedAt, targetQueueRoot: target?.targetQueueRoot, sourceStageEnabled, targetStageEnabled, disabledReason };
    })) };
  });
  app.patch('/api/v1/pending-submissions/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { conflictPolicy?: PendingSubmission['conflictPolicy']; n8nTaskParameters?: unknown; n8nTaskParameterOptions?: unknown };
    const hasTaskParameters = Object.prototype.hasOwnProperty.call(body || {}, 'n8nTaskParameters');
    const hasTaskOptions = Object.prototype.hasOwnProperty.call(body || {}, 'n8nTaskParameterOptions');
    await store.update((db) => {
      const pending = db.pendingSubmissions.find((item) => item.id === id);
      if (!pending) throw new AppError('CONFIG_INVALID', '待投递任务不存在', { id }, 404);
      if (body.conflictPolicy) pending.conflictPolicy = body.conflictPolicy;
      if (hasTaskParameters || hasTaskOptions) {
        if (pending.status === 'PACKAGING') throw new AppError('TASK_LOCKED', '任务正在打包，不能修改 n8n 参数', { id }, 409);
        const selection = config.validateWorkflowParameterSelection(
          hasTaskParameters ? body.n8nTaskParameters : pending.n8nTaskParameters,
          hasTaskOptions ? body.n8nTaskParameterOptions : (pending.n8nTaskParameterOptions || {})
        );
        pending.n8nTaskParameters = pending.productSku && pending.productNameSnapshot
          ? pending.variantName
            ? productIdentity.injectVariant(selection.parameters, { sku: pending.productSku, productName: pending.productNameSnapshot, variants: [] }, pending.variantName)
            : productIdentity.inject(selection.parameters, { sku: pending.productSku, productName: pending.productNameSnapshot, variants: [] })
          : structuredClone(selection.parameters);
        pending.n8nTaskParameterOptions = structuredClone(selection.parameterOptions);
      }
      pending.updatedAt = new Date().toISOString();
    });
    if (hasTaskParameters || hasTaskOptions) await store.addEvent('PENDING_PARAMETERS_SAVED', '待投递任务 n8n 参数已保存', { pendingSubmissionId: id });
    return { item: store.read().pendingSubmissions.find((item) => item.id === id) };
  });
  app.delete('/api/v1/pending-submissions/:id', async (request) => {
    const { id } = request.params as { id: string };
    await store.update((db) => { db.pendingSubmissions = db.pendingSubmissions.filter((item) => item.id !== id); });
    return { ok: true };
  });
  app.post('/api/v1/submissions/batch', async (request) => {
    const body = request.body as { batchId?: string; pendingSubmissionIds?: string[]; conflictPolicy?: PendingSubmission['conflictPolicy'] };
    return submissions.runBatch(body.batchId || `BATCH-${randomUUID()}`, body.pendingSubmissionIds || [], body.conflictPolicy || 'new-revision');
  });
  app.get('/api/v1/submissions/batches/:batchId', async (request) => {
    const { batchId } = request.params as { batchId: string };
    const batch = store.read().submissionBatches.find((item) => item.batchId === batchId);
    if (!batch) throw new AppError('CONFIG_INVALID', '投递批次不存在', { batchId }, 404);
    return batch;
  });
  app.get('/api/v1/submissions/history', async (request) => {
    const query = request.query as { status?: string; sourceStageId?: string; targetStageId?: string; search?: string; sku?: string; completedFrom?: string; completedTo?: string };
    let items = store.read().submissionHistory;
    if (query.sku !== undefined) {
      const sku = String(query.sku).trim();
      if (!/^\d{7}$/.test(sku)) throw new AppError('CONFIG_INVALID', 'SKU 必须是完整的 7 位数字', { sku });
      items = items.filter((item) => item.productSku === sku);
    }
    if (query.status) items = items.filter((item) => item.status === query.status);
    if (query.sourceStageId) items = items.filter((item) => item.sourceStageId === query.sourceStageId);
    if (query.targetStageId) items = items.filter((item) => item.targetStageId === query.targetStageId);
    if (query.search) items = items.filter((item) => item.sourceFolder.toLocaleLowerCase().includes(query.search!.toLocaleLowerCase()));
    const completedFrom = query.completedFrom ? normalizeSubmissionHistoryDate(query.completedFrom, '投递日期起始时间') : undefined;
    const completedTo = query.completedTo ? normalizeSubmissionHistoryDate(query.completedTo, '投递日期结束时间') : undefined;
    if (completedFrom && completedTo && completedFrom >= completedTo) {
      throw new AppError('CONFIG_INVALID', '投递日期结束时间必须晚于起始时间');
    }
    if (completedFrom || completedTo) {
      items = items.filter((item) => {
        if (!item.completedAt) return false;
        const completedAt = Date.parse(item.completedAt);
        if (!Number.isFinite(completedAt)) return false;
        return (!completedFrom || completedAt >= completedFrom) && (!completedTo || completedAt < completedTo);
      });
    }
    return { items };
  });
  app.get('/api/v1/submissions/:submissionId', async (request) => {
    const { submissionId } = request.params as { submissionId: string };
    const item = store.read().submissionHistory.find((candidate) => candidate.submissionId === submissionId);
    if (!item) throw new AppError('CONFIG_INVALID', '投递记录不存在', { submissionId }, 404);
    return item;
  });
  app.post('/api/v1/submissions/:submissionId/retry', async (request) => {
    const { submissionId } = request.params as { submissionId: string };
    const existing = store.read().submissionHistory.find((item) => item.submissionId === submissionId);
    if (existing?.deliveryType === 'WB_MEDIA' || existing?.deliveryType === 'OZON_MEDIA') {
      if (existing.status === 'SUCCESS') return existing;
      if (!existing.selectedRelativePaths?.length || !existing.productSku || !existing.productNameSnapshot || !existing.variantId || !existing.variantName || !existing.outputRootTemplateSnapshot || !existing.resolvedOutputRoot) {
        throw new AppError('CONFIG_INVALID', '这条共享媒体记录缺少冻结重试信息，不能自动重试', { submissionId }, 409);
      }
      const stage = requireEnabledStage(config, existing.sourceStageId);
      const task = await scanner.getTask(existing.taskId);
      const platform = existing.deliveryType === 'WB_MEDIA' ? 'WB' : 'OZON';
      const alreadyArchived = store.read().submissionHistory.some((item) => item.taskId === existing.taskId && item.submissionId !== submissionId && item.status === 'SUCCESS' && Boolean(item.archiveFolder));
      try {
        const record = await variantDelivery.deliver({ platform, task, stage, selectedRelativePaths: existing.selectedRelativePaths, productSku: existing.productSku, productName: existing.productNameSnapshot, variantId: existing.variantId, variantName: existing.variantName, sourceSubmissionId: existing.sourceSubmissionId, archiveMedia: !alreadyArchived, retry: { submissionId, outputRootTemplateSnapshot: existing.outputRootTemplateSnapshot, resolvedOutputRoot: existing.resolvedOutputRoot } });
        await store.update((db) => {
          const index = db.submissionHistory.findIndex((item) => item.submissionId === submissionId);
          if (index >= 0) db.submissionHistory[index] = record;
          const review = db.reviews.find((item) => item.taskId === existing.taskId);
          if (review) Object.assign(review, { status: 'SUBMITTED', updatedAt: new Date().toISOString(), approvedAt: new Date().toISOString() });
        });
        if (platform === 'WB') {
          await wbAutoPublishing.onMediaDelivered({ sku: existing.productSku, stageId: existing.sourceStageId as 'E004' | 'E005', submissionId: record.submissionId, variantId: existing.variantId, deliveredAt: record.completedAt || record.startedAt })
            .catch((error) => app.log.warn({ err: error, sku: existing.productSku, submissionId }, 'WB 自动上品重试媒体事件入队失败'));
        } else {
          await ozonAutoPublishing.onMediaDelivered({ sku: existing.productSku, stageId: existing.sourceStageId as 'E004' | 'E005', submissionId: record.submissionId, variantId: existing.variantId, deliveredAt: record.completedAt || record.startedAt, resolvedOutputRoot: record.resolvedOutputRoot, selectedRelativePaths: existing.selectedRelativePaths })
            .catch((error) => app.log.warn({ err: error, sku: existing.productSku, submissionId }, 'OZON 自动上品重试媒体事件入队失败'));
        }
        return record;
      } catch (error) {
        if (error instanceof TerminalDeliveryError) {
          await store.update((db) => { const index = db.submissionHistory.findIndex((item) => item.submissionId === submissionId); if (index >= 0) db.submissionHistory[index] = error.record; });
          throw new AppError(error.record.errorCode || 'COPY_FAILED', error.message, { submissionId }, 409);
        }
        throw error;
      }
    }
    return submissions.retrySubmission(submissionId);
  });

  app.get('/api/v1/settings/thumbnail-cache', async () => thumbnails.stats());
  app.delete('/api/v1/settings/thumbnail-cache', async () => thumbnails.clear());
  app.get('/api/v1/settings/staging', async () => ({ items: await scanStaging(config) }));
  app.delete('/api/v1/settings/staging', async (request) => {
    const body = request.body as { path?: string };
    const stale = await scanStaging(config);
    const item = stale.find((candidate) => candidate.path === body.path);
    if (!item || !item.stale) throw new AppError('CONFIG_INVALID', '只能清理已识别且超过 24 小时的暂存目录');
    await rm(item.path, { recursive: true, force: true });
    return { ok: true };
  });

  const webRoot = path.resolve(import.meta.dirname, '../../web/dist');
  if (await stat(webRoot).catch(() => null)) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: true });
    app.setNotFoundHandler(async (request, reply) => {
      const pathname = request.url.split('?', 1)[0] || '/';
      const acceptsHtml = request.headers.accept?.includes('text/html') ?? false;
      if (request.method === 'GET' && acceptsHtml && !pathname.startsWith('/api/') && !pathname.startsWith('/assets/')) {
        return reply.header('Cache-Control', 'no-cache').type('text/html').sendFile('index.html', { cacheControl: false });
      }
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '请求的资源不存在' } });
    });
  }
  if (downloadSync.status === 'synced') downloads.start();
  await wbCatalog.start();
  await ozonCatalog.start();
  wbTaskStatusSynchronizer.start();
  wbAutoPublishing.start();
  ozonAutoPublishing.start();
  ozonSourceMediaCleanup.start();
  await store.addEvent('APP_STARTED', '应用服务已启动', { appDataDir: config.appDataDir });
  app.addHook('onClose', async () => {
    downloads.stop();
    ozonSourceMediaCleanup.stop();
    await Promise.all([mediaIndex.close(), wbCatalog.stop(), ozonCatalog.stop(), wbTaskStatusSynchronizer.stop(), wbAutoPublishing.stop(), ozonAutoPublishing.stop()]);
    await Promise.all([purchases.close(), shipping.close(), pricing.close(), wb.close(), wbPresetRepository.close(), wbStoreRepository.close(), wbAutoPublishRepository.close(), wbSourceMediaCleanupRepository.close(), ozon.close(), ozonStoreRepository.close(), ozonSourceMediaCleanupRepository.close()]);
    await store.addEvent('APP_STOPPED', '应用服务已关闭');
    unsubscribeMediaIndexEvents();
    unsubscribeReviewEvents();
    mediaIndexEvents.close();
    logger.flush();
  });
  return app;

  async function taskDetailHandler(request: any): Promise<unknown> {
    const task = await scanner.getTask(request.params.taskId);
    return { ...task, productIdentity: await productIdentity.resolveTask(task) };
  }
}

type DownloadSyncState = { status: 'synced' | 'pending'; message?: string; syncedAt?: string };

function downloadWorkflowInputs(config: AppConfig): WorkflowInput[] {
  return config.stages.filter((stage) => stage.download).map((stage) => ({
    code: stage.id,
    displayName: stage.displayName,
    webhookUrl: stage.download!.webhookUrl,
    parentOutputDir: stage.candidateRoot || '',
    timeoutMs: stage.download!.timeoutMs,
    enabled: stage.enabled,
    isDefault: stage.download!.isDefault,
    recoveryMode: stage.download!.recoveryMode
  }));
}

function downloadProjectionChanged(previous: AppConfig, next: AppConfig): boolean {
  return JSON.stringify(downloadWorkflowInputs(previous)) !== JSON.stringify(downloadWorkflowInputs(next));
}

async function synchronizeDownloadProjection(config: ConfigService, purchases: PurchaseRepository, strict = false): Promise<DownloadSyncState> {
  if (process.env.DOWNLOAD_CONFIG_SYNC === 'false') {
    if (strict) throw new AppError('DOWNLOAD_CONFIG_OUT_OF_SYNC', '当前环境禁止下载配置投影同步', undefined, 503);
    return { status: 'pending', message: '当前环境已关闭下载配置投影同步，下载 Worker 未启动' };
  }
  const inputs = downloadWorkflowInputs(config.get());
  if (!purchases.configured) return { status: 'pending', message: 'PostgreSQL 未连接，下载配置将在数据库连接后同步' };
  try {
    await purchases.syncWorkflows(inputs);
    return { status: 'synced', syncedAt: new Date().toISOString() };
  } catch (error) {
    if (strict) {
      if (error instanceof AppError) throw error;
      throw new AppError('DOWNLOAD_CONFIG_OUT_OF_SYNC', '下载工作流数据库投影与系统设置不一致', {
        cause: error instanceof Error ? error.message : String(error)
      }, 503);
    }
    return { status: 'pending', message: error instanceof Error ? error.message : '下载配置同步失败' };
  }
}

async function assertSafeDownloadConfiguration(candidate: AppConfig, purchases: PurchaseRepository): Promise<void> {
  if (!purchases.configured) return;
  await Promise.all(candidate.stages.filter((stage) => stage.download).map((stage) => assertSafeDownloadRoot(stage.candidateRoot || '')));
}

async function assertSafeDownloadStageCandidate(candidate: unknown, purchases: PurchaseRepository): Promise<void> {
  if (!purchases.configured || !candidate || typeof candidate !== 'object') return;
  const stage = candidate as { download?: unknown; candidateRoot?: unknown };
  if (!stage.download) return;
  await assertSafeDownloadRoot(typeof stage.candidateRoot === 'string' ? stage.candidateRoot : '');
}

async function assertWorkflowCanBeDeleted(stage: StageConfig, prospectiveConfig: AppConfig | undefined, config: ConfigService, store: StateStore, purchases: PurchaseRepository): Promise<void> {
  const blockers: string[] = [];
  const stages = prospectiveConfig?.stages || config.get().stages.filter((candidate) => candidate.id !== stage.id);
  const references = stages.filter((candidate) => candidate.targets.some((target) => target.targetStageId === stage.id)).map((candidate) => candidate.id);
  if (references.length) blockers.push(`仍被 ${references.join('、')} 作为投递目标`);
  const pending = store.read().pendingSubmissions.filter((item) => item.sourceStageId === stage.id || item.targetStageId === stage.id);
  if (pending.length) blockers.push(`存在 ${pending.length} 条待处理投递任务`);
  if (stage.download) {
    if (!purchases.configured) blockers.push('PostgreSQL 未连接，无法确认下载任务引用');
    else {
      const jobCount = await purchases.countWorkflowJobs(stage.id);
      if (jobCount) blockers.push(`存在 ${jobCount} 条下载任务引用`);
    }
    const remainingEnabledDownloads = stages.filter((candidate) => candidate.enabled && candidate.download);
    if (stage.enabled && stage.download.isDefault && remainingEnabledDownloads.length && !remainingEnabledDownloads.some((candidate) => candidate.download?.isDefault)) {
      blockers.push('请先将另一个启用的下载工作流设为默认');
    }
  }
  if (blockers.length) throw new AppError('CONFIG_INVALID', `工作流 ${stage.id} 暂不能删除：${blockers.join('；')}`, { stageId: stage.id, blockers }, 409);
}

async function migratePendingWorkflowParameters(config: ConfigService, store: StateStore): Promise<void> {
  const snapshot = store.read();
  const missing = snapshot.pendingSubmissions.filter((item) => !item.n8nTaskParameters);
  if (!missing.length) return;
  const defaults = new Map<string, WorkflowParameters>();
  for (const stageId of [...new Set(missing.map((item) => item.targetStageId))]) {
    defaults.set(stageId, await config.getWorkflowParameters(stageId));
  }
  await store.update((db) => {
    for (const pending of db.pendingSubmissions) {
      if (!pending.n8nTaskParameters && defaults.has(pending.targetStageId)) {
        pending.n8nTaskParameters = structuredClone(defaults.get(pending.targetStageId)!);
      }
    }
  });
}

function validateSelected(task: Awaited<ReturnType<ScannerService['getTask']>>, selected: string[], requireAny: boolean): string[] {
  const unique = [...new Set(selected)];
  if (requireAny && !unique.length) throw new AppError('CONFIG_INVALID', '至少选择一个媒体文件');
  const existing = new Set(task.images.map((item) => item.relativePath));
  const missing = unique.filter((item) => !existing.has(item));
  if (missing.length) throw new AppError('SOURCE_FILE_MISSING', '部分选中的文件已不存在', { relativePaths: missing });
  if (task.stageId === 'E005') {
    const selectedSet = new Set(unique);
    return task.images.filter((item) => selectedSet.has(item.relativePath)).map((item) => item.relativePath);
  }
  return unique;
}

async function validateVariantSelectionGroups(
  task: Awaited<ReturnType<ScannerService['getTask']>>,
  groups: VariantSelectionGroup[],
  wb: WbRepository,
  ozonCatalog: OzonCatalogService,
  existingVariants: ProductVariant[]
): Promise<VariantSelectionGroup[]> {
  if (!Array.isArray(groups) || !groups.length) throw new AppError('CONFIG_INVALID', 'E001 审核至少需要一个变体组选图');
  const groupIds = new Set<string>();
  const colorKeys = new Set<string>();
  const imagePaths = new Set(task.images.filter((item) => item.mediaType === 'image').map((item) => item.relativePath));
  const ozonColors = await loadOzonColors(ozonCatalog);
  const resolved = await Promise.all(groups.map(async (group) => {
    const groupId = String(group?.groupId || '').trim();
    if (!groupId || groupId.length > 128 || groupIds.has(groupId)) throw new AppError('CONFIG_INVALID', '变体组选图的 groupId 缺失或重复');
    groupIds.add(groupId);
    const color = await requireCatalogColor(wb, group?.wbColor?.colorKey);
    if (colorKeys.has(color.colorKey)) throw new AppError('CONFIG_INVALID', '同一次 E001 审核中的 WB 颜色不能重复', { colorKey: color.colorKey, nameZh: color.nameZh });
    colorKeys.add(color.colorKey);
    const selectedRelativePaths = validateSelected(task, group.selectedRelativePaths || [], true);
    const selectedImageCount = selectedRelativePaths.filter((relativePath) => imagePaths.has(relativePath)).length;
    if (selectedImageCount > E001_VARIANT_MAX_IMAGE_COUNT) {
      throw new AppError('CONFIG_INVALID', `产品变体“${color.nameZh}”已选择 ${selectedImageCount} 张图片，每个变体最多 ${E001_VARIANT_MAX_IMAGE_COUNT} 张，请修改图片数量后再审核。`, {
        groupId,
        variantName: color.nameZh,
        selectedImageCount,
        maxImageCount: E001_VARIANT_MAX_IMAGE_COUNT
      });
    }
    const ozonSelection = resolveOzonColorSelection(group, color, ozonColors);
    return { groupId, wbColor: color, ...ozonSelection, selectedRelativePaths };
  }));
  return assignCanonicalVariantNames(resolved, existingVariants);
}

async function normalizeVariantSelectionGroupsDraft(
  task: Awaited<ReturnType<ScannerService['getTask']>>,
  groups: VariantSelectionGroup[],
  wb: WbRepository,
  ozonCatalog: OzonCatalogService
): Promise<VariantSelectionGroup[]> {
  const ids = new Set<string>();
  const ozonColors = await loadOzonColors(ozonCatalog);
  const resolved = await Promise.all(groups.map(async (group) => {
    const groupId = String(group?.groupId || '').trim() || randomUUID();
    if (ids.has(groupId)) throw new AppError('CONFIG_INVALID', '变体组选图的 groupId 不能重复');
    ids.add(groupId);
    const colorKey = String(group?.wbColor?.colorKey || '').trim();
    const wbColor = colorKey ? await requireCatalogColor(wb, colorKey) : undefined;
    const ozonSelection = wbColor ? resolveOzonColorSelection(group, wbColor, ozonColors) : {};
    return {
      groupId,
      variantName: String(group?.variantName || '').trim(),
      ...(wbColor ? { wbColor } : {}),
      ...ozonSelection,
      selectedRelativePaths: validateSelected(task, group?.selectedRelativePaths || [], false)
    };
  }));
  const colored = resolved.filter((group): group is typeof group & { wbColor: WbColorIdentity } => Boolean(group.wbColor));
  const named = assignCanonicalVariantNames(colored, []);
  const byGroup = new Map(named.map((group) => [group.groupId, group]));
  return resolved.map((group) => byGroup.get(group.groupId) || group);
}

async function loadOzonColors(ozonCatalog: OzonCatalogService): Promise<OzonCatalogDictionaryValue[] | undefined> {
  try {
    const result = await ozonCatalog.dictionary('colors', '', 1494, 2_000);
    return result.items.filter((item) => item.nameZh.trim() && item.nameRu.trim());
  } catch {
    return undefined;
  }
}

function resolveOzonColorSelection(
  group: VariantSelectionGroup,
  wbColor: WbColorIdentity,
  catalog: OzonCatalogDictionaryValue[] | undefined
): Pick<VariantSelectionGroup, 'ozonColor' | 'ozonColorSuppressed'> {
  if (group.ozonColorSuppressed) return { ozonColorSuppressed: true };
  const requested = sanitizeOzonColorIdentity(group.ozonColor);
  if (requested) {
    if (!catalog) return { ozonColor: requested };
    const matched = catalog.find((item) => item.itemKey === requested.itemKey || item.valueId === requested.valueId);
    if (matched) return { ozonColor: ozonColorFromCatalog(matched, requested.source) };
    // A stopped value remains visible in the review audit, but is not written back to the product variant.
    return { ozonColor: requested };
  }
  if (!catalog) return {};
  const ruKey = normalizeOzonColorName(wbColor.nameRu);
  const matches = catalog.filter((item) => normalizeOzonColorName(item.nameRu) === ruKey);
  return matches.length === 1 ? { ozonColor: ozonColorFromCatalog(matches[0]!, 'AUTO_EXACT_RU') } : {};
}

function sanitizeOzonColorIdentity(input?: OzonColorIdentity): OzonColorIdentity | undefined {
  if (!input) return undefined;
  const itemKey = String(input.itemKey || '').trim();
  const dictionaryId = Number(input.dictionaryId);
  const valueId = Number(input.valueId);
  const nameRu = String(input.nameRu || '').trim().normalize('NFC');
  const nameZh = String(input.nameZh || '').trim().normalize('NFC');
  const source = input.source;
  if (!itemKey || !Number.isInteger(dictionaryId) || dictionaryId < 1 || !Number.isInteger(valueId) || valueId < 1
    || !nameRu || !nameZh || !['AUTO_EXACT_RU', 'MANUAL_E001', 'MANUAL_OZON'].includes(source)) return undefined;
  return { itemKey, dictionaryId, valueId, nameRu, nameZh, source };
}

function ozonColorFromCatalog(item: OzonCatalogDictionaryValue, source: OzonColorIdentity['source']): OzonColorIdentity {
  return {
    itemKey: item.itemKey,
    dictionaryId: item.dictionaryId,
    valueId: item.valueId,
    nameRu: item.nameRu,
    nameZh: item.nameZh,
    source
  };
}

function normalizeOzonColorName(value: string): string {
  return value.trim().normalize('NFC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[‐‑‒–—―]/g, '-').replace(/\s+/g, ' ');
}

async function requireCatalogColor(wb: WbRepository, colorKeyInput: unknown): Promise<WbColorIdentity> {
  const colorKey = String(colorKeyInput || '').trim().toLocaleLowerCase('en-US');
  if (!colorKey) throw new AppError('CONFIG_INVALID', '请选择本地 WB 中俄颜色字典中的颜色');
  const color = await wb.getCatalogColorByKey(colorKey);
  if (!color?.nameZh) throw new AppError('CONFIG_INVALID', '所选 WB 颜色已不存在，请刷新颜色字典后重新选择', { colorKey }, 409);
  return color;
}

function assignCanonicalVariantNames(
  groups: Array<{ groupId: string; wbColor: WbColorIdentity; selectedRelativePaths: string[] }>,
  existingVariants: ProductVariant[]
): VariantSelectionGroup[] {
  const chineseCounts = new Map<string, number>();
  for (const group of groups) chineseCounts.set(group.wbColor.nameZh, (chineseCounts.get(group.wbColor.nameZh) || 0) + 1);
  return groups.map((group) => {
    const existingByColor = existingVariants.find((variant) => variant.wbColor?.colorKey === group.wbColor.colorKey);
    let variantName = existingByColor?.name || group.wbColor.nameZh;
    const occupiedByAnotherColor = existingVariants.some((variant) => normalizeProductVariantKey(variant.name) === normalizeProductVariantKey(variantName) && variant.wbColor?.colorKey !== group.wbColor.colorKey);
    if (!existingByColor && ((chineseCounts.get(group.wbColor.nameZh) || 0) > 1 || occupiedByAnotherColor)) {
      variantName = `${group.wbColor.nameZh}（${group.wbColor.nameRu}）`;
    }
    return { ...group, variantName: validateProductVariantName(variantName) };
  });
}

async function resolveTaskVariant(purchases: PurchaseRepository, task: Awaited<ReturnType<ScannerService['getTask']>>, product: ProductIdentityRecord) {
  if (!task.taskContext?.variants) throw new AppError('CONFIG_INVALID', `${task.stageId} 任务上下文缺少受保护的 variants 字段`, { taskId: task.taskId }, 409);
  const variantName = validateProductVariantName(task.taskContext.variants);
  const variant = product.variants?.find((item) => normalizeProductVariantKey(item.name) === normalizeProductVariantKey(variantName)) || (await purchases.ensureProductVariants(product.sku, [variantName]))[0];
  if (!variant) throw new AppError('CONFIG_INVALID', '无法创建或读取产品变体', { sku: product.sku, variantName });
  if (task.taskContext?.variantId && task.taskContext.variantId !== variant.variantId) {
    throw new AppError('CONFIG_INVALID', '任务上下文中的 variantId 与产品变体不一致', { expected: variant.variantId, actual: task.taskContext.variantId }, 409);
  }
  return variant;
}

function assertTaskContextIdentity(task: Awaited<ReturnType<ScannerService['getTask']>>, product: ProductIdentityRecord): void {
  if (['E002', 'E003', 'E004', 'E005'].includes(task.stageId) && (!task.taskContext?.SKU || !task.taskContext.productName || !task.taskContext.variants)) {
    throw new AppError('CONFIG_INVALID', `${task.stageId} 任务缺少 SKU、productName 或 variants 运行时身份`, { taskId: task.taskId }, 409);
  }
  if (task.taskContext?.SKU && task.taskContext.SKU !== product.sku) throw new AppError('CONFIG_INVALID', '任务上下文 SKU 与采购产品身份不一致', { taskSku: task.taskContext.SKU, productSku: product.sku }, 409);
  const e000BoundSkuCanUseCurrentName = task.stageId === 'E000' && task.taskContext?.SKU === product.sku;
  if (!e000BoundSkuCanUseCurrentName && task.taskContext?.productName && task.taskContext.productName !== product.productName) {
    throw new AppError('CONFIG_INVALID', '任务上下文 productName 与采购产品身份不一致', { taskProductName: task.taskContext.productName, productName: product.productName }, 409);
  }
}

async function configReadiness(config: ConfigService): Promise<{ complete: boolean; paths: Awaited<ReturnType<ConfigService['validatePath']>>[] }> {
  const stages = config.get().stages;
  const enabledStageIds = new Set(stages.filter((stage) => stage.enabled).map((stage) => stage.id));
  const paths = stages.filter((stage) => stage.enabled).flatMap((stage) => [
    stage.candidateRoot,
    stage.approvedArchiveRoot,
    stage.inputQueueRoot,
    ...(stage.id === 'E004' || stage.id === 'E005' ? [] : [stage.outputRoot]),
    ...stage.targets.filter((target) => enabledStageIds.has(target.targetStageId)).map((target) => target.targetQueueRoot)
  ]).filter((item): item is string => Boolean(item));
  const unique = [...new Set(paths)];
  const validations = await Promise.all(unique.map((item) => config.validatePath(item)));
  const candidateRoots = new Set(stages.filter((stage) => stage.enabled && stage.reviewEnabled).map((stage) => stage.candidateRoot));
  return { complete: validations.filter((item) => candidateRoots.has(item.path)).every((item) => item.exists && item.readable), paths: validations };
}

function mimeForExtension(extension: string): string {
  return ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.mov': 'video/quicktime' } as Record<string, string>)[extension] || 'application/octet-stream';
}

function normalizeSubmissionHistoryDate(value: string, label: string): number {
  const parsed = Date.parse(String(value).trim());
  if (!Number.isFinite(parsed)) throw new AppError('CONFIG_INVALID', `${label}格式无效`);
  return parsed;
}

function parseHttpRange(header: string, size: number): { start: number; end: number } {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) throw new AppError('CONFIG_INVALID', '无效的视频 Range 请求', undefined, 416);
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2] || 0));
  const end = match[2] && match[1] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) throw new AppError('CONFIG_INVALID', '视频 Range 超出文件范围', { size }, 416);
  return { start, end: Math.min(end, size - 1) };
}

async function scanStaging(config: ConfigService): Promise<Array<{ path: string; modifiedAt: string; stale: boolean }>> {
  const stages = config.get().stages;
  const enabledStageIds = new Set(stages.filter((stage) => stage.enabled).map((stage) => stage.id));
  const roots = new Set(stages.filter((stage) => stage.enabled).flatMap((stage) => [stage.approvedArchiveRoot, ...stage.targets.filter((target) => enabledStageIds.has(target.targetStageId)).map((target) => target.targetQueueRoot)]).filter((item): item is string => Boolean(item)));
  const result: Array<{ path: string; modifiedAt: string; stale: boolean }> = [];
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const root of roots) {
    const staging = path.join(root, '.staging');
    const entries = await readdir(staging, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const fullPath = path.join(staging, entry.name);
      const info = await stat(fullPath);
      result.push({ path: fullPath, modifiedAt: info.mtime.toISOString(), stale: info.mtimeMs < cutoff });
    }
  }
  return result;
}

function requireEnabledStage(config: ConfigService, stageId: string): StageConfig {
  const stage = config.get().stages.find((item) => item.id === stageId);
  if (!stage) throw new AppError('CONFIG_INVALID', '阶段不存在', { stageId }, 404);
  if (!stage.enabled) throw new AppError('STAGE_DISABLED', `流程 ${stageId} 已停用`, { stageId }, 409);
  return stage;
}
