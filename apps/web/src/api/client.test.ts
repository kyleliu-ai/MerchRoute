import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, connectMediaIndexEvents } from './client';

const stageWire = (index: Record<string, unknown>) => ({
  id: 'E006',
  alias: 'PDD下载',
  groupId: 'downloads',
  displayName: '拼多多商品媒体下载',
  workflowName: 'E006-拼多多商品媒体下载',
  description: '下载产品主图和详情图',
  enabled: true,
  reviewEnabled: true,
  mediaTypes: ['image'],
  targets: [],
  summary: { pending: 1, drafts: 0, approved: 0, queue: 0, totalTasks: 1, lastScannedAt: null },
  index
});

class FakeEventSource {
  static latest: FakeEventSource | undefined;
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  readonly close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.latest = this;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, data: string): void {
    const event = { type, data } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.latest = undefined;
});

describe('media index wire compatibility', () => {
  it('normalizes a legacy stage response without revision', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        stages: [stageWire({
          stageId: 'E006',
          status: 'READY',
          watcherStatus: 'ACTIVE',
          activeGeneration: {
            id: 'generation-1',
            configRevision: 'config-revision-1',
            taskCount: 1,
            fileCount: 3,
            activatedAt: '2026-08-07T08:00:00.000Z'
          },
          pendingReconciliations: 0,
          queueCount: 0
        })]
      })
    }));

    const response = await api.stages();

    expect(response.stages[0]?.index?.revision).toBe('config-revision-1');
  });

  it('normalizes a legacy SSE state without revision before notifying consumers', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const onState = vi.fn();
    const disconnect = connectMediaIndexEvents({ onState });

    FakeEventSource.latest?.emit('media-index', JSON.stringify({
      type: 'state',
      stageId: 'E006',
      at: '2026-08-07T08:00:00.000Z',
      state: {
        stageId: 'E006',
        status: 'WARMING',
        watcherStatus: 'STARTING',
        pendingReconciliations: 0,
        queueCount: 1
      }
    }));

    expect(onState).toHaveBeenCalledWith(expect.objectContaining({
      stageId: 'E006',
      state: expect.objectContaining({ revision: '' })
    }));
    disconnect();
    expect(FakeEventSource.latest?.close).toHaveBeenCalledOnce();
  });
});

describe('WB 自动任务多店铺请求身份', () => {
  it('详情和运行记录把 storeId 放入查询参数', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] })
    });
    vi.stubGlobal('fetch', fetchMock);

    await api.wbAutoPublishJob('0000110', 'store/b');
    await api.wbAutoPublishRuns('0000110', 'store/b');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/v1/wb/automation/jobs/0000110?storeId=store%2Fb',
      expect.any(Object)
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/v1/wb/automation/jobs/0000110/runs?storeId=store%2Fb',
      expect.any(Object)
    );
  });

  it('重新检查、取消和兼容重启都在请求体携带 storeId', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ job: { storeId: 'store-b', sku: '0000110' } })
    });
    vi.stubGlobal('fetch', fetchMock);

    await api.recheckWbAutoPublishJob('0000110', 'store-b');
    await api.cancelWbAutoPublishJob('0000110', 'store-b');
    await api.startCompatibleWbAutoPublishJob('0000110', 'store-b');

    for (const call of fetchMock.mock.calls) {
      expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ storeId: 'store-b' });
    }
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/wb/automation/jobs/0000110/recheck',
      '/api/v1/wb/automation/jobs/0000110/cancel',
      '/api/v1/wb/automation/jobs/0000110/start-compatible'
    ]);
  });
});

describe('WB 手动清单 publication 查询合同', () => {
  it('用单个只读请求查询当前页 SKU 的手动发布状态', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    await api.wbPublications({ skus: ['0000110', '0000122'], source: 'MANUAL' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/wb/publications?skus=0000110%2C0000122&source=MANUAL',
      expect.any(Object)
    );
  });
});

