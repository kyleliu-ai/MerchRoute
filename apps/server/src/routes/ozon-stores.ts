import type { FastifyInstance } from 'fastify';
import { AppError } from '@n8n-media-review/shared';
import type { OzonStoreGatewayService } from '../services/ozon-stores/gateway.js';
import type { OzonStoreService } from '../services/ozon-stores/index.js';
import type { OzonSourceMediaCleanupService } from '../services/ozon-source-media/index.js';

export async function registerOzonStoreRoutes(
  app: FastifyInstance<any, any, any, any, any>,
  services: { stores: OzonStoreService; gateway: OzonStoreGatewayService; sourceMediaCleanup: OzonSourceMediaCleanupService }
): Promise<void> {
  const { stores, gateway, sourceMediaCleanup } = services;

  app.get('/api/v1/ozon/settings', async () => ({ settings: await stores.settings() }));
  const updateSettings = async (request: { ip: string; body: unknown }) => {
    requireLoopbackOperator(request);
    return { settings: await stores.updateSettings(request.body) };
  };
  app.patch('/api/v1/ozon/settings', updateSettings);
  app.put('/api/v1/ozon/settings', updateSettings);

  app.get('/api/v1/ozon/stores', async (request) => {
    const query = request.query as { includeArchived?: string };
    return stores.listStores(query.includeArchived === 'true' || query.includeArchived === '1');
  });
  app.post('/api/v1/ozon/stores', async (request) => {
    requireLoopbackOperator(request);
    return { store: await stores.createStore(request.body) };
  });
  app.get('/api/v1/ozon/stores/:storeId', async (request) => ({
    store: await stores.repository.getStore((request.params as { storeId: string }).storeId, true)
  }));
  const updateStore = async (request: { ip: string; body: unknown; params: unknown }) => {
    requireLoopbackOperator(request);
    return {
      store: await stores.updateStore((request.params as { storeId: string }).storeId, request.body)
    };
  };
  app.patch('/api/v1/ozon/stores/:storeId', updateStore);
  app.put('/api/v1/ozon/stores/:storeId', updateStore);

  app.put('/api/v1/ozon/stores/:storeId/credential', { logLevel: 'silent' }, async (request) => {
    requireLoopbackOperator(request);
    return { store: await stores.saveCredential((request.params as { storeId: string }).storeId, request.body) };
  });
  app.post('/api/v1/ozon/stores/:storeId/credentials', { logLevel: 'silent' }, async (request) => {
    requireLoopbackOperator(request);
    return { store: await stores.saveCredential((request.params as { storeId: string }).storeId, request.body) };
  });
  app.post('/api/v1/ozon/stores/:storeId/preflight', async (request) => {
    requireLoopbackOperator(request);
    return stores.preflight((request.params as { storeId: string }).storeId, request.body);
  });
  app.post('/api/v1/ozon/stores/:storeId/enable', async (request) => {
    requireLoopbackOperator(request);
    return { store: await stores.enable((request.params as { storeId: string }).storeId, request.body) };
  });
  app.post('/api/v1/ozon/stores/:storeId/disable', async (request) => {
    requireLoopbackOperator(request);
    return { store: await stores.disable((request.params as { storeId: string }).storeId, request.body) };
  });
  app.post('/api/v1/ozon/stores/:storeId/archive', async (request) => {
    requireLoopbackOperator(request);
    return { store: await stores.archive((request.params as { storeId: string }).storeId, request.body) };
  });

  app.post('/api/v1/ozon/listings/:sku/publication-plans', async (request) => ({
    plan: await stores.publicationPlan((request.params as { sku: string }).sku, request.body)
  }));
  app.get('/api/v1/ozon/listings/:sku/publications', async (request) => {
    const query = request.query as { storeId?: string; status?: string };
    return stores.listPublications((request.params as { sku: string }).sku, query);
  });
  app.get('/api/v1/ozon/publications', async (request) => {
    const query = request.query as { sku?: string; skus?: string; storeId?: string; status?: string; source?: string };
    const skus = query.skus
      ? [...new Set(query.skus.split(',').map((sku) => sku.trim()).filter(Boolean))]
      : undefined;
    if (skus && skus.length > 100) throw new AppError('CONFIG_INVALID', '批量查询最多支持 100 个 OZON SKU', { maximum: 100 }, 400);
    if (query.source && !['MANUAL', 'AUTOMATION'].includes(query.source)) {
      throw new AppError('CONFIG_INVALID', 'OZON publication 来源无效', { source: query.source }, 400);
    }
    return stores.listPublications(query.sku, {
      ...(skus?.length ? { skus } : {}),
      storeId: query.storeId,
      status: query.status,
      source: query.source
    });
  });
  app.get('/api/v1/ozon/publication-task-summaries', async (request) => {
    const query = request.query as { skus?: string; source?: string; latestBatchOnly?: string };
    const skus = query.skus
      ? [...new Set(query.skus.split(',').map((sku) => sku.trim()).filter(Boolean))]
      : [];
    if (!skus.length || skus.length > 100) {
      throw new AppError('CONFIG_INVALID', 'OZON 手动任务摘要必须提供 1–100 个 SKU', { maximum: 100 }, 400);
    }
    if (query.source !== 'MANUAL' || !['true', '1'].includes(String(query.latestBatchOnly || ''))) {
      throw new AppError('CONFIG_INVALID', 'OZON 手动任务摘要仅支持 MANUAL 最新批次投影', undefined, 400);
    }
    return stores.listLatestManualPublicationTaskSummaries(skus);
  });
  app.post('/api/v1/ozon/listings/:sku/publications', async (request) => {
    requireLoopbackOperator(request);
    return stores.createPublications((request.params as { sku: string }).sku, request.body);
  });
  app.get('/api/v1/ozon/publications/:publicationId', async (request) => ({
    publication: await stores.getPublication((request.params as { publicationId: string }).publicationId)
  }));
  app.get('/api/v1/ozon/publications/:publicationId/task-detail', async (request) => (
    stores.publicationTaskDetail((request.params as { publicationId: string }).publicationId)
  ));
  app.get('/api/v1/ozon/source-media-cleanups/status', async () => sourceMediaCleanup.repository.status());
  app.post('/api/v1/ozon/publications/:publicationId/sync', async (request) => {
    requireLoopbackOperator(request);
    return { publication: await stores.syncPublication((request.params as { publicationId: string }).publicationId, request.body) };
  });
  app.post('/api/v1/ozon/publications/:publicationId/recheck', async (request) => {
    requireLoopbackOperator(request);
    return { publication: await stores.recheckPublication((request.params as { publicationId: string }).publicationId, request.body) };
  });
  app.post('/api/v1/ozon/publications/:publicationId/recover-import-price-floor', async (request) => {
    requireLoopbackOperator(request);
    return stores.recoverImportPriceFloorFailure(
      (request.params as { publicationId: string }).publicationId,
      request.body
    );
  });
  app.post('/api/v1/ozon/publications/:publicationId/recover-import-no-brand', async (request) => {
    requireLoopbackOperator(request);
    return stores.recoverImportNoBrandFailure(
      (request.params as { publicationId: string }).publicationId,
      request.body
    );
  });
  app.post('/api/v1/ozon/publications/:publicationId/cancel', async (request) => {
    requireLoopbackOperator(request);
    return { publication: await stores.cancelPublication((request.params as { publicationId: string }).publicationId, request.body) };
  });
  app.post('/api/v1/ozon/publications/:publicationId/republish', async (request) => {
    requireLoopbackOperator(request);
    return { publication: await stores.republishPublication((request.params as { publicationId: string }).publicationId, request.body) };
  });
  app.get('/api/v1/ozon/publications/:publicationId/compatible-append-plan', async (request) => {
    return stores.compatibleAppendPlan((request.params as { publicationId: string }).publicationId);
  });
  app.post('/api/v1/ozon/publications/:publicationId/compatible-append', async (request) => {
    requireLoopbackOperator(request);
    return stores.compatibleAppend((request.params as { publicationId: string }).publicationId, request.body);
  });

  app.post('/api/v1/ozon/runtime/stores/:storeId/preflight-result', async (request) => {
    requireRuntimeKey(request);
    return {
      store: await stores.applyPreflightReport((request.params as { storeId: string }).storeId, request.body),
      reportVersion: 1
    };
  });
  app.post('/api/v1/ozon/runtime/stores/preflight/claim', async (request) => {
    requireRuntimeKey(request);
    return stores.claimDuePreflights(request.body);
  });
  app.post('/api/v1/ozon/runtime/gateway', { logLevel: 'silent' }, async (request) => {
    requireRuntimeKey(request);
    return gateway.execute(request.body);
  });
  app.post('/api/v1/ozon/runtime/gateway/legacy-receipt', { logLevel: 'silent' }, async (request) => {
    requireRuntimeKey(request);
    return gateway.recordLegacyReceipt(request.body);
  });
  app.post('/api/v1/ozon/internal/intake/verify', { logLevel: 'silent' }, async (request) => {
    requireRuntimeKey(request);
    return stores.verifyIntake(request.body);
  });
}

export function requireOzonLoopbackOperator(request: { ip: string }): void {
  requireLoopbackOperator(request);
}

export function requireOzonRuntimeKey(request: { headers: Record<string, unknown> }): void {
  requireRuntimeKey(request);
}

function requireLoopbackOperator(request: { ip: string }): void {
  const ip = String(request.ip || '').trim().toLowerCase();
  if (ip === '127.0.0.1' || ip === '::1' || ip === '0:0:0:0:0:0:0:1' || ip.startsWith('::ffff:127.')) return;
  throw new AppError('AUTH_INVALID', 'OZON 店铺管理写操作仅允许从本机访问', undefined, 403);
}

function requireRuntimeKey(request: { headers: Record<string, unknown> }): void {
  const expected = String(process.env.MERCHROUTE_RUNTIME_KEY || '').trim();
  if (!expected) throw new AppError('CONFIG_INVALID', '未配置 MERCHROUTE_RUNTIME_KEY，n8n 不能访问 OZON runtime API', undefined, 503);
  const received = String(request.headers['x-merchroute-runtime-key'] || '').trim();
  if (!received || received !== expected) throw new AppError('AUTH_INVALID', 'OZON runtime API 密钥无效', undefined, 401);
}
