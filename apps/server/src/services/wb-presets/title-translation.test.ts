import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WbPresetRepository } from '../../repositories/wb-presets.js';
import { WbTitleTranslationClient } from './title-translation.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function configuredClient(repository: Partial<WbPresetRepository>) {
  vi.stubEnv('WB_AUTOMATION_BASE_URL', 'http://127.0.0.1:5678');
  vi.stubEnv('WB_AUTOMATION_KEY', 'test-secret');
  vi.stubEnv('WB_TITLE_TRANSLATION_WORKFLOW_ID', 'W2lSSXE3NUaLW1tD');
  return new WbTitleTranslationClient(repository as WbPresetRepository);
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    content: '男款轻便跑步鞋', language: '俄文', maxLength: 60,
    workflowId: 'W2lSSXE3NUaLW1tD', requestId: 'request-1', ...overrides
  } as any;
}

describe('WbTitleTranslationClient', () => {
  it('returns a validated cache hit without calling n8n', async () => {
    const getTranslation = vi.fn().mockResolvedValue({ contentTranslate: 'Мужские кроссовки', model: 'cached-model' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await configuredClient({ getTranslation }).translate(input());
    expect(result).toMatchObject({ contentTranslate: 'Мужские кроссовки', model: 'cached-model', cached: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent identical requests and stores one cache entry', async () => {
    const getTranslation = vi.fn().mockResolvedValue(undefined);
    const putTranslation = vi.fn().mockResolvedValue(undefined);
    let release!: (value: Response) => void;
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const client = configuredClient({ getTranslation, putTranslation });
    const first = client.translate(input({ requestId: 'request-a' }));
    const second = client.translate(input({ requestId: 'request-b' }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    release(new Response(JSON.stringify({ contentTranslate: 'Мужские кроссовки', model: 'qwen', usage: {}, finishReason: 'stop' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ contentTranslate: 'Мужские кроссовки', cached: false }),
      expect.objectContaining({ contentTranslate: 'Мужские кроссовки', cached: false })
    ]);
    expect(putTranslation).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers['X-WB-Automation-Key']).toBe('test-secret');
    expect(JSON.parse(init.body)).toEqual({ content: '男款轻便跑步鞋', language: '俄文', maxLength: 60, requestId: 'request-a' });
  });

  it('rejects unsupported workflow IDs and invalid language boundaries before network access', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = configuredClient({ getTranslation: vi.fn() });
    await expect(client.translate(input({ workflowId: 'other-workflow' }))).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });
    await expect(client.translate(input({ language: '语'.repeat(65) }))).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(client.translate(input({ language: '俄文\n英语' }))).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed on multiline, overlength, and non-JSON responses', async () => {
    const repository = { getTranslation: vi.fn().mockResolvedValue(undefined), putTranslation: vi.fn() };
    const cases = [
      new Response(JSON.stringify({ contentTranslate: 'A\nB' }), { status: 200 }),
      new Response(JSON.stringify({ contentTranslate: 'Очень длинный заголовок' }), { status: 200 }),
      new Response('not-json', { status: 200 })
    ];
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(cases.shift()!));
    vi.stubGlobal('fetch', fetchMock);
    const client = configuredClient(repository);
    await expect(client.translate(input({ content: 'first' }))).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
    await expect(client.translate(input({ content: 'second', maxLength: 5 }))).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
    await expect(client.translate(input({ content: 'third' }))).rejects.toMatchObject({ code: 'VERIFY_FAILED' });
    expect(repository.putTranslation).not.toHaveBeenCalled();
  });
});
