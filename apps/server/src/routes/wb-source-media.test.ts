import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerWbRoutes } from './wb.js';

describe('WB cleaned source media routes', () => {
  it('returns the explicit 410 contract before scanning or resolving a cleaned source', async () => {
    const app = Fastify();
    const wbPublishing = {
      scanMedia: vi.fn(),
      resolveMedia: vi.fn()
    };
    const wbSourceMediaCleanup = {
      sourceState: vi.fn().mockResolvedValue({ state: 'CLEANED', cleanedAt: '2026-08-14T00:00:00.000Z' })
    };
    await registerWbRoutes(app, {
      wb: {} as any,
      wbPublishing: wbPublishing as any,
      wbCatalog: {} as any,
      wbPresets: {} as any,
      wbAutoPublishing: {} as any,
      wbSourceMediaCleanup: wbSourceMediaCleanup as any
    });

    const [scan, media] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/wb/listings/0000123/media/scan' }),
      app.inject({ method: 'GET', url: '/api/v1/wb/listings/0000123/media/asset-a' })
    ]);

    for (const response of [scan, media]) {
      expect(response.statusCode).toBe(410);
      expect(response.json()).toMatchObject({
        code: 'WB_SOURCE_MEDIA_CLEANED',
        message: '公共媒体已在成功上品后清理，请重新投递媒体'
      });
    }
    expect(wbPublishing.scanMedia).not.toHaveBeenCalled();
    expect(wbPublishing.resolveMedia).not.toHaveBeenCalled();
    await app.close();
  });

  it('keeps the normal media path available while cleanup is pending', async () => {
    const app = Fastify();
    const wbPublishing = {
      scanMedia: vi.fn().mockResolvedValue({ mediaAssets: [], productVariants: [] }),
      productVariants: vi.fn().mockResolvedValue([])
    };
    await registerWbRoutes(app, {
      wb: {} as any,
      wbPublishing: wbPublishing as any,
      wbCatalog: {} as any,
      wbPresets: {} as any,
      wbAutoPublishing: {} as any,
      wbSourceMediaCleanup: { sourceState: vi.fn().mockResolvedValue({ state: 'CLEANUP_PENDING' }) } as any
    });

    const response = await app.inject({ method: 'POST', url: '/api/v1/wb/listings/0000123/media/scan' });
    expect(response.statusCode).toBe(200);
    expect(wbPublishing.scanMedia).toHaveBeenCalledWith('0000123');
    await app.close();
  });
});
