import { afterEach, describe, expect, it, vi } from 'vitest';
import { OZON_CONTENT_POLICY_V3, OZON_CONTENT_POLICY_V4 } from '@n8n-media-review/shared';
import { isRetryableOzonTitleTranslationError, OzonTitleTranslationClient } from './title-translation.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function mockTranslationFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => init?.method === 'GET'
    ? Promise.resolve(Response.json({ status: 'ok' })) : handler(url, init));
}

describe('OZON preset title translation', () => {
  it('uses the preset workflow mapping, language and maximum length', async () => {
    vi.stubEnv('OZON_TITLE_TRANSLATION_WORKFLOW_ID', 'ozon-title-workflow');
    vi.stubEnv('OZON_TITLE_TRANSLATION_WEBHOOK_URL', 'http://localhost:5678/webhook/translation-title');
    vi.stubEnv('OZON_AUTOMATION_KEY', 'test-key');
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ content: '测试商品', language: '俄文', maxLength: 80 });
      return new Response(JSON.stringify({ contentTranslate: 'Тестовый товар' }), { status: 200 });
    });
    mockTranslationFetch(fetchMock);
    const client = new OzonTitleTranslationClient();

    await expect(client.translate({
      content: '测试商品', language: '俄文', maxLength: 80, workflowId: 'ozon-title-workflow', requestId: 'request-1', contentPolicyVersion: OZON_CONTENT_POLICY_V3
    })).resolves.toMatchObject({ contentTranslate: 'Тестовый товар', cached: false });
    await expect(client.translate({
      content: '另一个商品', language: '俄文', maxLength: 80, workflowId: 'unsupported', requestId: 'request-2', contentPolicyVersion: OZON_CONTENT_POLICY_V3
    })).rejects.toThrow('webhook 映射');
  });

  it('passes only caller-provided trusted catalog context through to T001', async () => {
    vi.stubEnv('OZON_TITLE_TRANSLATION_WEBHOOK_URL', 'http://localhost:5678/webhook/translation-title');
    vi.stubEnv('OZON_AUTOMATION_KEY', 'test-key');
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        content: '测试商品',
        productTypeRu: 'Сумка',
        brand: 'MerchRoute',
        model: 'MR-01',
        importantCharacteristics: ['Натуральная кожа', 'Чёрный цвет']
      });
      return new Response(JSON.stringify({ contentTranslate: 'Тестовый товар' }), { status: 200 });
    });
    mockTranslationFetch(fetchMock);
    const client = new OzonTitleTranslationClient();

    await client.translate({
      content: '测试商品', language: '俄文', maxLength: 200,
      workflowId: 'HDh0ZNLK2ps5qasR', requestId: 'request-context', contentPolicyVersion: OZON_CONTENT_POLICY_V3,
      productTypeRu: 'Сумка', brand: 'MerchRoute', model: 'MR-01',
      importantCharacteristics: ['Натуральная кожа', 'Чёрный цвет']
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('defaults to the dedicated OZON workflow and webhook without inheriting the WB title mapping', async () => {
    vi.stubEnv('OZON_AUTOMATION_BASE_URL', 'http://localhost:5678/');
    vi.stubEnv('OZON_AUTOMATION_KEY', 'test-key');
    vi.stubEnv('WB_TITLE_TRANSLATION_WORKFLOW_ID', 'W2lSSXE3NUaLW1tD');
    vi.stubEnv('WB_TITLE_TRANSLATION_WEBHOOK_URL', 'http://localhost:5678/webhook/translation-title');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ contentTranslate: 'Тестовый товар' }), { status: 200 }));
    mockTranslationFetch(fetchMock);
    const client = new OzonTitleTranslationClient();

    await client.translate({
      content: '测试商品', language: '俄文', maxLength: 61,
      workflowId: 'HDh0ZNLK2ps5qasR', requestId: 'request-dedicated', contentPolicyVersion: OZON_CONTENT_POLICY_V3
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:5678/webhook/ozon/translation-title',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('preserves non-retryable workflow error details and accepts a 63-character Russian title', async () => {
    vi.stubEnv('OZON_TITLE_TRANSLATION_WEBHOOK_URL', 'http://localhost:5678/webhook/translation-title');
    vi.stubEnv('OZON_AUTOMATION_KEY', 'test-key');
    mockTranslationFetch(vi.fn(async () => new Response(JSON.stringify({
      code: 'TITLE_TOO_LONG', message: '标题超出约束', details: { actualLength: 201 }
    }), { status: 422 })));
    const client = new OzonTitleTranslationClient();
    await expect(client.translate({
      content: '测试商品', language: '俄文', maxLength: 200, workflowId: 'HDh0ZNLK2ps5qasR', requestId: 'request-contract-error', contentPolicyVersion: OZON_CONTENT_POLICY_V3
    })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      details: { errorCode: 'TITLE_TOO_LONG', retryable: false, details: { httpStatus: 422, actualLength: 201 } }
    });

    mockTranslationFetch(vi.fn(async () => new Response(JSON.stringify({
      contentTranslate: 'Универсальная сумка через плечо для повседневного использования'
    }), { status: 200 })));
    await expect(client.translate({
      content: '测试商品', language: '俄文', maxLength: 200, workflowId: 'HDh0ZNLK2ps5qasR', requestId: 'request-63', contentPolicyVersion: OZON_CONTENT_POLICY_V3
    })).resolves.toMatchObject({ contentTranslate: 'Универсальная сумка через плечо для повседневного использования' });
  });

  it('preserves a stable T001 error field and rejects an invalid webhook URL without retrying', async () => {
    vi.stubEnv('OZON_TITLE_TRANSLATION_WEBHOOK_URL', 'http://localhost:5678/webhook/translation-title');
    vi.stubEnv('OZON_AUTOMATION_KEY', 'test-key');
    mockTranslationFetch(vi.fn(async () => new Response(JSON.stringify({
      error: 'TRANSLATION_OUTPUT_INVALID', message: '翻译结果不符合标题合同'
    }), { status: 422 })));
    const client = new OzonTitleTranslationClient();
    await expect(client.translate({
      content: '测试商品', language: '俄文', maxLength: 200, workflowId: 'HDh0ZNLK2ps5qasR', requestId: 'request-error-field', contentPolicyVersion: OZON_CONTENT_POLICY_V3
    })).rejects.toMatchObject({
      code: 'CONFIG_INVALID', details: { errorCode: 'TRANSLATION_OUTPUT_INVALID', retryable: false }
    });

    vi.stubEnv('OZON_TITLE_TRANSLATION_WEBHOOK_URL', 'ftp://invalid.example/translation-title');
    const invalidUrlClient = new OzonTitleTranslationClient();
    await expect(invalidUrlClient.translate({
      content: '测试商品', language: '俄文', maxLength: 200, workflowId: 'HDh0ZNLK2ps5qasR', requestId: 'request-invalid-url', contentPolicyVersion: OZON_CONTENT_POLICY_V3
    })).rejects.toMatchObject({
      code: 'CONFIG_INVALID', details: { errorCode: 'OZON_TITLE_TRANSLATION_URL_INVALID', retryable: false }
    });
  });

  it('marks only 429 and 5xx workflow responses retryable', async () => {
    vi.stubEnv('OZON_TITLE_TRANSLATION_WEBHOOK_URL', 'http://localhost:5678/webhook/translation-title');
    vi.stubEnv('OZON_AUTOMATION_KEY', 'test-key');
    mockTranslationFetch(vi.fn(async () => new Response(JSON.stringify({ code: 'RATE_LIMIT' }), { status: 429 })));
    const client = new OzonTitleTranslationClient();
    await expect(client.translate({
      content: '测试商品', language: '俄文', maxLength: 200, workflowId: 'HDh0ZNLK2ps5qasR', requestId: 'request-429', contentPolicyVersion: OZON_CONTENT_POLICY_V3
    })).rejects.toMatchObject({ code: 'VERIFY_FAILED', details: { errorCode: 'RATE_LIMIT', retryable: true } });
  });

  it('fails closed before dispatch when the frozen content policy version is missing', async () => {
    vi.stubEnv('OZON_TITLE_TRANSLATION_WEBHOOK_URL', 'http://localhost:5678/webhook/translation-title');
    vi.stubEnv('OZON_AUTOMATION_KEY', 'test-key');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new OzonTitleTranslationClient();

    await expect(client.translate({
      content: '测试商品', language: '俄文', maxLength: 200,
      workflowId: 'HDh0ZNLK2ps5qasR', requestId: 'request-missing-policy'
    } as never)).rejects.toMatchObject({
      code: 'CONFIG_INVALID', details: { errorCode: 'OZON_TITLE_TRANSLATION_INPUT_INVALID' }
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('OZON title startup readiness', () => {
  const input = {
    content: '手提包', language: '俄文', maxLength: 200, workflowId: 'HDh0ZNLK2ps5qasR',
    requestId: 'same-preparation-title', contentPolicyVersion: OZON_CONTENT_POLICY_V4
  };
  function client() {
    vi.stubEnv('OZON_TITLE_TRANSLATION_WEBHOOK_URL', 'http://127.0.0.1:5678/n8n/webhook/ozon/translation-title');
    vi.stubEnv('OZON_AUTOMATION_KEY', 'test-key');
    return new OzonTitleTranslationClient();
  }

  it('does not POST while starting; retries the same request after readiness and caches only success', async () => {
    let ready = false;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'GET'
      ? Response.json({ status: ready ? 'ok' : 'error' }, { status: ready ? 200 : 503 })
      : Response.json({ contentTranslate: 'Сумка женская' }));
    vi.stubGlobal('fetch', fetchMock);
    const translator = client();
    await expect(translator.translate(input)).rejects.toMatchObject({ code: 'VERIFY_FAILED', details: {
      errorCode: 'OZON_TITLE_TRANSLATION_NOT_READY', retryable: true
    } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual(['http://127.0.0.1:5678/n8n/healthz/readiness', expect.objectContaining({
      method: 'GET', headers: { accept: 'application/json' }, redirect: 'error'
    })]);
    ready = true;
    await expect(translator.translate(input)).resolves.toMatchObject({ contentTranslate: 'Сумка женская', cached: false });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      content: input.content, requestId: input.requestId, contentPolicyVersion: OZON_CONTENT_POLICY_V4
    });
    await expect(translator.translate(input)).resolves.toMatchObject({ cached: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(['<html>Cannot POST</html>', JSON.stringify({ code: 404, message: 'webhook not registered' })])(
    'distinguishes a restart race from a genuinely missing webhook: %s', async (body) => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(Response.json({ status: 'ok' }))
        .mockResolvedValueOnce(new Response(body, { status: 404 }))
        .mockResolvedValueOnce(Response.json({ status: 'error' }, { status: 503 }));
      vi.stubGlobal('fetch', fetchMock);
      await expect(client().translate(input)).rejects.toMatchObject({ code: 'VERIFY_FAILED', details: {
        errorCode: 'OZON_TITLE_TRANSLATION_NOT_READY', retryable: true
      } });
      fetchMock.mockResolvedValueOnce(Response.json({ status: 'ok' }))
        .mockResolvedValueOnce(new Response(body, { status: 404 }))
        .mockResolvedValueOnce(Response.json({ status: 'ok' }));
      await expect(client().translate(input)).rejects.toMatchObject({ code: 'CONFIG_INVALID', details: {
        errorCode: 'OZON_TITLE_TRANSLATION_ENDPOINT_NOT_FOUND', retryable: false
      } });
      expect(fetchMock).toHaveBeenCalledTimes(6);
    }
  );

  it.each([401, 403])('reports HTTP %s as authentication failure even for plain text', async (status) => {
    mockTranslationFetch(async () => new Response('Authorization data is wrong!', { status }));
    await expect(client().translate(input)).rejects.toMatchObject({ code: 'CONFIG_INVALID', details: {
      errorCode: 'OZON_TITLE_TRANSLATION_AUTH_INVALID', retryable: false
    } });
  });

  it.each([429, 502])('keeps upstream error codes but identifies HTTP %s as a transient translation failure', async (status) => {
    mockTranslationFetch(async () => Response.json({ code: 'UPSTREAM_BUSY' }, { status }));
    const error = await client().translate(input).catch(error => error);
    expect(error).toMatchObject({ code: 'VERIFY_FAILED', details: { errorCode: 'UPSTREAM_BUSY', retryable: true } });
    expect(isRetryableOzonTitleTranslationError(error)).toBe(true);
  });

  it.each([404, 200])('does not retry an invalid readiness endpoint (HTTP %s)', async (status) => {
    const fetchMock = vi.fn(async () => new Response('<html>wrong service</html>', { status }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(client().translate(input)).rejects.toMatchObject({ code: 'CONFIG_INVALID', details: {
      errorCode: 'OZON_TITLE_TRANSLATION_READINESS_INVALID', retryable: false
    } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['ECONNREFUSED', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'])('waits on readiness network error %s', async (code) => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed', { cause: { code } }); }));
    await expect(client().translate(input)).rejects.toMatchObject({ code: 'VERIFY_FAILED', details: {
      errorCode: 'OZON_TITLE_TRANSLATION_NOT_READY', retryable: true
    } });
  });
});
