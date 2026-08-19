import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WbStoreGatewayService } from './gateway.js';

const identity = {
  storeId: '11111111-1111-4111-8111-111111111111',
  storeAlias: 'second',
  warehouseId: '12345',
  configVersion: 1,
  rootDirectory: 'C:/WB',
  storeEnabled: true,
  leaseActive: true,
  credential: {
    id: '22222222-2222-4222-8222-222222222222',
    storeId: '11111111-1111-4111-8111-111111111111',
    version: 1,
    status: 'ACTIVE' as const,
    ciphertext: 'cipher', nonce: 'nonce', authTag: 'tag', fingerprint: 'fingerprint', keyVersion: 1
  }
};

function harness() {
  const repository = {
    getGatewayIdentity: vi.fn(async () => identity),
    beginGatewayRequest: vi.fn(async () => ({ idempotent: false, row: {} })),
    completeGatewayRequest: vi.fn(async () => undefined)
  };
  const stores = { decryptGatewayCredential: vi.fn(() => 'vault-token-never-persist') };
  return {
    repository,
    stores,
    gateway: new WbStoreGatewayService(repository as any, stores as any)
  };
}

describe('WbStoreGatewayService', () => {
  const temporaryRoots: string[] = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('rejects credential-like payload fields before lookup or ledger persistence', async () => {
    const { gateway, repository } = harness();
    await expect(gateway.execute({
      storeId: identity.storeId,
      requestRef: 'request-secret-1',
      operation: 'SELLER_WAREHOUSES',
      payload: { authorization: 'Bearer leaked' }
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(repository.getGatewayIdentity).not.toHaveBeenCalled();
    expect(repository.beginGatewayRequest).not.toHaveBeenCalled();
  });

  it('rejects every write that is not bound to an immutable runtime task snapshot', async () => {
    const { gateway, repository } = harness();
    await expect(gateway.execute({
      storeId: identity.storeId,
      requestRef: 'store-only-write',
      operation: 'CARD_UPLOAD',
      payload: { body: [{ vendorCode: '0000110-01' }] }
    })).rejects.toMatchObject({ code: 'TASK_ID_REQUIRED' });
    expect(repository.beginGatewayRequest).not.toHaveBeenCalled();
  });

  it('allows task-scoped readback after a store is disabled and its lease expires, but rejects writes', async () => {
    const { gateway, repository } = harness();
    repository.getGatewayIdentity.mockResolvedValue({
      ...identity,
      taskId: 'second__0000110__r1',
      storeEnabled: false,
      leaseActive: false
    } as any);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ cards: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(gateway.execute({
      taskId: 'second__0000110__r1',
      requestRef: 'disabled-readback',
      operation: 'CARDS_LIST_ACTIVE',
      payload: { settings: { cursor: { limit: 1 } } }
    })).resolves.toMatchObject({ ok: true, deliveryState: 'RESPONDED' });

    await expect(gateway.execute({
      taskId: 'second__0000110__r1',
      requestRef: 'disabled-write',
      operation: 'CARD_UPLOAD',
      payload: { body: [{ vendorCode: '0000110-01' }] }
    })).rejects.toMatchObject({ code: 'WB_STORE_DISABLED' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(repository.beginGatewayRequest).toHaveBeenCalledOnce();
  });

  it('keeps DIRECTORY_LOOKUP on the exact six-directory allowlist', async () => {
    const allowed = ['colors', 'countries', 'seasons', 'kinds', 'vat', 'tnved'];
    for (const directory of allowed) {
      const { gateway } = harness();
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
      await expect(gateway.execute({
        storeId: identity.storeId,
        requestRef: `directory-${directory}`,
        operation: 'DIRECTORY_LOOKUP',
        payload: directory === 'tnved' ? { directory, subjectId: 105 } : { directory }
      })).resolves.toMatchObject({ ok: true, deliveryState: 'RESPONDED' });
    }
    const { gateway } = harness();
    await expect(gateway.execute({
      storeId: identity.storeId,
      requestRef: 'directory-unknown',
      operation: 'DIRECTORY_LOOKUP',
      payload: { directory: 'arbitrary-slug' }
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('uses the fixed seller information endpoint for verified preflight identity', async () => {
    const { gateway } = harness();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sid: identity.storeId, name: 'Seller' }), {
      status: 200, headers: { 'content-type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(gateway.execute({
      storeId: identity.storeId,
      requestRef: 'seller-info-1',
      operation: 'SELLER_INFO',
      payload: {}
    })).resolves.toMatchObject({ ok: true });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://common-api.wildberries.ru/api/v1/seller-info');
    expect(fetchMock.mock.calls[0]![1]?.method).toBe('GET');
  });

  it('accepts a cached transcoded video only when both derivative and manifest source hashes match', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wb-gateway-'));
    temporaryRoots.push(root);
    const work = path.join(root, 'task');
    await mkdir(path.join(work, '.wb-media-cache'), { recursive: true });
    await mkdir(path.join(work, 'videos'), { recursive: true });
    await mkdir(path.join(work, 'variants'), { recursive: true });
    const source = Buffer.from('original-video');
    const derivative = Buffer.from('compressed-video');
    const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
    await writeFile(path.join(work, 'videos', 'source.mp4'), source);
    await writeFile(path.join(work, '.wb-media-cache', 'source-compressed.mp4'), derivative);
    await writeFile(path.join(work, 'variants', 'variant-media-manifest.json'), JSON.stringify({
      assets: [{ relativePath: 'videos/source.mp4', sha256: digest(source) }]
    }));
    const { gateway, repository } = harness();
    repository.getGatewayIdentity.mockResolvedValue({ ...identity, rootDirectory: root, workRelpath: 'task', taskId: 'second__0000110__r1' } as any);
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(gateway.execute({
      taskId: 'second__0000110__r1',
      requestRef: 'media-derivative-1',
      operation: 'MEDIA_UPLOAD_FILE',
      payload: {
        nmId: 123, photoNumber: 1, kind: 'video',
        relativePath: '.wb-media-cache/source-compressed.mp4', sha256: digest(derivative),
        sourceRelativePath: 'videos/source.mp4', sourceSha256: digest(source)
      }
    })).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();

    await expect(gateway.execute({
      taskId: 'second__0000110__r1',
      requestRef: 'media-derivative-bad-source',
      operation: 'MEDIA_UPLOAD_FILE',
      payload: {
        nmId: 123, photoNumber: 1, kind: 'video',
        relativePath: '.wb-media-cache/source-compressed.mp4', sha256: digest(derivative),
        sourceRelativePath: 'videos/source.mp4', sourceSha256: '0'.repeat(64)
      }
    })).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('allows original media source identity fields only when both pairs are identical', async () => {
    const { gateway } = harness();
    await expect(gateway.execute({
      storeId: identity.storeId,
      requestRef: 'media-source-mismatch',
      operation: 'MEDIA_UPLOAD_FILE',
      payload: {
        nmId: 123, photoNumber: 1, kind: 'image', relativePath: 'images/a.jpg', sha256: 'a'.repeat(64),
        sourceRelativePath: 'images/b.jpg', sourceSha256: 'a'.repeat(64)
      }
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('classifies an uncertain write as UNKNOWN and persists only a request hash plus redacted response', async () => {
    const { gateway, repository } = harness();
    repository.getGatewayIdentity.mockResolvedValue({ ...identity, taskId: 'second__0000110__r1' } as any);
    const fetchMock = vi.fn(async () => {
      const error = new TypeError('socket closed after upload');
      (error as any).cause = { code: 'ECONNRESET' };
      throw error;
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(gateway.execute({
      taskId: 'second__0000110__r1',
      requestRef: 'second__0000110__r1:CARD_WRITE:card-intent-110:attempt-1',
      operation: 'CARD_UPLOAD',
      payload: { body: [{ vendorCode: '0000110-01' }] }
    })).resolves.toMatchObject({ ok: false, deliveryState: 'UNKNOWN', retryClass: 'READBACK_REQUIRED' });
    expect(repository.beginGatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      operation: 'CARD_UPLOAD',
      logicalIntentId: 'card-intent-110',
      attemptNo: 1
    }));
    expect(repository.completeGatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      transportCode: 'ECONNRESET',
      transportPhase: 'REQUEST',
      deliveryState: 'UNKNOWN'
    }));
    expect(JSON.stringify(repository.beginGatewayRequest.mock.calls)).not.toContain('vault-token-never-persist');
    expect(JSON.stringify(repository.completeGatewayRequest.mock.calls)).not.toContain('vault-token-never-persist');
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe('vault-token-never-persist');
  });

  it('rejects a conflicting explicit CARD_UPLOAD intent before creating a ledger row', async () => {
    const { gateway, repository } = harness();
    repository.getGatewayIdentity.mockResolvedValue({ ...identity, taskId: 'second__0000110__r1' } as any);
    await expect(gateway.execute({
      taskId: 'second__0000110__r1',
      requestRef: 'second__0000110__r1:CARD_WRITE:frozen-intent:attempt-2',
      operation: 'CARD_UPLOAD',
      logicalIntentId: 'different-intent',
      attemptNo: 2,
      payload: { body: [{ vendorCode: '0000110-01' }] }
    })).rejects.toMatchObject({ code: 'WB_CARD_INTENT_CONFLICT' });
    expect(repository.beginGatewayRequest).not.toHaveBeenCalled();
  });

  it('keeps the pre-intent timestamp CARD_UPLOAD requestRef compatible as legacy attempt 1', async () => {
    const { gateway, repository } = harness();
    repository.getGatewayIdentity.mockResolvedValue({ ...identity, taskId: 'second__0000110__r1' } as any);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    await expect(gateway.execute({
      taskId: 'second__0000110__r1',
      requestRef: 'second__0000110__r1:CARD_WRITE:2026-08-14T03:12:10.390Z:0',
      operation: 'CARD_UPLOAD',
      payload: { body: [{ vendorCode: '0000110-01' }] }
    })).resolves.toMatchObject({ ok: true });
    expect(repository.beginGatewayRequest).toHaveBeenCalledWith(expect.not.objectContaining({
      logicalIntentId: expect.anything()
    }));
  });

  it('redacts credential fields from a WB response before returning and writing the ledger', async () => {
    const { gateway, repository } = harness();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ token: 'remote-secret', nested: { authorization: 'Bearer abc' } }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })));
    const result = await gateway.execute({
      storeId: identity.storeId,
      requestRef: 'redact-response-1',
      operation: 'SELLER_WAREHOUSES',
      payload: {}
    });
    expect(result.body).toEqual({ token: '[REDACTED]', nested: { authorization: '[REDACTED]' } });
    expect(JSON.stringify(repository.completeGatewayRequest.mock.calls)).not.toContain('remote-secret');
  });
});
