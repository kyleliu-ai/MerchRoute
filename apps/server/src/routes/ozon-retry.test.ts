import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AppError } from '@n8n-media-review/shared';
import { registerOzonRoutes } from './ozon.js';

describe('OZON retry operator API', () => {
  async function appFixture() {
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof AppError ? error.statusCode : 500).send({ error: { code: error.code, message: error.message } }));
    const retry = { plan: vi.fn(async () => ({ canRetry: true })), request: vi.fn(async () => ({ retry: { status: 'CHECKING' }, idempotent: false })) };
    await registerOzonRoutes(app, { ozonRetry: retry } as any);
    return { app, retry };
  }
  it('reads a plan without creating work and accepts only an explicit scoped request', async () => {
    const { app, retry } = await appFixture(); const job = randomUUID(), store = randomUUID();
    try {
      const response = await app.inject({ method: 'GET', url: `/api/v1/ozon/automation/jobs/${job}/retry-plan?storeId=${store}` });
      expect(response.statusCode).toBe(200); expect(retry.request).not.toHaveBeenCalled();
      const input = { storeId: store, requestId: randomUUID(), planHash: 'sha256:' + 'a'.repeat(64), confirmRebuild: false };
      const accepted = await app.inject({ method: 'POST', url: `/api/v1/ozon/automation/jobs/${job}/retry`, payload: input });
      expect(accepted.statusCode).toBe(202); expect(accepted.json().retry.status).toBe('CHECKING');
      expect(retry.request).toHaveBeenCalledWith(job, input);
    } finally { await app.close(); }
  });
  it('rejects remote operators, bulk targets and missing plan identity', async () => {
    const { app, retry } = await appFixture(); const url = `/api/v1/ozon/automation/jobs/${randomUUID()}/retry`;
    try {
      const input = { storeId: randomUUID(), requestId: randomUUID(), planHash: 'sha256:' + 'a'.repeat(64), confirmRebuild: false };
      expect((await app.inject({ method: 'POST', url, remoteAddress: '192.0.2.5', payload: input })).statusCode).toBe(403);
      for (const payload of [{}, { ...input, storeIds: [randomUUID()] }, { ...input, planHash: '' }]) {
        expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(400);
      }
      expect(retry.request).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
