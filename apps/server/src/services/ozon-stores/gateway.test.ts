import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError, OZON_DEFAULT_STORE_ID } from '@n8n-media-review/shared';
import { OzonStoreGatewayService } from './gateway.js';

const originalFetch = globalThis.fetch;
const gatewayLeaseToken = '00000000-0000-4000-8000-000000000091';

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('OzonStoreGatewayService strict gateway', () => {
  it('proves store-scoped absence only with the exact frozen ACTIVE credential and two strict empty reads', async () => {
    const identity = vaultIdentity({ task: false });
    const stores = repositoryMock(identity);
    stores.getExactStoreReadbackIdentity.mockResolvedValue(identity);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/v3/product/info/list')) {
        return new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: { items: [], total: 0 } }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const proof = await gateway(stores).proveStoreOfferAbsence({
      storeId: identity.storeId,
      expectedStoreConfigVersion: identity.storeConfigVersion,
      expectedCredentialVersionId: identity.credentialVersionId!,
      offerIds: ['9900002-02', '9900002-01']
    });

    expect(proof).toMatchObject({
      absent: true,
      status: 'CONFIRMED_ABSENT',
      storeId: identity.storeId,
      storeConfigVersion: identity.storeConfigVersion,
      credentialVersionId: identity.credentialVersionId,
      offerIds: ['9900002-01', '9900002-02'],
      evidenceHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      operations: [
        { operation: 'infoList', statusCode: 200, itemCount: 0, paginationComplete: true },
        { operation: 'attributesInfo', statusCode: 200, itemCount: 0, paginationComplete: true }
      ]
    });
    expect(stores.getExactStoreReadbackIdentity).toHaveBeenCalledTimes(2);
    expect(stores.getExactStoreReadbackIdentity).toHaveBeenNthCalledWith(1, {
      storeId: identity.storeId,
      expectedStoreConfigVersion: identity.storeConfigVersion,
      expectedCredentialVersionId: identity.credentialVersionId,
      offerIds: ['9900002-01', '9900002-02']
    });
    expect(stores.beginGatewayRequest).not.toHaveBeenCalled();
    expect(stores.completeGatewayRequest).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ offer_id: ['9900002-01', '9900002-02'] });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      filter: { offer_id: ['9900002-01', '9900002-02'] }, limit: 100
    });
  });

  it('fails closed when either store-scoped read returns a target, an unexpected row or incomplete pagination', async () => {
    const identity = vaultIdentity({ task: false });
    const cases = [
      { body: { items: [{ offer_id: '9900002-01' }], total: 1 }, code: 'OZON_REMOTE_STATE_PRESENT' },
      { body: { items: [{ offer_id: 'foreign-offer' }], total: 1 }, code: 'OZON_REMOTE_STATE_UNPROVEN' },
      { body: { items: [], cursor: 'next-page' }, code: 'OZON_REMOTE_STATE_UNPROVEN' }
    ];
    for (const candidate of cases) {
      const stores = repositoryMock(identity);
      stores.getExactStoreReadbackIdentity.mockResolvedValue(identity);
      globalThis.fetch = vi.fn(async (url: string) => new Response(JSON.stringify(
        url.endsWith('/v3/product/info/list') ? candidate.body : { result: { items: [], total: 0 } }
      ), { status: 200 })) as typeof fetch;
      await expect(gateway(stores).proveStoreOfferAbsence({
        storeId: identity.storeId,
        expectedStoreConfigVersion: identity.storeConfigVersion,
        expectedCredentialVersionId: identity.credentialVersionId!,
        offerIds: ['9900002-01']
      })).rejects.toMatchObject({
        code: candidate.code,
        statusCode: 409,
        ...(candidate.code === 'OZON_REMOTE_STATE_UNPROVEN' ? { details: { outcome: 'UNKNOWN' } } : {})
      });
    }
  });

  it('accepts only the exact attributesInfo HTTP 404 code 5 item-not-found contract after infoList proves empty', async () => {
    const identity = vaultIdentity({ task: false });
    const stores = repositoryMock(identity);
    stores.getExactStoreReadbackIdentity.mockResolvedValue(identity);
    globalThis.fetch = vi.fn(async (url: string) => url.endsWith('/v3/product/info/list')
      ? new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 })
      : new Response(JSON.stringify({ code: 5, message: 'item not found', details: [] }), { status: 404 })) as typeof fetch;

    const proof = await gateway(stores).proveStoreOfferAbsence({
      storeId: identity.storeId,
      expectedStoreConfigVersion: identity.storeConfigVersion,
      expectedCredentialVersionId: identity.credentialVersionId!,
      offerIds: ['9900002-01']
    });

    expect(proof.operations).toEqual([
      expect.objectContaining({ operation: 'infoList', statusCode: 200, itemCount: 0 }),
      expect.objectContaining({
        operation: 'attributesInfo', statusCode: 404, responseShape: 'NOT_FOUND_ERROR', itemCount: 0, errorCode: '5'
      })
    ]);
    expect(proof).toMatchObject({ absent: true, status: 'CONFIRMED_ABSENT' });
    expect(stores.beginGatewayRequest).not.toHaveBeenCalled();
  });

  it.each([
    { code: 6, message: 'item not found', details: [] },
    { code: 5, message: 'another error', details: [] },
    { code: 5, message: 'item not found', details: [{ field: 'offer_id' }] },
    { code: 5, message: 'item not found', details: [], result: [] }
  ])('rejects an ambiguous attributesInfo HTTP 404 body: %j', async (body) => {
    const identity = vaultIdentity({ task: false });
    const stores = repositoryMock(identity);
    stores.getExactStoreReadbackIdentity.mockResolvedValue(identity);
    globalThis.fetch = vi.fn(async (url: string) => url.endsWith('/v3/product/info/list')
      ? new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 })
      : new Response(JSON.stringify(body), { status: 404 })) as typeof fetch;

    await expect(gateway(stores).proveStoreOfferAbsence({
      storeId: identity.storeId,
      expectedStoreConfigVersion: identity.storeConfigVersion,
      expectedCredentialVersionId: identity.credentialVersionId!,
      offerIds: ['9900002-01']
    })).rejects.toMatchObject({
      code: 'OZON_REMOTE_STATE_UNPROVEN',
      details: { statusCode: 404, outcome: 'UNKNOWN' }
    });
  });

  it('keeps infoList HTTP 404 classified as UNKNOWN even when it resembles item-not-found', async () => {
    const identity = vaultIdentity({ task: false });
    const stores = repositoryMock(identity);
    stores.getExactStoreReadbackIdentity.mockResolvedValue(identity);
    globalThis.fetch = vi.fn(async (url: string) => url.endsWith('/v3/product/info/list')
      ? new Response(JSON.stringify({ code: 5, message: 'item not found', details: [] }), { status: 404 })
      : new Response(JSON.stringify({ result: { items: [], total: 0 } }), { status: 200 })) as typeof fetch;

    await expect(gateway(stores).proveStoreOfferAbsence({
      storeId: identity.storeId,
      expectedStoreConfigVersion: identity.storeConfigVersion,
      expectedCredentialVersionId: identity.credentialVersionId!,
      offerIds: ['9900002-01']
    })).rejects.toMatchObject({
      code: 'OZON_REMOTE_STATE_UNPROVEN',
      details: { statusCode: 404, operation: 'infoList', outcome: 'UNKNOWN' }
    });
  });

  it.each([429, 500])('treats HTTP %s from a store-scoped read as UNKNOWN and never creates write intent', async (status) => {
    const identity = vaultIdentity({ task: false });
    const stores = repositoryMock(identity);
    stores.getExactStoreReadbackIdentity.mockResolvedValue(identity);
    globalThis.fetch = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.endsWith('/v3/product/info/list') ? { message: 'not conclusive' } : { result: { items: [], total: 0 } }
    ), { status: url.endsWith('/v3/product/info/list') ? status : 200 })) as typeof fetch;

    await expect(gateway(stores).proveStoreOfferAbsence({
      storeId: identity.storeId,
      expectedStoreConfigVersion: identity.storeConfigVersion,
      expectedCredentialVersionId: identity.credentialVersionId!,
      offerIds: ['9900002-01']
    })).rejects.toMatchObject({
      code: 'OZON_REMOTE_STATE_UNPROVEN',
      details: { statusCode: status, outcome: 'UNKNOWN' }
    });
    expect(stores.beginGatewayRequest).not.toHaveBeenCalled();
  });

  it('rejects an HTTP 200 empty array that also carries an application-level error', async () => {
    const identity = vaultIdentity({ task: false });
    const stores = repositoryMock(identity);
    stores.getExactStoreReadbackIdentity.mockResolvedValue(identity);
    globalThis.fetch = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.endsWith('/v3/product/info/list')
        ? { items: [], total: 0, error: { code: 'INTERNAL_ERROR' } }
        : { result: { items: [], total: 0 } }
    ), { status: 200 })) as typeof fetch;

    await expect(gateway(stores).proveStoreOfferAbsence({
      storeId: identity.storeId,
      expectedStoreConfigVersion: identity.storeConfigVersion,
      expectedCredentialVersionId: identity.credentialVersionId!,
      offerIds: ['9900002-01']
    })).rejects.toMatchObject({
      code: 'OZON_REMOTE_STATE_UNPROVEN',
      details: { outcome: 'UNKNOWN' }
    });
  });

  it('treats transport failure and post-read credential drift as unproven', async () => {
    const identity = vaultIdentity({ task: false });
    const stores = repositoryMock(identity);
    stores.getExactStoreReadbackIdentity.mockResolvedValue(identity);
    globalThis.fetch = vi.fn(async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); }) as typeof fetch;
    const input = {
      storeId: identity.storeId,
      expectedStoreConfigVersion: identity.storeConfigVersion,
      expectedCredentialVersionId: identity.credentialVersionId!,
      offerIds: ['9900002-01']
    };
    await expect(gateway(stores).proveStoreOfferAbsence(input)).rejects.toMatchObject({
      code: 'OZON_REMOTE_STATE_UNPROVEN',
      details: { outcome: 'UNKNOWN' }
    });

    stores.getExactStoreReadbackIdentity
      .mockReset()
      .mockResolvedValueOnce(identity)
      .mockRejectedValueOnce(new AppError('VERSION_CONFLICT', 'changed', undefined, 409));
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 })) as typeof fetch;
    await expect(gateway(stores).proveStoreOfferAbsence(input)).rejects.toMatchObject({
      code: 'OZON_REMOTE_STATE_UNPROVEN',
      details: { causeCode: 'VERSION_CONFLICT' }
    });
  });

  it('allows store-scoped global category reads with the active credential', async () => {
    const stores = repositoryMock(vaultIdentity({ task: false }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: [] }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const response = await gateway(stores).execute({
      storeId: OZON_DEFAULT_STORE_ID,
      requestRef: 'category-read-1',
      operation: 'categoryTree',
      payload: { language: 'DEFAULT' }
    });
    expect(response).toMatchObject({ ok: true, deliveryState: 'RESPONDED', retryClass: 'NONE' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api-seller.ozon.ru/v1/description-category/tree');
  });

  it('locks stocksRead to v4 and treats 429 as definitely not sent', async () => {
    const stores = repositoryMock(vaultIdentity());
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: 'rate limited' }), {
      status: 429,
      headers: { 'retry-after': '2' }
    }));
    globalThis.fetch = fetchMock as typeof fetch;
    const response = await gateway(stores).execute({
      taskId: 'default__9900002__r1',
      publicationId: '10000000-0000-4000-8000-000000000001',
      leaseToken: gatewayLeaseToken,
      requestRef: 'stocks-read-1',
      operation: 'stocksRead',
      payload: { cursor: '', filter: { offer_id: ['9900002-01'], visibility: 'ALL' }, limit: 100 }
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api-seller.ozon.ru/v4/product/info/stocks');
    expect(response).toMatchObject({ deliveryState: 'NOT_SENT', retryClass: 'RETRYABLE', retryAfterMs: 2_000 });
  });

  it('locks picturesInfo to the supported v2 endpoint', async () => {
    const stores = repositoryMock(vaultIdentity());
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const response = await gateway(stores).execute({
      taskId: 'default__9900002__r1',
      publicationId: '10000000-0000-4000-8000-000000000001',
      leaseToken: gatewayLeaseToken,
      requestRef: 'pictures-info-v2',
      operation: 'picturesInfo',
      payload: { product_id: 501 }
    });
    expect(response.ok).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api-seller.ozon.ru/v2/product/pictures/info');
    expect(stores.getProvisionalImportProductIds).not.toHaveBeenCalled();
  });

  it('allows picturesInfo for a product proven by this publication importInfo ledger', async () => {
    const identity = { ...vaultIdentity(), productIds: [] };
    const stores = repositoryMock(identity);
    stores.getProvisionalImportProductIds.mockResolvedValue(['501']);
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const response = await gateway(stores).execute({
      taskId: identity.taskId,
      publicationId: identity.publicationId,
      requestRef: 'pictures-info-provisional',
      operation: 'picturesInfo',
      payload: { product_id: 501 }
    });
    expect(stores.getProvisionalImportProductIds).toHaveBeenCalledWith({
      taskId: identity.taskId,
      publicationId: identity.publicationId,
      storeId: OZON_DEFAULT_STORE_ID
    });
    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not let provisional read evidence authorize a foreign product or picturesImport write', async () => {
    const identity = { ...vaultIdentity(), productIds: [] };
    const stores = repositoryMock(identity);
    stores.getProvisionalImportProductIds.mockResolvedValue(['501']);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    const service = gateway(stores);
    const foreignRead = await service.execute({
      taskId: identity.taskId,
      publicationId: identity.publicationId,
      requestRef: 'pictures-info-foreign-provisional',
      operation: 'picturesInfo',
      payload: { product_id: 999 }
    });
    const provisionalWrite = await service.execute({
      taskId: identity.taskId,
      publicationId: identity.publicationId,
      leaseToken: gatewayLeaseToken,
      requestRef: 'pictures-import-provisional-denied',
      operation: 'picturesImport',
      payload: { product_id: 501, images: ['https://example.test/image.jpg'] }
    });
    expect(foreignRead).toMatchObject({
      deliveryState: 'NOT_SENT', retryClass: 'PERMANENT', error: { code: 'VERSION_CONFLICT' }
    });
    expect(provisionalWrite).toMatchObject({
      deliveryState: 'NOT_SENT', retryClass: 'PERMANENT', error: { code: 'VERSION_CONFLICT' }
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reclaims an existing retryable NOT_SENT ledger instead of returning an empty idempotent response', async () => {
    const stores = repositoryMock(vaultIdentity());
    stores.beginGatewayRequest.mockResolvedValue({ existing: {
      request_hash: 'ignored-by-mock', delivery_state: 'NOT_SENT', retry_class: 'RETRYABLE',
      delegation_state: 'NONE', response_json: {}, status_code: 429
    } });
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
    const response = await gateway(stores).execute({
      taskId: 'default__9900002__r1',
      publicationId: '10000000-0000-4000-8000-000000000001',
      leaseToken: gatewayLeaseToken,
      requestRef: 'retry-not-sent-1',
      operation: 'infoList',
      payload: { offer_id: ['9900002-01'] }
    });
    expect(stores.markGatewaySending).toHaveBeenCalledOnce();
    expect(response.ok).toBe(true);
  });

  it('issues one ephemeral legacy signal and never reauthorizes the same requestRef after a crash', async () => {
    const identity = legacyIdentity('LEGACY_PUBLICATION');
    let persisted: Record<string, unknown> | undefined;
    const stores = repositoryMock(identity);
    stores.beginGatewayRequest.mockImplementation(async () => persisted ? { existing: persisted } : {});
    stores.markLegacyDelegationIntent.mockImplementation(async () => {
      persisted = {
        delivery_state: 'UNKNOWN', retry_class: 'READBACK_REQUIRED', delegation_state: 'AUTHORIZED_ONCE',
        response_json: { legacyDispatchWithheld: true }, credential_binding_mode: 'LEGACY_PUBLICATION'
      };
      return true;
    });
    const service = gateway(stores);
    const request = {
      taskId: 'default__9900002__r1',
      publicationId: '10000000-0000-4000-8000-000000000001',
      leaseToken: gatewayLeaseToken,
      requestRef: 'legacy-once-1',
      operation: 'infoList',
      payload: { offer_id: ['9900002-01'] }
    };
    const first = await service.execute(request);
    const second = await service.execute(request);
    expect(first).toMatchObject({ statusCode: 428, deliveryState: 'NOT_SENT', retryClass: 'NONE' });
    expect((first.result as any).__merchRouteLegacy).toMatchObject({
      version: 1, storeId: OZON_DEFAULT_STORE_ID, bindingMode: 'LEGACY_PUBLICATION'
    });
    expect(second).toMatchObject({ deliveryState: 'UNKNOWN', retryClass: 'READBACK_REQUIRED', idempotent: true });
    expect((second.result as any).__merchRouteLegacy).toBeUndefined();
    expect(stores.markLegacyDelegationIntent).toHaveBeenCalledOnce();
  });

  it('rejects PURE_LEGACY writes before any delegation intent', async () => {
    const stores = repositoryMock(legacyIdentity('PURE_LEGACY'));
    const response = await gateway(stores).execute({
      taskId: 'default__9900002__r1',
      publicationId: '10000000-0000-4000-8000-000000000001',
      leaseToken: gatewayLeaseToken,
      requestRef: 'pure-legacy-write-1',
      operation: 'importProduct',
      payload: { items: [{ offer_id: '9900002-01' }] }
    });
    expect(response).toMatchObject({ deliveryState: 'NOT_SENT', retryClass: 'PERMANENT' });
    expect(stores.markLegacyDelegationIntent).not.toHaveBeenCalled();
  });

  it('classifies a 401 as a permanent responded rejection', async () => {
    const stores = repositoryMock(vaultIdentity());
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ message: 'unauthorized' }), { status: 401 })) as typeof fetch;
    const response = await gateway(stores).execute(readRequest('http-401'));
    expect(response).toMatchObject({ statusCode: 401, deliveryState: 'RESPONDED', retryClass: 'PERMANENT' });
  });

  it('classifies write 5xx and an ambiguous write timeout as UNKNOWN/readback required', async () => {
    const stores = repositoryMock(vaultIdentity());
    const service = gateway(stores);
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 503 })) as typeof fetch;
    const serverError = await service.execute(writeRequest('write-503'));
    expect(serverError).toMatchObject({ statusCode: 503, deliveryState: 'UNKNOWN', retryClass: 'READBACK_REQUIRED' });

    globalThis.fetch = vi.fn(async () => {
      throw Object.assign(new Error('write timed out after connect'), { code: 'ETIMEDOUT' });
    }) as typeof fetch;
    const timeout = await service.execute(writeRequest('write-timeout'));
    expect(timeout).toMatchObject({ statusCode: 0, deliveryState: 'UNKNOWN', retryClass: 'READBACK_REQUIRED' });
  });

  it('allows attributesUpdate only for the two frozen color attributes', async () => {
    const stores = repositoryMock(vaultIdentity());
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: { task_id: 123 } }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const service = gateway(stores);
    const exact = await service.execute({
      taskId: 'default__9900002__r1',
      publicationId: '10000000-0000-4000-8000-000000000001',
      leaseToken: gatewayLeaseToken,
      requestRef: 'attributes-update-exact',
      operation: 'attributesUpdate',
      payload: {
        items: [{
          offer_id: '9900002-01',
          attributes: [
            { id: 10096, complex_id: 0, values: [{ dictionary_value_id: 972075644 }] },
            { id: 10097, complex_id: 0, values: [{ value: 'кофе' }] }
          ]
        }]
      }
    });
    expect(exact.ok).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api-seller.ozon.ru/v1/product/attributes/update');

    const rejected = await service.execute({
      taskId: 'default__9900002__r1',
      publicationId: '10000000-0000-4000-8000-000000000001',
      leaseToken: gatewayLeaseToken,
      requestRef: 'attributes-update-extra',
      operation: 'attributesUpdate',
      payload: {
        items: [{ offer_id: '9900002-01', attributes: [{ id: 10096 }, { id: 10097 }, { id: 85 }] }]
      }
    });
    expect(rejected).toMatchObject({
      deliveryState: 'NOT_SENT', retryClass: 'PERMANENT', error: { code: 'CONFIG_INVALID' }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a proven connection-before-send failure retryable NOT_SENT', async () => {
    const stores = repositoryMock(vaultIdentity());
    globalThis.fetch = vi.fn(async () => {
      throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    }) as typeof fetch;
    const response = await gateway(stores).execute(writeRequest('connect-refused'));
    expect(response).toMatchObject({ statusCode: 0, deliveryState: 'NOT_SENT', retryClass: 'RETRYABLE' });
  });

  it('fences a VAULT write when the lease is lost between identity lookup and final send CAS', async () => {
    const stores = repositoryMock(vaultIdentity());
    stores.markGatewaySending.mockResolvedValue(false);
    stores.getGatewayRequest.mockResolvedValue({
      delivery_state: 'NOT_SENT', retry_class: 'NONE', delegation_state: 'NONE', response_json: {}
    });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    const response = await gateway(stores).execute(writeRequest('lease-toctou-vault'));
    expect(stores.markGatewaySending).toHaveBeenCalledWith('lease-toctou-vault', gatewayLeaseToken);
    expect(response).toMatchObject({ deliveryState: 'NOT_SENT', retryClass: 'PERMANENT', error: { code: 'TASK_LOCKED' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fences a LEGACY_PUBLICATION write before issuing the one-time delegation signal', async () => {
    const stores = repositoryMock(legacyIdentity('LEGACY_PUBLICATION'));
    stores.markLegacyDelegationIntent.mockResolvedValue(false);
    stores.getGatewayRequest.mockResolvedValue({
      delivery_state: 'NOT_SENT', retry_class: 'NONE', delegation_state: 'NONE', response_json: {}
    });
    const response = await gateway(stores).execute(writeRequest('lease-toctou-legacy'));
    expect(stores.markLegacyDelegationIntent).toHaveBeenCalledWith('lease-toctou-legacy', gatewayLeaseToken);
    expect(response).toMatchObject({ deliveryState: 'NOT_SENT', retryClass: 'PERMANENT', error: { code: 'TASK_LOCKED' } });
    expect((response.result as any).__merchRouteLegacy).toBeUndefined();
  });

  it('blocks a new write for a disabled/expired task but permits publication-scoped historical readback', async () => {
    const identity = { ...vaultIdentity(), storeEnabled: false, leaseActive: false };
    const stores = repositoryMock(identity);
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const blocked = await gateway(stores).execute(writeRequest('disabled-write'));
    expect(blocked).toMatchObject({ deliveryState: 'NOT_SENT', retryClass: 'PERMANENT' });
    expect(fetchMock).not.toHaveBeenCalled();

    const historicalRead = { ...readRequest('disabled-readback') };
    delete historicalRead.leaseToken;
    const readback = await gateway(stores).execute(historicalRead);
    expect(readback).toMatchObject({ deliveryState: 'RESPONDED', retryClass: 'NONE' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects product/task selectors that are not frozen to the current publication', async () => {
    const stores = repositoryMock(vaultIdentity());
    const service = gateway(stores);
    await expect(service.execute({
      taskId: 'default__9900002__r1', publicationId: '10000000-0000-4000-8000-000000000001',
      leaseToken: gatewayLeaseToken, requestRef: 'foreign-picture', operation: 'picturesImport',
      payload: { product_id: 999, images: ['https://example.test/image.jpg'] }
    })).resolves.toMatchObject({ deliveryState: 'NOT_SENT', retryClass: 'PERMANENT' });
    await expect(service.execute({
      taskId: 'default__9900002__r1', publicationId: '10000000-0000-4000-8000-000000000001',
      requestRef: 'foreign-import-task', operation: 'importInfo', payload: { task_id: 999 }
    })).resolves.toMatchObject({ deliveryState: 'NOT_SENT', retryClass: 'PERMANENT' });
    await expect(service.execute({
      taskId: 'default__9900002__r1', publicationId: '10000000-0000-4000-8000-000000000001',
      requestRef: 'broad-product-list', operation: 'listProducts', payload: { limit: 100 }
    })).resolves.toMatchObject({ deliveryState: 'NOT_SENT', retryClass: 'PERMANENT' });
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it.each([
    ['url', { url: 'https://evil.example' }],
    ['method', { method: 'GET' }],
    ['headers', { headers: { Authorization: 'secret' } }],
    ['credentials', { credentials: { apiKey: 'secret' } }],
    ['isWrite', { isWrite: false }]
  ])('rejects caller-controlled %s before creating a ledger', async (_field, payload) => {
    const stores = repositoryMock(vaultIdentity());
    await expect(gateway(stores).execute({ ...readRequest(`forbidden-${_field}`), payload }))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(stores.beginGatewayRequest).not.toHaveBeenCalled();
  });

  it('returns an immutable same-hash ledger result and propagates requestRef hash conflicts', async () => {
    const stores = repositoryMock(vaultIdentity());
    let frozenHash = '';
    stores.beginGatewayRequest.mockImplementation(async (input: any) => {
      if (!frozenHash) {
        frozenHash = input.requestHash;
        return { existing: {
          request_hash: frozenHash, delivery_state: 'RESPONDED', retry_class: 'NONE',
          delegation_state: 'NONE', response_json: { result: 'frozen' }, status_code: 200
        } };
      }
      if (input.requestHash !== frozenHash) throw new AppError('VERSION_CONFLICT', 'requestRef conflict', undefined, 409);
      return { existing: {
        request_hash: frozenHash, delivery_state: 'RESPONDED', retry_class: 'NONE',
        delegation_state: 'NONE', response_json: { result: 'frozen' }, status_code: 200
      } };
    });
    const service = gateway(stores);
    const first = await service.execute(readRequest('same-ref'));
    expect(first).toMatchObject({ idempotent: true, result: { result: 'frozen' } });
    await expect(service.execute({ ...readRequest('same-ref'), payload: { offer_id: ['9900002-01'], cursor: 'changed' } }))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
  });

  it('validates and records a legacy receipt against the frozen operation and payload hash', async () => {
    const stores = repositoryMock(legacyIdentity('LEGACY_PUBLICATION'));
    stores.recordLegacyGatewayReceipt.mockResolvedValue({
      delivery_state: 'RESPONDED', retry_class: 'NONE', response_json: { ok: true }, status_code: 200
    });
    const receipt = {
      requestRef: 'legacy-receipt-1',
      operation: 'infoList',
      payloadHash: `sha256:${'a'.repeat(64)}`,
      statusCode: 200,
      result: { ok: true },
      deliveryState: 'RESPONDED',
      retryClass: 'NONE'
    };
    const response = await gateway(stores).recordLegacyReceipt(receipt);
    expect(stores.recordLegacyGatewayReceipt).toHaveBeenCalledWith(receipt);
    expect(response).toMatchObject({ deliveryState: 'RESPONDED', retryClass: 'NONE', result: { ok: true } });
    await expect(gateway(stores).recordLegacyReceipt({ ...receipt, payloadHash: 'not-a-hash' }))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    for (const forged of [
      { ...receipt, deliveryState: 'UNKNOWN', retryClass: 'READBACK_REQUIRED', statusCode: 200 },
      { ...receipt, deliveryState: 'NOT_SENT', retryClass: 'RETRYABLE', statusCode: 200 },
      { ...receipt, deliveryState: 'RESPONDED', retryClass: 'RETRYABLE', statusCode: 200 },
      { ...receipt, operation: 'importProduct', deliveryState: 'NOT_SENT', retryClass: 'RETRYABLE', statusCode: 408 },
      { ...receipt, operation: 'importProduct', deliveryState: 'NOT_SENT', retryClass: 'RETRYABLE', statusCode: 500 }
    ]) {
      await expect(gateway(stores).recordLegacyReceipt(forged))
        .rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    }
  });

  it('never reports a corrupt UNKNOWN ledger row as successful even if it carries a stale 2xx status', async () => {
    const stores = repositoryMock(legacyIdentity('LEGACY_PUBLICATION'));
    stores.recordLegacyGatewayReceipt.mockResolvedValue({
      delivery_state: 'UNKNOWN', retry_class: 'READBACK_REQUIRED', response_json: {}, status_code: 200
    });
    const response = await gateway(stores).recordLegacyReceipt({
      requestRef: 'legacy-unknown-1', operation: 'infoList', payloadHash: `sha256:${'a'.repeat(64)}`,
      statusCode: 0, result: {}, deliveryState: 'UNKNOWN', retryClass: 'READBACK_REQUIRED'
    });
    expect(response).toMatchObject({ ok: false, deliveryState: 'UNKNOWN', statusCode: 200 });
  });
});

function readRequest(requestRef: string) {
  return {
    taskId: 'default__9900002__r1',
    publicationId: '10000000-0000-4000-8000-000000000001',
    leaseToken: gatewayLeaseToken,
    requestRef,
    operation: 'infoList',
    payload: { offer_id: ['9900002-01'] }
  };
}

function writeRequest(requestRef: string) {
  return {
    taskId: 'default__9900002__r1',
    publicationId: '10000000-0000-4000-8000-000000000001',
    leaseToken: gatewayLeaseToken,
    requestRef,
    operation: 'importProduct',
    payload: { items: [{ offer_id: '9900002-01' }] }
  };
}

function gateway(stores: ReturnType<typeof repositoryMock>) {
  return new OzonStoreGatewayService(stores as any, {
    decryptGatewayCredential: vi.fn(() => ({ clientId: 'client', apiKey: 'api-key' }))
  } as any);
}

function vaultIdentity(options: { task?: boolean } = {}) {
  const task = options.task !== false;
  return {
    storeId: OZON_DEFAULT_STORE_ID,
    storeAlias: 'default',
    ...(task ? {
      taskId: 'default__9900002__r1',
      publicationId: '10000000-0000-4000-8000-000000000001'
    } : {}),
    credentialVersionId: '20000000-0000-4000-8000-000000000001',
    credentialBindingMode: 'VAULT',
    storeConfigVersion: 1,
    warehouseId: '123',
    offerContractHash: `sha256:${'1'.repeat(64)}`,
    materializationHash: `sha256:${'2'.repeat(64)}`,
    offerIds: ['9900002-01'],
    productIds: ['501'],
    importTaskId: '777',
    storeEnabled: true,
    leaseActive: task,
    credential: {
      id: '20000000-0000-4000-8000-000000000001', storeId: OZON_DEFAULT_STORE_ID,
      version: 1, status: 'ACTIVE', ciphertext: 'x', nonce: 'x', authTag: 'x', fingerprint: 'x', keyVersion: 1
    }
  };
}

function legacyIdentity(mode: 'LEGACY_PUBLICATION' | 'PURE_LEGACY') {
  return {
    ...vaultIdentity(),
    credentialBindingMode: mode,
    credentialVersionId: undefined,
    credential: undefined
  };
}

function repositoryMock(identity: ReturnType<typeof vaultIdentity>) {
  return {
    getGatewayIdentity: vi.fn(async () => identity),
    getExactStoreReadbackIdentity: vi.fn(async () => identity),
    getProvisionalImportProductIds: vi.fn(async () => [] as string[]),
    beginGatewayRequest: vi.fn(async () => ({})),
    markGatewaySending: vi.fn(async () => true),
    markLegacyDelegationIntent: vi.fn(async () => true),
    getGatewayRequest: vi.fn(async () => ({ delivery_state: 'UNKNOWN', retry_class: 'READBACK_REQUIRED', response_json: {} })),
    completeGatewayRequest: vi.fn(async () => undefined),
    recordLegacyGatewayReceipt: vi.fn()
  };
}
