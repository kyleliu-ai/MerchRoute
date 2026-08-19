import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@n8n-media-review/shared';
import { registerOzonRoutes } from './ozon.js';

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

async function retiredCompatibleAppendApp() {
  const app = Fastify();
  apps.push(app);
  app.setErrorHandler((error, _request, reply) => {
    const appError = error instanceof AppError
      ? error
      : new AppError('INTERNAL_ERROR', error instanceof Error ? error.message : '服务器内部错误', undefined, 500);
    void reply.status(appError.statusCode).send({
      error: { code: appError.code, message: appError.message, details: appError.details }
    });
  });
  const compatibleAppend = vi.fn();
  const compatibleAppendPlan = vi.fn();
  const submit = vi.fn();
  await registerOzonRoutes(app, {
    ozon: {} as any,
    ozonStores: {} as any,
    ozonPublishing: { compatibleAppendPlan, compatibleAppend, submit } as any,
    ozonAutoPublishing: {} as any,
    ozonCatalog: {} as any,
    pricing: {} as any,
    shipping: {} as any,
    config: {} as any
  });
  return { app, compatibleAppendPlan, compatibleAppend, submit };
}

describe('OZON compatible append HTTP contract', () => {
  it('retires the legacy compatible-append plan route in favor of publication APIs', async () => {
    const { app, compatibleAppendPlan } = await retiredCompatibleAppendApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/ozon/listings/0000049/compatible-append-plan'
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: 'OZON_PUBLICATION_REQUIRED',
      details: {
        sku: '0000049',
        planPath: '/api/v1/ozon/listings/0000049/publication-plans',
        createPath: '/api/v1/ozon/listings/0000049/publications'
      }
    });
    expect(compatibleAppendPlan).not.toHaveBeenCalled();
  });

  it.each([
    ['valid', { rowVersion: 7, planHash: `sha256:${'a'.repeat(64)}` }],
    ['malformed', { rowVersion: 7, planHash: 'stale' }]
  ])('retires the legacy compatible-append POST route before parsing a %s payload', async (_label, payload) => {
    const { app, compatibleAppend } = await retiredCompatibleAppendApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/listings/0000049/compatible-append',
      payload
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: 'OZON_PUBLICATION_REQUIRED',
      details: { sku: '0000049' }
    });
    expect(compatibleAppend).not.toHaveBeenCalled();
  });

  it('retires the legacy full-submit route with the same publication migration contract', async () => {
    const { app, submit } = await retiredCompatibleAppendApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/ozon/listings/0000049/submit',
      payload: { rowVersion: 7 }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: 'OZON_PUBLICATION_REQUIRED',
      details: { sku: '0000049' }
    });
    expect(submit).not.toHaveBeenCalled();
  });
});