describe('OZON 多店铺请求合同', () => {
  it('设置只写统一 settings PATCH，且不携带迁移前店铺字段', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ settings: {} }) });
    vi.stubGlobal('fetch', fetchMock);

    await api.ozonSettings();
    await api.updateOzonSettings({
      rowVersion: 7,
      enabled: true,
      globalConcurrency: 3,
      taskApiWebhookUrl: 'http://127.0.0.1:5678/webhook/ozon-task'
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/v1/ozon/settings', expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/v1/ozon/settings', expect.objectContaining({ method: 'PATCH' }));
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      rowVersion: 7,
      enabled: true,
      globalConcurrency: 3,
      taskApiWebhookUrl: 'http://127.0.0.1:5678/webhook/ozon-task'
    });
  });

  it('计划和创建传入 draftVersion、storeIds、planHash 与幂等 requestId', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ plan: {}, publications: [] }) });
    const planHash = `sha256:${'a'.repeat(64)}`;
    const requestId = '11111111-1111-4111-8111-111111111111';
    vi.stubGlobal('fetch', fetchMock);

    await api.planOzonPublications('0000/049', 12, ['store-a', 'store-b']);
    await api.createOzonPublications('0000/049', 12, ['store-a', 'store-b'], planHash, requestId);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/ozon/listings/0000%2F049/publication-plans',
      '/api/v1/ozon/listings/0000%2F049/publications'
    ]);
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      draftVersion: 12,
      storeIds: ['store-a', 'store-b']
    });
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      draftVersion: 12,
      storeIds: ['store-a', 'store-b'],
      planHash,
      requestId
    });
  });

  it('手动任务摘要由服务端按 SKU 批量选择最新 MANUAL 发布批次', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [], total: 0 }) });
    vi.stubGlobal('fetch', fetchMock);

    await api.ozonPublicationTaskSummaries(['0000134', '0000134', '0000140']);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/ozon/publication-task-summaries?skus=0000134%2C0000140&source=MANUAL&latestBatchOnly=true',
      expect.objectContaining({ headers: expect.any(Object) })
    );
  });

  it('publication 操作只使用 publicationId 和冻结版本参数', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ publication: {}, plan: {} }) });
    const appendPlanHash = `sha256:${'b'.repeat(64)}`;
    const recheckPlanHash = `sha256:${'c'.repeat(64)}`;
    const requestId = '22222222-2222-4222-8222-222222222222';
    vi.stubGlobal('fetch', fetchMock);

    await api.syncOzonPublication('publication/1', 8);
    await api.recheckOzonPublication('publication/1', { rowVersion: 8, planHash: recheckPlanHash, requestId });
    await api.cancelOzonPublication('publication/1', 8);
    await api.ozonPublicationCompatibleAppendPlan('publication/1');
    await api.compatibleAppendOzonPublication('publication/1', 8, appendPlanHash);
    await api.republishOzonPublication('publication/1', 8);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/ozon/publications/publication%2F1/sync',
      '/api/v1/ozon/publications/publication%2F1/recheck',
      '/api/v1/ozon/publications/publication%2F1/cancel',
      '/api/v1/ozon/publications/publication%2F1/compatible-append-plan',
      '/api/v1/ozon/publications/publication%2F1/compatible-append',
      '/api/v1/ozon/publications/publication%2F1/republish'
    ]);
    expect(fetchMock.mock.calls.slice(0, 3).map(([, init]) => JSON.parse(String((init as RequestInit).body)))).toEqual([
      { rowVersion: 8 }, { rowVersion: 8, planHash: recheckPlanHash, requestId }, { rowVersion: 8 }
    ]);
    expect((fetchMock.mock.calls[3]?.[1] as RequestInit).body).toBeUndefined();
    expect(JSON.parse(String((fetchMock.mock.calls[4]?.[1] as RequestInit).body))).toEqual({ rowVersion: 8, planHash: appendPlanHash });
    expect(JSON.parse(String((fetchMock.mock.calls[5]?.[1] as RequestInit).body))).toEqual({ rowVersion: 8 });
  });

  it('publication-managed 详情只按 publicationId 读取冻结合同和恢复能力', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ publication: {}, events: [], frozenContract: {}, recovery: { canRecheck: false } })
    });
    vi.stubGlobal('fetch', fetchMock);

    await api.ozonPublicationTaskDetail('publication/1');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/ozon/publications/publication%2F1/task-detail',
      expect.objectContaining({ headers: expect.any(Object) })
    );
  });

  it('自动任务详情用 storeId 查询，写操作用 storeId 请求体', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ job: {} }) });
    vi.stubGlobal('fetch', fetchMock);

    await api.ozonJob('job/1', 'store/b');
    await api.recheckOzonJob('job/1', 'store/b');
    await api.cancelOzonJob('job/1', 'store/b');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/ozon/automation/jobs/job%2F1?storeId=store%2Fb',
      '/api/v1/ozon/automation/jobs/job%2F1/recheck',
      '/api/v1/ozon/automation/jobs/job%2F1/cancel'
    ]);
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({ storeId: 'store/b' });
    expect(JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body))).toEqual({ storeId: 'store/b' });
  });

  it('共享准备重检计划必须携带当前 rowVersion，apply 复用冻结身份', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        plan: {},
        job: {},
        events: [],
        snapshot: { sku: '0000132', productName: '共享素材', generatedVersionId: 'version-2', data: {} }
      })
    });
    const planHash = `sha256:${'d'.repeat(64)}`;
    const requestId = '33333333-3333-4333-8333-333333333333';
    vi.stubGlobal('fetch', fetchMock);

    await api.ozonPreparationTaskDetail('job/132');
    const material = await api.ozonPreparationMaterialSnapshot('job/132');
    await api.ozonPreparationRecheckPlan('job/132', 4);
    await api.recheckOzonPreparation('job/132', { rowVersion: 4, planHash, requestId });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/ozon/automation/jobs/job%2F132/task-detail',
      '/api/v1/ozon/automation/jobs/job%2F132/material-snapshot',
      '/api/v1/ozon/automation/jobs/job%2F132/recheck-plan?rowVersion=4',
      '/api/v1/ozon/automation/jobs/job%2F132/recheck'
    ]);
    expect(material.snapshot).toEqual(expect.objectContaining({ sku: '0000132', generatedVersionId: 'version-2' }));
    expect(JSON.parse(String((fetchMock.mock.calls[3]?.[1] as RequestInit).body))).toEqual({ rowVersion: 4, planHash, requestId });
  });
});
