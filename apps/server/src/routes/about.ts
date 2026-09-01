import type { FastifyInstance } from 'fastify';
import { AppError } from '@n8n-media-review/shared';
import type { AboutGithubAccessService } from '../services/about-github-access.js';
import type { AboutVersionService } from '../services/about-version.js';

export async function registerAboutRoutes(
  app: FastifyInstance<any, any, any, any, any>,
  services: { githubAccess: AboutGithubAccessService; version: AboutVersionService }
): Promise<void> {
  app.get('/api/v1/about/version', async (request) => {
    const refresh = (request.query as { refresh?: unknown }).refresh;
    return await services.version.check({ refresh: refresh === '1' || refresh === 'true' });
  });

  app.get('/api/v1/about/github-access', async (request) => ({
    access: services.githubAccess.status(isLoopback(request.ip))
  }));

  app.put('/api/v1/about/github-access', { logLevel: 'silent' }, async (request) => {
    requireLoopbackOperator(request);
    const token = String((request.body as { token?: unknown } | undefined)?.token ?? '');
    const access = await services.githubAccess.save(token);
    services.version.invalidate();
    return { access };
  });

  app.delete('/api/v1/about/github-access', { logLevel: 'silent' }, async (request) => {
    requireLoopbackOperator(request);
    const access = await services.githubAccess.useAnonymous();
    services.version.invalidate();
    return { access };
  });
}

function requireLoopbackOperator(request: { ip: string }): void {
  if (isLoopback(request.ip)) return;
  throw new AppError('AUTH_INVALID', 'GitHub Access Token 仅允许从 MerchRoute 本机配置', undefined, 403);
}

function isLoopback(input: string): boolean {
  const ip = String(input || '').trim().toLowerCase();
  return ip === '127.0.0.1' || ip === '::1' || ip === '0:0:0:0:0:0:0:1' || ip.startsWith('::ffff:127.');
}
