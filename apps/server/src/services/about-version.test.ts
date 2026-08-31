import { describe, expect, it, vi } from 'vitest';
import { createAboutVersionService } from './about-version.js';

const CURRENT_SHA = '7bfb072f548d75744305a2faa38f23722c4b81cf';
const REMOTE_SHA = '4d3e4705ad715b700f385c6fa0348644a4a625a9';
const CHECKED_AT = new Date('2026-08-31T10:00:00.000Z');

describe('about version service', () => {
  it('prefers the latest stable release and reports commits available to update', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/releases/latest')) return json({ tag_name: 'v0.2.0', html_url: 'https://github.com/kyleliu-ai/MerchRoute/releases/tag/v0.2.0', published_at: '2026-08-30T00:00:00Z', draft: false, prerelease: false });
      if (url.endsWith('/commits/v0.2.0')) return json({ sha: REMOTE_SHA });
      if (url.includes('/compare/')) return json({ status: 'ahead', ahead_by: 5, html_url: `https://github.com/kyleliu-ai/MerchRoute/compare/${CURRENT_SHA}...${REMOTE_SHA}` });
      throw new Error(`unexpected request: ${url}`);
    });
    const service = createService(fetchImpl);

    await expect(service.check()).resolves.toMatchObject({
      current: { productVersion: '0.1.0', configVersion: 'v003', commitSha: CURRENT_SHA },
      available: { source: 'release', label: 'v0.2.0', commitSha: REMOTE_SHA },
      status: 'UPDATE_AVAILABLE',
      aheadBy: 5
    });
    expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith('/MerchRoute'))).toBe(false);
  });

  it('falls back to the repository default branch when no release exists', async () => {
    const fetchImpl = githubMainFetch({ compareStatus: 'identical', aheadBy: 0 });
    const result = await createService(fetchImpl).check();

    expect(result).toMatchObject({
      available: { source: 'main', label: 'main', commitSha: REMOTE_SHA },
      status: 'UP_TO_DATE',
      aheadBy: 0,
      checkedAt: CHECKED_AT.toISOString()
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['behind', 'LOCAL_AHEAD'],
    ['diverged', 'DIVERGED']
  ] as const)('maps GitHub compare status %s to %s', async (compareStatus, expectedStatus) => {
    const result = await createService(githubMainFetch({ compareStatus, aheadBy: compareStatus === 'diverged' ? 2 : 0 })).check();
    expect(result.status).toBe(expectedStatus);
    expect(result.aheadBy).toBe(compareStatus === 'diverged' ? 2 : 0);
  });

  it('keeps the current product version visible when GitHub cannot be reached', async () => {
    const service = createService(vi.fn(async () => { throw new Error('request timed out'); }));
    const result = await service.check();

    expect(result).toMatchObject({
      current: { productVersion: '0.1.0', configVersion: 'v003', commitSha: CURRENT_SHA },
      available: null,
      status: 'UNAVAILABLE'
    });
    expect(result.error).toContain('request timed out');
  });

  it('reports missing local Git metadata without hiding the remote main build', async () => {
    const fetchImpl = githubMainFetch({ compareStatus: 'identical', aheadBy: 0 });
    const service = createAboutVersionService({
      repoRoot: '.',
      configVersion: 'v003',
      productVersion: '0.1.0',
      fetchImpl: fetchImpl as typeof fetch,
      resolveCommit: async () => { throw new Error('not a git checkout'); },
      now: () => CHECKED_AT
    });
    const result = await service.check();

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.current.commitSha).toBeUndefined();
    expect(result.available).toMatchObject({ source: 'main', commitSha: REMOTE_SHA });
    expect(result.error).toContain('Git 元数据');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('caches a successful result for ten minutes', async () => {
    const fetchImpl = githubMainFetch({ compareStatus: 'ahead', aheadBy: 5 });
    const service = createService(fetchImpl);
    const first = await service.check();
    const second = await service.check();

    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

function createService(fetchImpl: ReturnType<typeof vi.fn>) {
  return createAboutVersionService({
    repoRoot: '.',
    configVersion: 'v003',
    productVersion: '0.1.0',
    fetchImpl: fetchImpl as typeof fetch,
    resolveCommit: async () => CURRENT_SHA,
    now: () => CHECKED_AT
  });
}

function githubMainFetch({ compareStatus, aheadBy }: { compareStatus: string; aheadBy: number }) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/releases/latest')) return json({}, 404);
    if (url.endsWith('/MerchRoute')) return json({ default_branch: 'main' });
    if (url.endsWith('/commits/main')) return json({ sha: REMOTE_SHA, html_url: `https://github.com/kyleliu-ai/MerchRoute/commit/${REMOTE_SHA}`, commit: { committer: { date: '2026-08-31T08:00:00Z' } } });
    if (url.includes('/compare/')) return json({ status: compareStatus, ahead_by: aheadBy, html_url: `https://github.com/kyleliu-ai/MerchRoute/compare/${CURRENT_SHA}...${REMOTE_SHA}` });
    throw new Error(`unexpected request: ${url}`);
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
