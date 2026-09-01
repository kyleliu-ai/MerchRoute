import { describe, expect, it, vi } from 'vitest';
import { createAboutVersionService, type AboutBuildInfo } from './about-version.js';
import { collectGithubTreeSnapshot, type ContentFingerprintSnapshot, type FingerprintScopeContract, type GithubTreeEntry } from './content-fingerprint.js';

const CURRENT_SHA = '19e9886d0b4562dd70e46a4431f0da835b61e72c';
const REMOTE_SHA = `38c6cbb${'1'.repeat(33)}`;
const REMOTE_TREE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE_TREE_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CONTRACT_BLOB_SHA = 'cccccccccccccccccccccccccccccccccccccccc';
const CHECKED_AT = new Date('2026-09-01T06:00:00.000Z');
const CONTRACT: FingerprintScopeContract = {
  schemaVersion: 1,
  strategy: 'default-include',
  documentation: { prefixes: ['docs/'], extensions: ['.md'], basenames: ['LICENSE'] },
  verification: { prefixes: ['tests/', '.github/'], directoryNames: ['tests'], fileInfixes: ['.test.', '.spec.'], basenames: ['playwright.config.ts', 'eslint.config.js'] },
  excluded: { prefixes: ['outputs/', 'backups/'], directoryNames: ['node_modules', 'dist'], basenames: ['config/content-fingerprint-scope.json'], basenamePrefixes: ['.env'], extensions: ['.db', '.dump', '.log'] }
};

