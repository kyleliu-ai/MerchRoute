import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OZON_DEFAULT_STORE_ID } from '@n8n-media-review/shared';
import { OzonStoreService } from '../services/ozon-stores/index.js';
import { registerOzonStoreRoutes } from './ozon-stores.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe('OZON store creation route', () => {
  it('registers the loopback POST route and forwards a staged Tek+ payload', async () => {
    const stores = {
      createStore: vi.fn(async (input) => ({ id: '10000000-0000-4000-8000-000000000001', enabled: false, ...input })),
      repository: { getStore: vi.fn() }
    };
    const app = Fastify();
    await registerOzonStoreRoutes(app, { stores, gateway: { execute: vi.fn() } } as any);

    const response = await app.inject({
      method: 'POST', url: '/api/v1/ozon/stores', remoteAddress: '127.0.0.1',
      payload: { storeAlias: 'tek-plus', displayName: 'Tek+' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ store: { storeAlias: 'tek-plus', displayName: 'Tek+', enabled: false } });
    expect(stores.createStore).toHaveBeenCalledWith({ storeAlias: 'tek-plus', displayName: 'Tek+' });
    await app.close();
  });
});

describe('OZON store preflight route contract', () => {
  it('forwards rowVersion and dispatches the strict preflight action literal', async () => {
    const credentialVersionId = '20000000-0000-4000-8000-000000000001';
    const repository = {
      getSettings: vi.fn(async () => ({ preflightWebhookUrl: 'https://workflow.example/preflight' })),
      beginPreflight: vi.fn(async () => ({
        store: { id: OZON_DEFAULT_STORE_ID, storeAlias: 'default', rowVersion: 12 },
        storeConfigVersion: 6,
        credentialVersionId
      })),
      failPreflightDispatch: vi.fn()
    };
    const stores = new OzonStoreService(repository as any, {} as any, {} as any, {} as any);
    const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const app = Fastify();
    await registerOzonStoreRoutes(app, { stores, gateway: { execute: vi.fn() } } as any);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/ozon/stores/${OZON_DEFAULT_STORE_ID}/preflight`,
      remoteAddress: '127.0.0.1',
      payload: { rowVersion: 11 }
    });

    expect(response.statusCode).toBe(200);
    expect(repository.beginPreflight).toHaveBeenCalledWith(OZON_DEFAULT_STORE_ID, 11);
    const dispatched = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(dispatched).toEqual({
      action: 'preflight',
      storeId: OZON_DEFAULT_STORE_ID,
      storeAlias: 'default',
      rowVersion: 12,
      storeConfigVersion: 6,
      credentialVersionId,
      requestRef: response.json().requestRef
    });
    await app.close();
  });
});

describe('OZON publication price-floor recovery route', () => {
  it('is loopback-only and forwards both publication and job CAS versions', async () => {
    const publicationId = '3de7dc25-ddc3-4346-ab2a-be90eca8731d';
    const recoverImportPriceFloorFailure = vi.fn(async (id, input) => ({
      status: 'DRY_RUN', dryRun: true, publication: { id }, jobId: 'job-1', jobRowVersion: 6, checks: {}, input
    }));
    const stores = { recoverImportPriceFloorFailure, repository: { getStore: vi.fn() } };
    const app = Fastify();
    await registerOzonStoreRoutes(app, { stores, gateway: { execute: vi.fn() } } as any);

    const payload = { publicationRowVersion: 6, jobRowVersion: 6, dryRun: true };
    const allowed = await app.inject({
      method: 'POST',
      url: `/api/v1/ozon/publications/${publicationId}/recover-import-price-floor`,
      remoteAddress: '127.0.0.1',
      payload
    });
    expect(allowed.statusCode).toBe(200);
    expect(recoverImportPriceFloorFailure).toHaveBeenCalledWith(publicationId, payload);

    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/ozon/publications/${publicationId}/recover-import-price-floor`,
      remoteAddress: '10.0.0.8',
      payload
    });
    expect(denied.statusCode).toBe(403);
    expect(recoverImportPriceFloorFailure).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe('OZON publication no-brand recovery route', () => {
  it('is loopback-only and forwards both publication and job CAS versions', async () => {
    const publicationId = '576ad31b-486b-4e58-ba7e-9180606ca54f';
    const recoverImportNoBrandFailure = vi.fn(async (id, input) => ({
      status: 'DRY_RUN', dryRun: true, publication: { id }, jobId: 'job-1', jobRowVersion: 6, checks: {}, input
    }));
    const stores = { recoverImportNoBrandFailure, repository: { getStore: vi.fn() } };
    const app = Fastify();
    await registerOzonStoreRoutes(app, { stores, gateway: { execute: vi.fn() } } as any);
    const payload = { publicationRowVersion: 6, jobRowVersion: 6, dryRun: true };

    const allowed = await app.inject({
      method: 'POST', url: `/api/v1/ozon/publications/${publicationId}/recover-import-no-brand`,
      remoteAddress: '127.0.0.1', payload
    });
    expect(allowed.statusCode).toBe(200);
    expect(recoverImportNoBrandFailure).toHaveBeenCalledWith(publicationId, payload);

    const denied = await app.inject({
      method: 'POST', url: `/api/v1/ozon/publications/${publicationId}/recover-import-no-brand`,
      remoteAddress: '10.0.0.8', payload
    });
    expect(denied.statusCode).toBe(403);
    expect(recoverImportNoBrandFailure).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe('OZON publication duplicate-card recovery routes', () => {
  it('forwards read-only platform sync and automation stop with CAS and idempotency identity', async () => {
    const publicationId = '576ad31b-486b-4e58-ba7e-9180606ca54f';
    const requestId = '22222222-2222-4222-8222-222222222222';
    const refreshPublicationPlatformStatus = vi.fn(async (id, input) => ({ id, ...input }));
    const stopPublicationAutomation = vi.fn(async (id, input) => ({ id, ...input }));
    const stores = { refreshPublicationPlatformStatus, stopPublicationAutomation, repository: { getStore: vi.fn() } };
    const app = Fastify();
    await registerOzonStoreRoutes(app, { stores, gateway: { execute: vi.fn() } } as any);
    const payload = { rowVersion: 9, requestId };

    const refresh = await app.inject({
      method: 'POST', url: `/api/v1/ozon/publications/${publicationId}/platform-status/refresh`,
      remoteAddress: '127.0.0.1', payload
    });
    const stop = await app.inject({
      method: 'POST', url: `/api/v1/ozon/publications/${publicationId}/stop-automation`,
      remoteAddress: '127.0.0.1', payload
    });

    expect([refresh.statusCode, stop.statusCode]).toEqual([200, 200]);
    expect(refreshPublicationPlatformStatus).toHaveBeenCalledWith(publicationId, payload);
    expect(stopPublicationAutomation).toHaveBeenCalledWith(publicationId, payload);

    const denied = await app.inject({
      method: 'POST', url: `/api/v1/ozon/publications/${publicationId}/stop-automation`,
      remoteAddress: '10.0.0.8', payload
    });
    expect(denied.statusCode).toBe(403);
    expect(stopPublicationAutomation).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe('OZON publication list route', () => {
  it('forwards a bounded SKU batch and publication source for manual-list status projection', async () => {
    const listPublications = vi.fn(async () => ({ items: [], total: 0 }));
    const stores = { listPublications, repository: { getStore: vi.fn() } };
    const app = Fastify();
    await registerOzonStoreRoutes(app, { stores, gateway: { execute: vi.fn() } } as any);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/ozon/publications?skus=0000120%2C0000121&source=MANUAL'
    });

    expect(response.statusCode).toBe(200);
    expect(listPublications).toHaveBeenCalledWith(undefined, {
      skus: ['0000120', '0000121'],
      storeId: undefined,
      status: undefined,
      source: 'MANUAL'
    });
    await app.close();
  });

  it('rejects oversized SKU batches and unknown publication sources before repository access', async () => {
    const listPublications = vi.fn(async () => ({ items: [], total: 0 }));
    const stores = { listPublications, repository: { getStore: vi.fn() } };
    const app = Fastify();
    await registerOzonStoreRoutes(app, { stores, gateway: { execute: vi.fn() } } as any);

    const tooMany = await app.inject({
      method: 'GET',
      url: `/api/v1/ozon/publications?skus=${Array.from({ length: 101 }, (_, index) => String(index + 1).padStart(7, '0')).join(',')}`
    });
    const unknownSource = await app.inject({ method: 'GET', url: '/api/v1/ozon/publications?source=LEGACY' });

    expect(tooMany.statusCode).toBe(400);
    expect(unknownSource.statusCode).toBe(400);
    expect(listPublications).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('OZON latest manual publication task summary route', () => {
  it('forwards a bounded, deduplicated SKU set to the server-side latest-batch projection', async () => {
    const listLatestManualPublicationTaskSummaries = vi.fn(async () => ({ items: [], total: 0 }));
    const stores = { listLatestManualPublicationTaskSummaries, repository: { getStore: vi.fn() } };
    const app = Fastify();
    await registerOzonStoreRoutes(app, { stores, gateway: { execute: vi.fn() } } as any);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/ozon/publication-task-summaries?skus=0000134%2C0000134%2C0000140&source=MANUAL&latestBatchOnly=true'
    });

    expect(response.statusCode).toBe(200);
    expect(listLatestManualPublicationTaskSummaries).toHaveBeenCalledWith(['0000134', '0000140']);
    await app.close();
  });

  it('rejects missing SKU, unsupported source and non-latest projections', async () => {
    const listLatestManualPublicationTaskSummaries = vi.fn();
    const stores = { listLatestManualPublicationTaskSummaries, repository: { getStore: vi.fn() } };
    const app = Fastify();
    await registerOzonStoreRoutes(app, { stores, gateway: { execute: vi.fn() } } as any);

    const missing = await app.inject({ method: 'GET', url: '/api/v1/ozon/publication-task-summaries?source=MANUAL&latestBatchOnly=true' });
    const wrongSource = await app.inject({ method: 'GET', url: '/api/v1/ozon/publication-task-summaries?skus=0000140&source=AUTOMATION&latestBatchOnly=true' });
    const allBatches = await app.inject({ method: 'GET', url: '/api/v1/ozon/publication-task-summaries?skus=0000140&source=MANUAL&latestBatchOnly=false' });

    expect([missing.statusCode, wrongSource.statusCode, allBatches.statusCode]).toEqual([400, 400, 400]);
    expect(listLatestManualPublicationTaskSummaries).not.toHaveBeenCalled();
    await app.close();
  });
});
