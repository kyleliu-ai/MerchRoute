import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAboutRoutes } from './about.js';

describe('about GitHub access routes', () => {
  let app: ReturnType<typeof Fastify>;
  const token = `github_pat_${'x'.repeat(40)}`;
  const accessStatus = {
    mode: 'AUTHENTICATED' as const,
    source: 'MANAGED' as const,
    state: 'VERIFIED' as const,
    anonymousFallback: false,
    canManage: true
  };
  const githubAccess = {
    initialize: vi.fn(async () => undefined),
    current: vi.fn(() => ({ source: 'NONE' as const })),
    status: vi.fn((canManage = true) => ({ ...accessStatus, canManage })),
    save: vi.fn(async () => accessStatus),
    useAnonymous: vi.fn(async () => ({ ...accessStatus, mode: 'ANONYMOUS' as const, source: 'NONE' as const, state: 'UNVERIFIED' as const })),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn()
  };
  const version = {
    check: vi.fn(async () => ({ ok: true } as any)),
    invalidate: vi.fn()
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify({ logger: false });
    app.setErrorHandler((error: any, _request, reply) => void reply.status(error.statusCode || 500).send({ error: { code: error.code, message: error.message } }));
    await registerAboutRoutes(app, { githubAccess, version });
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns status without exposing credentials and saves a local token', async () => {
    const statusResponse = await app.inject({ method: 'GET', url: '/api/v1/about/github-access' });
    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json()).toEqual({ access: accessStatus });

    const response = await app.inject({ method: 'PUT', url: '/api/v1/about/github-access', payload: { token } });
    expect(response.statusCode).toBe(200);
    expect(githubAccess.save).toHaveBeenCalledWith(token);
    expect(version.invalidate).toHaveBeenCalledOnce();
    expect(response.body).not.toContain(token);
  });

  it('rejects remote token writes while keeping status readable', async () => {
    const response = await app.inject({ method: 'PUT', url: '/api/v1/about/github-access', remoteAddress: '203.0.113.10', payload: { token } });
    expect(response.statusCode).toBe(403);
    expect(githubAccess.save).not.toHaveBeenCalled();
  });

  it('switches to anonymous mode and invalidates the version cache', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/api/v1/about/github-access' });
    expect(response.statusCode).toBe(200);
    expect(githubAccess.useAnonymous).toHaveBeenCalledOnce();
    expect(version.invalidate).toHaveBeenCalledOnce();
    expect(response.json().access).toMatchObject({ mode: 'ANONYMOUS', source: 'NONE' });
  });
});
