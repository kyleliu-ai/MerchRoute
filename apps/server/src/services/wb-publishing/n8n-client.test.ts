import { afterEach, describe, expect, it, vi } from 'vitest';
import { N8nWbClient } from './n8n-client.js';

describe('N8nWbClient P003 contract', () => {
  afterEach(() => {
    delete process.env.WB_AUTOMATION_BASE_URL;
    delete process.env.WB_AUTOMATION_KEY;
    delete process.env.WB_P001_WEBHOOK_URL;
    delete process.env.WB_C001_WEBHOOK_URL;
    vi.unstubAllGlobals();
  });

  it('uses the admin webhook action/payload contract and verifies readback', async () => {
    process.env.WB_AUTOMATION_BASE_URL = 'http://localhost:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    const responses = [
      { success: true, data: { updated: true } },
      { success: true, data: { importRoot: 'C:\\WB-Publish', rootSyncHash: 'sha256:root' } },
      { success: true, data: { updated: true } },
      { success: true, data: { sourceVersionId: '11111111-1111-4111-8111-111111111111', schemaHash: `sha256:${'a'.repeat(64)}`, definitionHash: `sha256:${'b'.repeat(64)}` } },
      { ok: true, data: { categoryKey: 'casual_shoes', deleted: true } },
      { ok: true, taskId: '0000010__r1' },
      { ok: true, data: [{ subjectID: 105, subjectName: 'Кроссовки' }] },
      { ok: true, data: [{ id: 1, name: 'Аксессуары' }] },
      { ok: true, data: [{ subjectID: 8986, subjectName: 'Рюкзаки', parentID: 1 }] },
      { ok: true, data: [{ charcID: 204557 }] },
      { ok: true, data: [{ tnved: '6404199000' }] }
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new N8nWbClient({ contentReadIntervalMs: 0 });

    const runtime = await client.syncRuntimeRoot('C:\\WB-Publish');
    expect(runtime).toMatchObject({ status: 'synced', remoteRootDirectory: 'C:\\WB-Publish', rootSyncHash: 'sha256:root' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ action: 'UPSERT_RUNTIME_CONFIG', payload: { importRoot: 'C:\\WB-Publish' } });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({ action: 'GET_RUNTIME_CONFIG', payload: {} });

    const projection = { categoryKey: 'casual_shoes', sourceVersionId: '11111111-1111-4111-8111-111111111111', schemaHash: `sha256:${'a'.repeat(64)}` };
    await client.syncCategory(projection);
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body))).toEqual({ action: 'UPSERT_CATEGORY_PROJECTION', payload: projection });
    expect(JSON.parse(String(fetchMock.mock.calls[3]![1]?.body))).toEqual({ action: 'GET_CATEGORY_PROJECTION', payload: { categoryKey: 'casual_shoes' } });
    await expect(client.deleteCategory('casual_shoes')).resolves.toEqual({ categoryKey: 'casual_shoes', deleted: true });
    expect(JSON.parse(String(fetchMock.mock.calls[4]![1]?.body))).toEqual({ action: 'DELETE_CATEGORY_PROJECTION', payload: { categoryKey: 'casual_shoes' } });
    await expect(client.submitListing({ folderName: '0000010', revision: 1 })).resolves.toMatchObject({ taskId: '0000010__r1' });
    expect(JSON.parse(String(fetchMock.mock.calls[5]![1]?.body))).toEqual({ folderName: '0000010', revision: 1, priority: 100, submissionMode: 'UPSERT', mediaPolicy: 'MISSING_ONLY', mediaTargetVendorCodes: [], idempotencyKey: '0000010|1' });
    await expect(client.searchSubjects('Кроссовки')).resolves.toEqual([{ subjectID: 105, subjectName: 'Кроссовки' }]);
    expect(JSON.parse(String(fetchMock.mock.calls[6]![1]?.body))).toEqual({ action: 'SEARCH_SUBJECTS', payload: { name: 'Кроссовки', locale: 'ru' } });
    await expect(client.getParentCategories()).resolves.toEqual([{ id: 1, name: 'Аксессуары' }]);
    expect(JSON.parse(String(fetchMock.mock.calls[7]![1]?.body))).toEqual({ action: 'GET_PARENT_CATEGORIES', payload: { locale: 'ru' } });
    await expect(client.searchSubjects({ parentID: 1, limit: 1000, offset: 0 })).resolves.toEqual([{ subjectID: 8986, subjectName: 'Рюкзаки', parentID: 1 }]);
    expect(JSON.parse(String(fetchMock.mock.calls[8]![1]?.body))).toEqual({ action: 'SEARCH_SUBJECTS', payload: { parentID: 1, limit: 1000, offset: 0, locale: 'ru' } });
    await expect(client.getSubjectSchema(105)).resolves.toEqual([{ charcID: 204557 }]);
    expect(JSON.parse(String(fetchMock.mock.calls[9]![1]?.body))).toEqual({ action: 'GET_SCHEMA', payload: { subjectId: 105, locale: 'ru' } });
    await expect(client.getDirectory('tnved', { subjectId: 105, search: '6404' })).resolves.toEqual([{ tnved: '6404199000' }]);
    expect(JSON.parse(String(fetchMock.mock.calls[10]![1]?.body))).toEqual({ action: 'GET_DIRECTORY', payload: { directory: 'tnved', locale: 'ru', subjectId: 105, search: '6404' } });
    expect(fetchMock.mock.calls.every(([, init]) => (init?.headers as Record<string, string>)['X-WB-Automation-Key'] === 'test-key')).toBe(true);
  });

  it('reconciles an unknown runtime write response through a read-only config readback', async () => {
    process.env.WB_AUTOMATION_BASE_URL = 'http://localhost:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        data: { importRoot: 'C:\\WB-Publish', rootSyncHash: 'sha256:root' }
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new N8nWbClient({ contentReadIntervalMs: 0 }).syncRuntimeRoot('C:\\WB-Publish')).resolves.toMatchObject({
      status: 'synced',
      remoteRootDirectory: 'C:\\WB-Publish',
      rootSyncHash: 'sha256:root',
      message: 'n8n 写入响应未知，已通过运行配置回读确认同步成功'
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({ action: 'GET_RUNTIME_CONFIG', payload: {} });
  });

  it('uses an action-specific bridge error while preserving idempotent job guidance', async () => {
    process.env.WB_AUTOMATION_BASE_URL = 'http://localhost:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('bridge offline'))
      .mockRejectedValueOnce(new TypeError('jobs offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not_found', message: '任务不存在', taskId: '0000010__r1' }), { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new N8nWbClient({ contentReadIntervalMs: 0, taskReadbackRetryDelaysMs: [0] });

    await expect(client.getSubjectSchema(105)).rejects.toMatchObject({
      message: 'n8n WB 桥接请求失败（GET_SCHEMA）：网络超时或连接中断',
      details: { deliveryUnknown: true, action: 'GET_SCHEMA' }
    });
    await expect(client.submitListing({ folderName: '0000010', revision: 1 })).rejects.toMatchObject({
      code: 'WB_TASK_NOT_REGISTERED',
      details: { deliveryUnknown: true, expectedTaskId: '0000010__r1' }
    });
  });

  it('recovers a successful response without taskId through an exact status readback', async () => {
    process.env.WB_AUTOMATION_BASE_URL = 'http://localhost:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, httpStatus: 202 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        taskId: '0000070__r1', productCode: '0000070', revision: 1, state: 'QUEUED'
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new N8nWbClient({ taskReadbackRetryDelaysMs: [0] }).submitListing({
      folderName: '0000070', revision: 1, submissionMode: 'COMPATIBLE_UPSERT'
    })).resolves.toMatchObject({
      taskId: '0000070__r1',
      raw: { recoveredByStatusReadback: true }
    });
    expect(String(fetchMock.mock.calls[1]![0])).toBe('http://localhost:5678/webhook/wb/v1/jobs/status?taskId=0000070__r1');
  });

  it('recovers an unknown POST result when the exact idempotent task exists', async () => {
    process.env.WB_AUTOMATION_BASE_URL = 'http://localhost:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('socket hang up'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        taskId: '0000070__r1', productCode: '0000070', revision: 1, state: 'QUEUED'
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new N8nWbClient({ taskReadbackRetryDelaysMs: [0] }).submitListing({
      folderName: '0000070', revision: 1
    })).resolves.toMatchObject({ taskId: '0000070__r1' });
  });

  it('fails closed when taskId is missing and status readback confirms no persisted task', async () => {
    process.env.WB_AUTOMATION_BASE_URL = 'http://localhost:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'not_found', message: '任务不存在', taskId: '0000070__r1'
      }), { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new N8nWbClient({ taskReadbackRetryDelaysMs: [0] }).submitListing({
      folderName: '0000070', revision: 1
    })).rejects.toMatchObject({
      code: 'WB_TASK_NOT_REGISTERED',
      details: { deliveryUnknown: false, expectedTaskId: '0000070__r1' }
    });
  });

  it('fails closed when P001 returns a different taskId', async () => {
    process.env.WB_AUTOMATION_BASE_URL = 'http://localhost:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true, taskId: '0000071__r1'
    }), { status: 200 })));

    await expect(new N8nWbClient().submitListing({ folderName: '0000070', revision: 1 })).rejects.toMatchObject({
      code: 'VERIFY_FAILED',
      details: { expectedTaskId: '0000070__r1', returnedTaskId: '0000071__r1', deliveryUnknown: false }
    });
  });

  it('allows directory-copy submissions up to 180 seconds without changing bridge timeouts', async () => {
    process.env.WB_AUTOMATION_BASE_URL = 'http://localhost:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, taskId: '0000069__r1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new N8nWbClient({ contentReadIntervalMs: 0 });

    await client.submitListing({ folderName: '0000069', revision: 1, submissionMode: 'COMPATIBLE_UPSERT' });
    expect(timeoutSpy).toHaveBeenLastCalledWith(180_000);

    await client.getSubjectSchema(50);
    expect(timeoutSpy).toHaveBeenLastCalledWith(30_000);
  });

  it('passes zh locale through every bilingual catalog action', async () => {
    process.env.WB_AUTOMATION_BASE_URL = 'http://localhost:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new N8nWbClient({ contentReadIntervalMs: 0 });
    await client.getParentCategories('zh');
    await client.searchSubjects({ parentID: 1, locale: 'zh' });
    await client.getSubjectSchema(138, 'zh');
    await client.getDirectory('colors', { locale: 'zh' });
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).payload.locale)).toEqual(['zh', 'zh', 'zh', 'zh']);
  });

  it('checks exact vendor codes and passes CREATE_ONLY without changing the idempotency key', async () => {
    process.env.WB_AUTOMATION_BASE_URL = 'http://localhost:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    const responses = [
      { ok: true, data: { matches: [
        { vendorCode: '0000021-01', location: 'active', nmID: 123, imtID: 456, subjectID: 50 },
        { vendorCode: 'unrequested', location: 'trash', nmID: 999 }
      ] } },
      { ok: true, taskId: '0000021__r1' }
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new N8nWbClient({ contentReadIntervalMs: 0 });

    await expect(client.checkVendorCodes(['0000021-01', '0000021-02'])).resolves.toMatchObject({
      matches: [{ vendorCode: '0000021-01', location: 'ACTIVE', nmId: 123, imtId: 456, subjectId: 50 }]
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ action: 'CHECK_VENDOR_CODES', payload: { vendorCodes: ['0000021-01', '0000021-02'] } });
    await expect(client.submitListing({ folderName: '0000021', revision: 1, submissionMode: 'CREATE_ONLY' })).resolves.toMatchObject({ taskId: '0000021__r1' });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
      folderName: '0000021', revision: 1, priority: 100, submissionMode: 'CREATE_ONLY', mediaPolicy: 'MISSING_ONLY', mediaTargetVendorCodes: [], idempotencyKey: '0000021|1'
    });
  });

  it('scopes CHECK_VENDOR_CODES to the selected vault store', async () => {
    process.env.WB_AUTOMATION_BASE_URL = 'http://localhost:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { matches: [] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await new N8nWbClient({ contentReadIntervalMs: 0 }).checkVendorCodes(['0000021-01'], {
      storeId: '11111111-1111-4111-8111-111111111111',
      storeAlias: 'second',
      requestRef: 'vendor-check:second:0000021:r1'
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      action: 'CHECK_VENDOR_CODES',
      vendorCodes: ['0000021-01'],
      payload: { vendorCodes: ['0000021-01'] },
      storeId: '11111111-1111-4111-8111-111111111111',
      storeAlias: 'second',
      requestRef: 'vendor-check:second:0000021:r1'
    });
  });

  it('calls the P001 partial-create recovery action and verifies task identity', async () => {
    process.env.WB_AUTOMATION_BASE_URL = 'http://localhost:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true, taskId: '0000060__r1', state: 'STOCK_RECONCILING', resumedState: 'STOCK_RECONCILING'
    }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new N8nWbClient({ contentReadIntervalMs: 0 }).recoverPartialCreate('0000060__r1')).resolves.toMatchObject({
      taskId: '0000060__r1',
      state: 'STOCK_RECONCILING'
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      action: 'RECOVER_PARTIAL_CREATE',
      taskId: '0000060__r1'
    });
  });

  it('submits a compatible run with selected-media replacement and run-scoped idempotency', async () => {
    process.env.WB_AUTOMATION_BASE_URL = 'http://localhost:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, taskId: '0000001__r5' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new N8nWbClient({ contentReadIntervalMs: 0 });
    const runId = '11111111-2222-4333-8444-555555555555';

    await expect(client.submitListing({
      folderName: '0000001', revision: 5, submissionMode: 'COMPATIBLE_UPSERT',
      mediaPolicy: 'REPLACE_SELECTED', mediaTargetVendorCodes: ['0000001-03'], automationRunId: runId,
      existingCardBaseline: [{ vendorCode: '0000001-01', nmID: '1332434640' }]
    })).resolves.toMatchObject({ taskId: '0000001__r5' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      folderName: '0000001', revision: 5, priority: 100, submissionMode: 'COMPATIBLE_UPSERT',
      mediaPolicy: 'REPLACE_SELECTED', mediaTargetVendorCodes: ['0000001-03'], automationRunId: runId,
      existingCardBaseline: [{ vendorCode: '0000001-01', nmID: '1332434640' }],
      idempotencyKey: `0000001|5|${runId}`
    });
  });

  it('accepts transitional active/trash arrays and fails closed on an unverifiable response shape', async () => {
    process.env.WB_AUTOMATION_BASE_URL = 'http://localhost:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: {
        activeMatches: [{ vendorCode: '0000022-01', nmID: 201 }],
        trashMatches: ['0000022-02']
      } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { checked: 2 } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new N8nWbClient({ contentReadIntervalMs: 0 });

    await expect(client.checkVendorCodes(['0000022-01', '0000022-02'])).resolves.toMatchObject({ matches: [
      { vendorCode: '0000022-01', location: 'ACTIVE', nmId: 201 },
      { vendorCode: '0000022-02', location: 'TRASH' }
    ] });
    await expect(client.checkVendorCodes(['0000022-01', '0000022-02'])).rejects.toMatchObject({ code: 'VERIFY_FAILED', statusCode: 502 });
  });

  it('preserves WB bridge status and retry delay from a structured failed response', async () => {
    process.env.WB_AUTOMATION_BASE_URL = 'http://localhost:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      httpStatus: 429,
      retryAfterMs: 2500,
      error: 'wb_rate_limited',
      message: 'Too many requests',
      failedVendorCode: '0000046-02',
      failedScope: 'trash'
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const retryDelays: number[] = [];
    const client = new N8nWbClient({
      contentReadIntervalMs: 0,
      contentReadRetryDelaysMs: [0, 0, 0],
      contentReadRetryWait: async (delayMs) => { retryDelays.push(delayMs); }
    });
    await expect(client.checkVendorCodes(['0000046-02'])).rejects.toMatchObject({
      code: 'VERIFY_FAILED',
      details: {
        httpStatus: 429,
        retryAfterMs: 2500,
        requestAttempts: 4,
        retryCount: 3,
        response: expect.objectContaining({ failedVendorCode: '0000046-02', failedScope: 'trash' })
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(retryDelays).toEqual([2500, 2500, 2500]);
  });

  it('retries network and 5xx vendor-code reads but never retries authentication failures', async () => {
    process.env.WB_AUTOMATION_BASE_URL = 'http://localhost:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('socket hang up'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'temporary gateway error' }), { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: { matches: [] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'unauthorized' }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new N8nWbClient({ contentReadIntervalMs: 0, contentReadRetryDelaysMs: [0, 0, 0] });

    await expect(client.checkVendorCodes(['0000069-02'])).resolves.toMatchObject({ matches: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await expect(client.checkVendorCodes(['0000069-03'])).rejects.toMatchObject({
      code: 'VERIFY_FAILED',
      details: { httpStatus: 401, requestAttempts: 1, retryCount: 0 }
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('serializes concurrent WB content reads through one minimum-interval gate', async () => {
    process.env.WB_AUTOMATION_BASE_URL = 'http://localhost:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    const startedAt: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      startedAt.push(Date.now());
      return new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 });
    }));
    const client = new N8nWbClient({ contentReadIntervalMs: 25 });

    await Promise.all([
      client.getSubjectSchema(138, 'ru'),
      client.getSubjectSchema(138, 'zh'),
      client.getParentCategories('ru')
    ]);

    expect(startedAt).toHaveLength(3);
    expect(startedAt[1]! - startedAt[0]!).toBeGreaterThanOrEqual(20);
    expect(startedAt[2]! - startedAt[1]!).toBeGreaterThanOrEqual(20);
  });

  it('does not collapse case-sensitive POSIX roots', async () => {
    process.env.WB_AUTOMATION_BASE_URL = 'http://localhost:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    const responses = [
      { ok: true, data: { updated: true } },
      { ok: true, data: { importRoot: '/Volumes/wb' } }
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 })));
    await expect(new N8nWbClient().syncRuntimeRoot('/Volumes/WB')).resolves.toMatchObject({ status: 'pending', remoteRootDirectory: '/Volumes/wb' });
  });

  it('uses the static task status route and distinguishes a missing task from a missing webhook', async () => {
    process.env.WB_AUTOMATION_BASE_URL = 'http://localhost:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not_found', message: '任务不存在', taskId: '0000011__r2' }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 404, message: 'The requested webhook is not registered' }), { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new N8nWbClient();

    await expect(client.getJob('0000011__r2')).rejects.toMatchObject({ code: 'JOB_NOT_FOUND', details: { deliveryUnknown: false } });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://localhost:5678/webhook/wb/v1/jobs/status?taskId=0000011__r2');
    await expect(client.getJob('0000011__r2')).rejects.toMatchObject({ code: 'WEBHOOK_ROUTE_NOT_FOUND', details: { deliveryUnknown: true } });
  });

  it('does not classify an explicit HTTP rejection as unknown delivery', async () => {
    process.env.WB_AUTOMATION_BASE_URL = 'http://localhost:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false, error: 'directory_busy', message: '商品目录正被其他程序占用，请稍后重试', taskId: null, deliveryUnknown: false
    }), { status: 503 })));

    await expect(new N8nWbClient().submitListing({ folderName: '0000011', revision: 2 })).rejects.toMatchObject({
      code: 'VERIFY_FAILED', details: { deliveryUnknown: false, httpStatus: 503 }
    });
  });

  it('forwards generatedVersionId and preserves an allowlisted S000 marker error', async () => {
    process.env.WB_AUTOMATION_BASE_URL = 'http://localhost:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      code: 'STORE_READY_MARKER_MISSING',
      message: '店铺发布就绪凭证不存在',
      deliveryUnknown: false
    }), { status: 409, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const generatedVersionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    await expect(new N8nWbClient().submitListing({
      folderName: '0000118', revision: 1, storeAlias: 'default',
      storeId: '00000000-0000-4000-8000-000000000001',
      publicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      generatedVersionId,
      credentialVersionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      storeConfigVersion: 3, warehouseId: '1701558',
      idempotencyKey: 'default|0000118|1|run-1'
    })).rejects.toMatchObject({
      code: 'STORE_READY_MARKER_MISSING',
      statusCode: 409,
      details: { deliveryUnknown: false, httpStatus: 409 }
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({
      folderName: '0000118', revision: 1, storeAlias: 'default', generatedVersionId,
      idempotencyKey: 'default|0000118|1|run-1'
    });
  });

  it('uses the C001 store preflight webhook path', async () => {
    process.env.WB_AUTOMATION_BASE_URL = 'http://localhost:5678';
    process.env.WB_AUTOMATION_KEY = 'test-key';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new N8nWbClient().preflightStore({
      storeId: '11111111-1111-4111-8111-111111111111',
      storeAlias: 'second',
      storeConfigVersion: 2,
      credentialVersionId: '22222222-2222-4222-8222-222222222222',
      accountCurrency: 'CNY',
      requestRef: 'preflight:second:2'
    })).resolves.toMatchObject({ accepted: true });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://localhost:5678/webhook/wb/v1/stores/preflight');
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({ accountCurrency: 'CNY' });
  });
});
