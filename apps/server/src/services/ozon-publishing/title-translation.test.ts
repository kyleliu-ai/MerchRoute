import { afterEach, describe, expect, it, vi } from 'vitest';
import { OZON_CONTENT_POLICY_V3 } from '@n8n-media-review/shared';
import { OzonTitleTranslationClient } from './title-translation.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('OZON preset title translation', () => {
  it('uses the preset workflow mapping, language and maximum length', async () => {
    vi.stubEnv('OZON_TITLE_TRANSLATION_WORKFLOW_ID', 'ozon-title-workflow');
    vi.stubEnv('OZON_TITLE_TRANSLATION_WEBHOOK_URL', 'http://localhost:5678/webhook/translation-title');
    vi.stubEnv('OZON_AUTOMATION_KEY', 'test-key');
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ content: '测试商品', language: '俄文', maxLength: 80 });
      return new Response(JSON.stringify({ contentTranslate: 'Тестовый товар' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
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
    vi.stubGlobal('fetch', fetchMock);
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
    vi.stubGlobal('fetch', fetchMock);
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
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 'TITLE_TOO_LONG', message: '标题超出约束', details: { actualLength: 201 }
    }), { status: 422 })));
    const client = new OzonTitleTranslationClient();
    await expect(client.translate({
      content: '测试商品', language: '俄文', maxLength: 200, workflowId: 'HDh0ZNLK2ps5qasR', requestId: 'request-contract-error', contentPolicyVersion: OZON_CONTENT_POLICY_V3
    })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      details: { errorCode: 'TITLE_TOO_LONG', retryable: false, details: { httpStatus: 422, actualLength: 201 } }
    });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      contentTranslate: 'Универсальная сумка через плечо для повседневного использования'
    }), { status: 200 })));
    await expect(client.translate({
      content: '测试商品', language: '俄文', maxLength: 200, workflowId: 'HDh0ZNLK2ps5qasR', requestId: 'request-63', contentPolicyVersion: OZON_CONTENT_POLICY_V3
    })).resolves.toMatchObject({ contentTranslate: 'Универсальная сумка через плечо для повседневного использования' });
  });

  it('preserves a stable T001 error field and rejects an invalid webhook URL without retrying', async () => {
    vi.stubEnv('OZON_TITLE_TRANSLATION_WEBHOOK_URL', 'http://localhost:5678/webhook/translation-title');
    vi.stubEnv('OZON_AUTOMATION_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
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
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'RATE_LIMIT' }), { status: 429 })));
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
