import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAboutGithubAccessService } from './about-github-access.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const TOKEN_A = `github_pat_${'a'.repeat(40)}`;
const TOKEN_B = `github_pat_${'b'.repeat(40)}`;

describe('about GitHub access service', () => {
  const roots: string[] = [];

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('uses the legacy environment token only when no managed choice exists', async () => {
    const service = createAboutGithubAccessService({ appDataDir: await tempRoot(), encryptionKey: KEY, legacyToken: TOKEN_A });
    await service.initialize();
    expect(service.current()).toEqual({ token: TOKEN_A, source: 'ENVIRONMENT' });
    expect(service.status()).toMatchObject({ mode: 'AUTHENTICATED', source: 'ENVIRONMENT', state: 'UNVERIFIED' });
  });

  it('validates and atomically persists an encrypted token without writing plaintext', async () => {
    const root = await tempRoot();
    const fetchImpl = vi.fn(async () => githubResponse(200, 4997, 5000));
    const service = createAboutGithubAccessService({ appDataDir: root, encryptionKey: KEY, fetchImpl: fetchImpl as typeof fetch, now: fixedNow });
    await service.initialize();

    await expect(service.save(TOKEN_A)).resolves.toMatchObject({
      mode: 'AUTHENTICATED', source: 'MANAGED', state: 'VERIFIED',
      rateLimit: { remaining: 4997, limit: 5000 }
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(new Headers(fetchImpl.mock.calls[0]![1]?.headers).get('authorization')).toBe(`Bearer ${TOKEN_A}`);

    const stored = await readFile(path.join(root, 'github-about-access.v1.json'), 'utf8');
    expect(stored).not.toContain(TOKEN_A);
    expect(stored).not.toContain('authorization');

    const reloaded = createAboutGithubAccessService({ appDataDir: root, encryptionKey: KEY });
    await reloaded.initialize();
    expect(reloaded.current()).toEqual({ token: TOKEN_A, source: 'MANAGED' });
  });

  it('keeps the previous token when replacement validation fails', async () => {
    const root = await tempRoot();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(githubResponse(200, 4997, 5000))
      .mockResolvedValueOnce(githubResponse(401, 4996, 5000));
    const service = createAboutGithubAccessService({ appDataDir: root, encryptionKey: KEY, fetchImpl: fetchImpl as typeof fetch });
    await service.initialize();
    await service.save(TOKEN_A);
    await expect(service.save(TOKEN_B)).rejects.toMatchObject({ code: 'GITHUB_TOKEN_INVALID' });
    expect(service.current().token).toBe(TOKEN_A);
    expect(await readFile(path.join(root, 'github-about-access.v1.json'), 'utf8')).not.toContain(TOKEN_B);
  });

  it('persists an explicit anonymous choice that overrides a legacy environment token', async () => {
    const root = await tempRoot();
    const service = createAboutGithubAccessService({ appDataDir: root, encryptionKey: KEY, legacyToken: TOKEN_A });
    await service.initialize();
    await service.useAnonymous();
    expect(service.current()).toEqual({ source: 'NONE' });

    const reloaded = createAboutGithubAccessService({ appDataDir: root, encryptionKey: KEY, legacyToken: TOKEN_A });
    await reloaded.initialize();
    expect(reloaded.current()).toEqual({ source: 'NONE' });
    expect(reloaded.status()).toMatchObject({ mode: 'ANONYMOUS', source: 'NONE' });
  });

  it('falls back safely when encrypted storage is tampered with', async () => {
    const root = await tempRoot();
    const service = createAboutGithubAccessService({ appDataDir: root, encryptionKey: KEY, fetchImpl: (async () => githubResponse()) as typeof fetch });
    await service.initialize();
    await service.save(TOKEN_A);
    const file = path.join(root, 'github-about-access.v1.json');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    stored.token.ciphertext = `${stored.token.ciphertext}AA`;
    await writeFile(file, JSON.stringify(stored), 'utf8');

    const reloaded = createAboutGithubAccessService({ appDataDir: root, encryptionKey: KEY, legacyToken: TOKEN_B });
    await reloaded.initialize();
    expect(reloaded.current()).toEqual({ source: 'MANAGED' });
    expect(reloaded.status()).toMatchObject({ mode: 'ANONYMOUS', source: 'MANAGED', state: 'UNAVAILABLE', anonymousFallback: true });
  });

  it('does not persist a token when the encryption key is unavailable', async () => {
    const root = await tempRoot();
    const service = createAboutGithubAccessService({ appDataDir: root, encryptionKey: '', fetchImpl: (async () => githubResponse()) as typeof fetch });
    await service.initialize();
    await expect(service.save(TOKEN_A)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(readFile(path.join(root, 'github-about-access.v1.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'merchroute-about-access-'));
    roots.push(root);
    return root;
  }
});

function fixedNow(): Date {
  return new Date('2026-09-01T08:00:00.000Z');
}

function githubResponse(status = 200, remaining = 59, limit = 60): Response {
  return new Response('{}', {
    status,
    headers: {
      'content-type': 'application/json',
      'x-ratelimit-limit': String(limit),
      'x-ratelimit-remaining': String(remaining),
      'x-ratelimit-reset': String(Math.floor(new Date('2026-09-01T09:00:00.000Z').getTime() / 1000))
    }
  });
}
