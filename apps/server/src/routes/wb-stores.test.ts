import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerWbStoreRoutes } from './wb-stores.js';

function services() {
  const stores = {
    settings: vi.fn(async () => ({ rowVersion: 1 })),
    updateSettings: vi.fn(async () => ({ rowVersion: 2 })),
    listStores: vi.fn(async () => ({ items: [], total: 0 })),
    createStore: vi.fn(async () => ({ id: 'store' })),
    updateStore: vi.fn(async () => ({ id: 'store' })),
    saveCredential: vi.fn(async () => ({ id: 'store' })),
    preflight: vi.fn(async () => ({ accepted: true })),
    enable: vi.fn(async () => ({ id: 'store' })),
    disable: vi.fn(async () => ({ id: 'store' })),
    archive: vi.fn(async () => ({ id: 'store' })),
    publicationPlan: vi.fn(async () => ({ planHash: 'sha256:test' })),
    createPublications: vi.fn(async () => ({ publications: [], accepted: 0, failed: 0 })),
    listPublications: vi.fn(async () => ({ items: [] })),
    getPublication: vi.fn(async () => ({ id: 'publication' })),
    syncPublication: vi.fn(async () => ({ id: 'publication' })),
    applyPreflightReport: vi.fn(async () => ({ id: 'store' })),
    repository: { getStore: vi.fn(async () => ({ id: 'store' })) }
  };
  return { stores, gateway: { execute: vi.fn(async () => ({ ok: true })) } };
}

describe('WB store management routes', () => {
  afterEach(() => delete process.env.MERCHROUTE_RUNTIME_KEY);

  it('rejects every management write from a non-loopback address', async () => {
    const app = Fastify();
    const mock = services();
    await registerWbStoreRoutes(app, mock as any);
    const writes = [
      { method: 'PATCH', url: '/api/v1/wb/settings', payload: {} },
      { method: 'POST', url: '/api/v1/wb/stores', payload: {} },
      { method: 'PATCH', url: '/api/v1/wb/stores/store-1', payload: {} },
      { method: 'PUT', url: '/api/v1/wb/stores/store-1/credential', payload: { token: 'must-not-log' } },
      { method: 'POST', url: '/api/v1/wb/stores/store-1/preflight', payload: {} },
      { method: 'POST', url: '/api/v1/wb/stores/store-1/enable', payload: {} },
      { method: 'POST', url: '/api/v1/wb/stores/store-1/disable', payload: {} },
      { method: 'POST', url: '/api/v1/wb/stores/store-1/archive', payload: {} },
      { method: 'POST', url: '/api/v1/wb/listings/0000110/publications', payload: {} },
      { method: 'POST', url: '/api/v1/wb/publications/publication-1/sync', payload: {} }
    ] as const;
    const responses = await Promise.all(writes.map((request) => app.inject({ ...request, remoteAddress: '10.0.0.8' })));
    responses.forEach((response, index) => {
      const request = writes[index]!;
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
      expect(response.body).not.toContain('must-not-log');
    });
    expect(mock.stores.updateSettings).not.toHaveBeenCalled();
    expect(mock.stores.saveCredential).not.toHaveBeenCalled();
    expect(mock.stores.createPublications).not.toHaveBeenCalled();
    await app.close();
  });

  it('keeps publication reads available and allows loopback writes', async () => {
    const app = Fastify();
    const mock = services();
    await registerWbStoreRoutes(app, mock as any);
    await expect(app.inject({ method: 'GET', url: '/api/v1/wb/listings/0000110/publications?storeId=store-1' }))
      .resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: 'PATCH', url: '/api/v1/wb/settings', payload: {}, remoteAddress: '127.0.0.1' }))
      .resolves.toMatchObject({ statusCode: 200 });
    expect(mock.stores.listPublications).toHaveBeenCalledWith('0000110', { storeId: 'store-1' });
    expect(mock.stores.updateSettings).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('provides a bounded read-only publication query for the manual listing table', async () => {
    const app = Fastify();
    const mock = services();
    await registerWbStoreRoutes(app, mock as any);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/wb/publications?skus=0000110%2C0000122%2C0000110&source=MANUAL'
    });
    expect(response.statusCode).toBe(200);
    expect(mock.stores.listPublications).toHaveBeenCalledWith(undefined, {
      skus: ['0000110', '0000122'],
      storeId: undefined,
      status: undefined,
      source: 'MANUAL',
      compact: true
    });

    const tooMany = Array.from({ length: 101 }, (_, index) => String(index + 1).padStart(7, '0')).join(',');
    await expect(app.inject({ method: 'GET', url: `/api/v1/wb/publications?skus=${tooMany}` }))
      .resolves.toMatchObject({ statusCode: 400 });
    await expect(app.inject({ method: 'GET', url: '/api/v1/wb/publications?source=LEGACY' }))
      .resolves.toMatchObject({ statusCode: 400 });
    await expect(app.inject({ method: 'GET', url: '/api/v1/wb/publications?source=MANUAL' }))
      .resolves.toMatchObject({ statusCode: 400 });
    await expect(app.inject({ method: 'GET', url: '/api/v1/wb/publications?skus=0000122' }))
      .resolves.toMatchObject({ statusCode: 400 });
    await expect(app.inject({ method: 'GET', url: '/api/v1/wb/publications?skus=0000122&source=MANUAL&status=UNKNOWN' }))
      .resolves.toMatchObject({ statusCode: 400 });
    await expect(app.inject({ method: 'GET', url: '/api/v1/wb/publications?skus=0000122&source=MANUAL&storeId=bad-id' }))
      .resolves.toMatchObject({ statusCode: 400 });
    await app.close();
  });
});