describe('about content version service', () => {
  it('reports SYNCED when runtime content matches despite squash-diverged history and documents the neutral differences', async () => {
    const local = snapshot([
      file('apps/server/src/app.ts', '1'),
      file('README.md', '2'),
      file('docs/local.md', '3'),
      file('tests/about.test.ts', '4')
    ]);
    const remote = [
      file('apps/server/src/app.ts', '1'),
      file('README.md', '5'),
      file('tests/about.test.ts', '4')
    ];
    const service = createService({ local, remote, base: [file('apps/server/src/app.ts', '0')], compareStatus: 'diverged', localOnly: 3, remoteOnly: 8 });

    await expect(service.check()).resolves.toMatchObject({
      syncStatus: 'SYNCED',
      runtimeStatus: 'CURRENT',
      contentComparison: {
        runtime: { status: 'MATCH', differenceCount: 0 },
        documentation: { status: 'DIFFERENT', differenceCount: 2 },
        verification: { status: 'MATCH', differenceCount: 0 }
      },
      historyComparison: { status: 'DIVERGED', localOnlyCommits: 3, remoteOnlyCommits: 8 }
    });
  });

  it('keeps SYNCED when only README, tests or CI differ', async () => {
    const local = snapshot([file('apps/web/src/App.tsx', '1'), file('README.md', '2'), file('tests/e2e/about.spec.ts', '3')]);
    const remote = [file('apps/web/src/App.tsx', '1'), file('README.md', '4'), file('.github/workflows/check.yml', '5')];
    const result = await createService({ local, remote, base: remote, compareStatus: 'diverged', localOnly: 1, remoteOnly: 2 }).check();
    expect(result.syncStatus).toBe('SYNCED');
    expect(result.contentComparison.runtime.status).toBe('MATCH');
    expect(result.contentComparison.documentation.status).toBe('DIFFERENT');
    expect(result.contentComparison.verification.status).toBe('DIFFERENT');
  });

  it.each([
    ['LOCAL_ONLY', [file('apps/app.ts', '2')], [file('apps/app.ts', '1')]],
    ['REMOTE_ONLY', [file('apps/app.ts', '1')], [file('apps/app.ts', '2')]],
    ['DIVERGED', [file('apps/app.ts', '2')], [file('apps/app.ts', '3')]]
  ] as const)('classifies runtime content as %s from merge-base changes', async (expected, localEntries, remoteEntries) => {
    const local = snapshot([...localEntries]);
    const result = await createService({
      local,
      remote: [...remoteEntries],
      base: [file('apps/app.ts', '1')],
      compareStatus: expected === 'LOCAL_ONLY' ? 'behind' : expected === 'REMOTE_ONLY' ? 'ahead' : 'diverged',
      localOnly: expected === 'REMOTE_ONLY' ? 0 : 1,
      remoteOnly: expected === 'LOCAL_ONLY' ? 0 : 1
    }).check();
    expect(result.syncStatus).toBe(expected);
    expect(result.contentComparison.runtime).toMatchObject({ status: 'DIFFERENT', differenceCount: 1 });
  });

  it('treats squash-equivalent runtime changes as shared content and keeps a new local file LOCAL_ONLY', async () => {
    const local = snapshot([file('apps/shared.ts', '2'), file('apps/local-new.ts', '3')]);
    const result = await createService({
      local,
      remote: [file('apps/shared.ts', '2')],
      base: [file('apps/shared.ts', '1')],
      compareStatus: 'diverged',
      localOnly: 4,
      remoteOnly: 8
    }).check();
    expect(result.syncStatus).toBe('LOCAL_ONLY');
    expect(result.historyComparison.status).toBe('DIVERGED');
  });

  it('marks the running service for rebuild when local runtime source changed after build', async () => {
    const built = snapshot([file('apps/app.ts', '1')]);
    const local = snapshot([file('apps/app.ts', '2')]);
    const result = await createService({ local, remote: [file('apps/app.ts', '2')], base: [file('apps/app.ts', '1')], build: buildInfo(built) }).check();
    expect(result.syncStatus).toBe('SYNCED');
    expect(result.runtimeStatus).toBe('REBUILD_REQUIRED');
  });

  it.each([
    ['a truncated GitHub tree', { truncated: true }],
    ['an incompatible remote scope contract', { remoteContractVersion: 2 }]
  ])('returns UNAVAILABLE for %s', async (_name, behavior) => {
    const local = snapshot([file('apps/app.ts', '1')]);
    const result = await createService({ local, remote: [file('apps/app.ts', '1')], ...behavior }).check();
    expect(result.syncStatus).toBe('UNAVAILABLE');
    expect(result.contentComparison.runtime.status).toBe('UNAVAILABLE');
    expect(result.error).toMatch(/完整|不兼容/);
  });

  it('keeps product and runtime information when GitHub is unavailable', async () => {
    const local = snapshot([file('apps/app.ts', '1')]);
    const fetchImpl = vi.fn(async () => { throw new Error('request timed out'); });
    const service = createAboutVersionService({
      repoRoot: '.',
      configVersion: 'v003',
      productVersion: '0.1.0',
      fetchImpl: fetchImpl as typeof fetch,
      now: () => CHECKED_AT,
      readContract: async () => CONTRACT,
      collectLocalSnapshot: async () => local,
      readBuildInfo: async () => buildInfo(local)
    });
    const result = await service.check();
    expect(result).toMatchObject({
      current: { productVersion: '0.1.0', configVersion: 'v003', commitSha: CURRENT_SHA },
      syncStatus: 'UNAVAILABLE',
      runtimeStatus: 'CURRENT'
    });
    expect(result.error).toContain('request timed out');
    expect(await service.check()).toBe(result);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('uses the dedicated read-only GitHub token, records expiry and retries anonymously without exposing it', async () => {
    const local = snapshot([file('apps/app.ts', '1')]);
    const token = 'github_pat_test_secret_value';
    const anonymousFetch = githubFetch({ local, remote: [file('apps/app.ts', '1')] });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization');
      if (authorization) {
        expect(authorization).toBe(`Bearer ${token}`);
        return json({ message: `bad credentials ${token}` }, 401);
      }
      return anonymousFetch(input);
    });
    const githubAccess = {
      initialize: vi.fn(async () => undefined),
      current: vi.fn(() => ({ token, source: 'MANAGED' as const })),
      status: vi.fn(() => ({ mode: 'AUTHENTICATED' as const, source: 'MANAGED' as const, state: 'UNVERIFIED' as const, anonymousFallback: false, canManage: true })),
      save: vi.fn(), useAnonymous: vi.fn(), recordSuccess: vi.fn(), recordFailure: vi.fn()
    };
    const service = createAboutVersionService({
      repoRoot: '.',
      configVersion: 'v003',
      productVersion: '0.1.0',
      githubAccess,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => CHECKED_AT,
      readContract: async () => CONTRACT,
      collectLocalSnapshot: async () => local,
      readBuildInfo: async () => buildInfo(local)
    });

    const result = await service.check();
    expect(result.syncStatus).toBe('SYNCED');
    expect(githubAccess.recordFailure).toHaveBeenCalledWith('INVALID', { authenticated: true });
    expect(githubAccess.recordSuccess).toHaveBeenCalledWith(expect.any(Response), { authenticated: false, fallback: true });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('explains anonymous GitHub rate-limit failures without retrying', async () => {
    const local = snapshot([file('apps/app.ts', '1')]);
    const fetchImpl = vi.fn(async () => json({ message: 'rate limit exceeded' }, 403));
    const service = createAboutVersionService({
      repoRoot: '.',
      configVersion: 'v003',
      productVersion: '0.1.0',
      fetchImpl: fetchImpl as typeof fetch,
      now: () => CHECKED_AT,
      readContract: async () => CONTRACT,
      collectLocalSnapshot: async () => local,
      readBuildInfo: async () => buildInfo(local)
    });

    const result = await service.check();
    expect(result.error).toBe('GitHub 匿名 API 配额已耗尽');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('prefers a stable release target over main', async () => {
    const local = snapshot([file('apps/app.ts', '1')]);
    const fetchImpl = githubFetch({ local, remote: [file('apps/app.ts', '1')], release: true });
    const result = await createService({ local, remote: [file('apps/app.ts', '1')], fetchImpl }).check();
    expect(result.available).toMatchObject({ source: 'release', label: 'v0.2.0' });
    expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith('/MerchRoute'))).toBe(false);
  });

  it('caches normal requests for ten minutes and explicit refresh bypasses the cache', async () => {
    const local = snapshot([file('apps/app.ts', '1')]);
    const fetchImpl = githubFetch({ local, remote: [file('apps/app.ts', '1')] });
    const service = createService({ local, remote: [file('apps/app.ts', '1')], fetchImpl });
    const first = await service.check();
    expect(await service.check()).toBe(first);
    const callsBeforeRefresh = fetchImpl.mock.calls.length;
    await service.check({ refresh: true });
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(callsBeforeRefresh);
  });
});

type ServiceFixture = {
  local: ContentFingerprintSnapshot;
  remote: GithubTreeEntry[];
  base?: GithubTreeEntry[];
  compareStatus?: string;
  localOnly?: number;
  remoteOnly?: number;
  truncated?: boolean;
  remoteContractVersion?: number;
  build?: AboutBuildInfo;
  fetchImpl?: ReturnType<typeof vi.fn>;
};

function createService(fixture: ServiceFixture) {
  return createAboutVersionService({
    repoRoot: '.',
    configVersion: 'v003',
    productVersion: '0.1.0',
    fetchImpl: (fixture.fetchImpl ?? githubFetch(fixture)) as typeof fetch,
    now: () => CHECKED_AT,
    readContract: async () => CONTRACT,
    collectLocalSnapshot: async () => fixture.local,
    readBuildInfo: async () => fixture.build ?? buildInfo(fixture.local)
  });
}

function githubFetch(fixture: Partial<ServiceFixture> & { local: ContentFingerprintSnapshot; remote: GithubTreeEntry[]; release?: boolean }) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/releases/latest')) return fixture.release
      ? json({ tag_name: 'v0.2.0', html_url: 'https://github.com/kyleliu-ai/MerchRoute/releases/tag/v0.2.0', published_at: CHECKED_AT.toISOString(), draft: false, prerelease: false })
      : json({}, 404);
    if (url.endsWith('/MerchRoute')) return json({ default_branch: 'main' });
    if (url.endsWith('/commits/main') || url.endsWith('/commits/v0.2.0')) return json({
      sha: REMOTE_SHA,
      html_url: `https://github.com/kyleliu-ai/MerchRoute/commit/${REMOTE_SHA}`,
      commit: { committer: { date: CHECKED_AT.toISOString() }, tree: { sha: REMOTE_TREE_SHA } }
    });
    if (url.includes(`/git/trees/${REMOTE_TREE_SHA}`)) {
      const tree = fixture.remoteContractVersion === undefined
        ? fixture.remote
        : [...fixture.remote, { path: 'config/content-fingerprint-scope.json', type: 'blob', sha: CONTRACT_BLOB_SHA }];
      return json({ truncated: fixture.truncated ?? false, tree });
    }
    if (url.includes(`/git/trees/${BASE_TREE_SHA}`)) return json({ truncated: false, tree: fixture.base ?? fixture.remote });
    if (url.includes(`/git/blobs/${CONTRACT_BLOB_SHA}`)) return json({ encoding: 'base64', content: Buffer.from(JSON.stringify({ schemaVersion: fixture.remoteContractVersion })).toString('base64') });
    if (url.includes('/compare/')) return json({
      status: fixture.compareStatus ?? 'diverged',
      ahead_by: fixture.remoteOnly ?? 8,
      behind_by: fixture.localOnly ?? 3,
      html_url: `https://github.com/kyleliu-ai/MerchRoute/compare/${CURRENT_SHA}...${REMOTE_SHA}`,
      merge_base_commit: { sha: 'dddddddddddddddddddddddddddddddddddddddd', commit: { tree: { sha: BASE_TREE_SHA } } }
    });
    throw new Error(`unexpected request: ${url}`);
  });
}

function snapshot(entries: GithubTreeEntry[]): ContentFingerprintSnapshot {
  return collectGithubTreeSnapshot(entries, CONTRACT);
}

function buildInfo(snapshotValue: ContentFingerprintSnapshot): AboutBuildInfo {
  return {
    schemaVersion: 1,
    productVersion: '0.1.0',
    configVersion: 'v003',
    builtAt: CHECKED_AT.toISOString(),
    commitSha: CURRENT_SHA,
    dirty: false,
    scopeVersion: 1,
    fingerprints: {
      runtime: snapshotValue.scopes.runtime.fingerprint,
      documentation: snapshotValue.scopes.documentation.fingerprint,
      verification: snapshotValue.scopes.verification.fingerprint
    },
    fileCounts: {
      runtime: snapshotValue.scopes.runtime.fileCount,
      documentation: snapshotValue.scopes.documentation.fileCount,
      verification: snapshotValue.scopes.verification.fileCount
    }
  };
}

function file(filePath: string, digit: string): GithubTreeEntry {
  return { path: filePath, type: 'blob', sha: digit.repeat(40) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
