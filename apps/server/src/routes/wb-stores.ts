import type { FastifyInstance } from 'fastify';
import { AppError } from '@n8n-media-review/shared';
import type { WbStoreGatewayService } from '../services/wb-stores/gateway.js';
import type { WbStoreService } from '../services/wb-stores/index.js';

export async function registerWbStoreRoutes(
  app: FastifyInstance<any, any, any, any, any>,
  services: { stores: WbStoreService; gateway: WbStoreGatewayService }
): Promise<void> {
  const { stores, gateway } = services;

  app.get('/api/v1/wb/settings', async () => ({ settings: await stores.settings() }));
  app.patch('/api/v1/wb/settings', async (request) => {
    requireLoopbackOperator(request);
    return { settings: await stores.updateSettings(request.body) };
  });

  app.get('/api/v1/wb/stores', async (request) => {
    const query = request.query as { includeArchived?: string };
    return stores.listStores(query.includeArchived === 'true' || query.includeArchived === '1');
  });
  app.post('/api/v1/wb/stores', async (request) => {
    requireLoopbackOperator(request);
    return { store: await stores.createStore(request.body) };
  });
  app.get('/api/v1/wb/stores/:storeId', async (request) => ({
    store: await stores.repository.getStore((request.params as { storeId: string }).storeId, true)
  }));
  app.patch('/api/v1/wb/stores/:storeId', async (request) => {
    requireLoopbackOperator(request);
    return { store: await stores.updateStore((request.params as { storeId: string }).storeId, request.body) };
  });

  // Credential bodies are intentionally excluded from route logging. The
  // service also returns validation errors without echoing the submitted body.
  app.put('/api/v1/wb/stores/:storeId/credential', { logLevel: 'silent' }, async (request) => {
    requireLoopbackOperator(request);
    return { store: await stores.saveCredential((request.params as { storeId: string }).storeId, request.body) };
  });
  app.post('/api/v1/wb/stores/:storeId/preflight', async (request) => {
    requireLoopbackOperator(request);
    return stores.preflight((request.params as { storeId: string }).storeId);
  });
  app.post('/api/v1/wb/stores/:storeId/enable', async (request) => {
    requireLoopbackOperator(request);
    return { store: await stores.enable((request.params as { storeId: string }).storeId, request.body) };
  });
  app.post('/api/v1/wb/stores/:storeId/disable', async (request) => {
    requireLoopbackOperator(request);
    return { store: await stores.disable((request.params as { storeId: string }).storeId, request.body) };
  });
  app.post('/api/v1/wb/stores/:storeId/archive', async (request) => {
    requireLoopbackOperator(request);
    return { store: await stores.archive((request.params as { storeId: string }).storeId, request.body) };
  });

  app.post('/api/v1/wb/listings/:sku/publication-plans', async (request) => ({
    plan: await stores.publicationPlan((request.params as { sku: string }).sku, request.body)
  }));
  app.get('/api/v1/wb/listings/:sku/publications', async (request) => {
    const query = request.query as { storeId?: string; status?: string };
    return stores.listPublications((request.params as { sku: string }).sku, query);
  });
  app.get('/api/v1/wb/publications', async (request) => {
    const query = request.query as { sku?: string; skus?: string; storeId?: string; status?: string; source?: string };
    const skus = [...new Set([
      ...(query.sku ? [query.sku] : []),
      ...(query.skus ? query.skus.split(',') : [])
    ].map((sku) => sku.trim()).filter(Boolean))];
    if (!skus.length || skus.length > 100) throw new AppError('CONFIG_INVALID', '批量查询必须指定 1 到 100 个 WB SKU', { maximum: 100 }, 400);
    if (!query.source || !['MANUAL', 'AUTOMATION'].includes(query.source)) {
      throw new AppError('CONFIG_INVALID', 'WB publication 来源无效', { source: query.source }, 400);
    }
    if (query.status && !['PLANNED', 'DISPATCHING', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'NEEDS_ATTENTION', 'PAUSED'].includes(query.status)) {
      throw new AppError('CONFIG_INVALID', 'WB publication 状态无效', { status: query.status }, 400);
    }
    if (query.storeId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(query.storeId)) {
      throw new AppError('CONFIG_INVALID', 'WB 店铺 ID 无效', { storeId: query.storeId }, 400);
    }
    return stores.listPublications(undefined, {
      skus,
      storeId: query.storeId,
      status: query.status,
      source: query.source,
      compact: true
    });
  });
  app.post('/api/v1/wb/listings/:sku/publications', async (request) => {
    requireLoopbackOperator(request);
    return stores.createPublications((request.params as { sku: string }).sku, request.body);
  });
  app.get('/api/v1/wb/publications/:publicationId', async (request) => ({
    publication: await stores.getPublication((request.params as { publicationId: string }).publicationId)
  }));
  app.post('/api/v1/wb/publications/:publicationId/sync', async (request) => {
    requireLoopbackOperator(request);
    return { publication: await stores.syncPublication((request.params as { publicationId: string }).publicationId) };
  });

  app.post('/api/v1/wb/runtime/stores/:storeId/preflight-report', async (request) => {
    requireRuntimeKey(request);
    return { store: await stores.applyPreflightReport((request.params as { storeId: string }).storeId, request.body) };
  });
  app.post('/api/v1/wb/runtime/gateway', { logLevel: 'silent' }, async (request) => {
    requireRuntimeKey(request);
    return gateway.execute(request.body);
  });
}

function requireLoopbackOperator(request: { ip: string }): void {
  const ip = String(request.ip || '').trim().toLowerCase();
  if (ip === '127.0.0.1' || ip === '::1' || ip === '0:0:0:0:0:0:0:1' || ip.startsWith('::ffff:127.')) return;
  throw new AppError('AUTH_INVALID', 'WB 店铺管理写操作仅允许从本机访问', undefined, 403);
}

function requireRuntimeKey(request: { headers: Record<string, unknown> }): void {
  const expected = String(process.env.MERCHROUTE_RUNTIME_KEY || '').trim();
  if (!expected) throw new AppError('CONFIG_INVALID', '未配置 MERCHROUTE_RUNTIME_KEY，n8n 不能访问 WB runtime API', undefined, 503);
  const received = String(request.headers['x-merchroute-runtime-key'] || '').trim();
  if (!received || received !== expected) throw new AppError('AUTH_INVALID', 'WB runtime API 密钥无效', undefined, 401);
}
