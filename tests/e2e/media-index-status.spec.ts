import { expect, test } from '@playwright/test';
import type { MediaIndexStatus, ProductTask, StageView } from '@n8n-media-review/shared';

test.use({ timezoneId: 'Asia/Shanghai' });

test('keeps a cold READY dashboard visually stable while config and stages are delayed', async ({ page }) => {
  const [configResponse, stagesResponse] = await Promise.all([
    page.request.get('/api/v1/config'),
    page.request.get('/api/v1/stages')
  ]);
  expect(configResponse.ok()).toBe(true);
  expect(stagesResponse.ok()).toBe(true);
  const config = await configResponse.json();
  const originalStages = await stagesResponse.json() as { stages: StageView[] };
  const stages = {
    stages: originalStages.stages.map((stage) => ({
      ...stage,
      index: {
        ...stage.index,
        stageId: stage.id,
        status: stage.enabled && stage.reviewEnabled ? 'READY' as const : 'DISABLED' as const,
        watcherStatus: stage.enabled && stage.reviewEnabled ? 'ACTIVE' as const : 'DISABLED' as const,
        revision: stage.index?.revision || 'cold-ready',
        pendingReconciliations: 0,
        queueCount: 0
      }
    }))
  };
  const forbiddenLabels = ['首次建立索引', '媒体索引同步中', '需要完成设置'];

  await page.addInitScript((labels) => {
    const seen = [] as string[];
    Object.defineProperty(window, '__coldReadyForbiddenLabels', { configurable: true, value: seen });
    const capture = () => {
      const text = document.body?.innerText || '';
      for (const label of labels) {
        if (text.includes(label) && !seen.includes(label)) seen.push(label);
      }
    };
    const start = () => {
      capture();
      new MutationObserver(capture).observe(document.body, { childList: true, subtree: true, characterData: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }, forbiddenLabels);
  await page.route('**/api/v1/media-index/events', async (route) => route.fulfill({ status: 503, body: '' }));
  await page.route('**/api/v1/config', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(config) });
  });
  await page.route('**/api/v1/stages', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(stages) });
  });

  await page.goto('/');
  await page.waitForTimeout(300);
  await expect(page.getByText('首次建立索引', { exact: true })).toHaveCount(0);
  await expect(page.getByText('媒体索引同步中', { exact: true })).toHaveCount(0);
  await expect(page.getByText('需要完成设置', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '产品图片审核与投递' })).toBeVisible();
  await expect(page.locator('.dashboard-bootstrap-state')).toBeVisible();
  const bootstrapRegionY = await page.locator('.dashboard-content-region').evaluate((element) => element.getBoundingClientRect().y);
  await expect(page.locator('.pipeline-rail')).toBeVisible();
  await expect(page.locator('.stage-card').first()).toBeVisible();
  await expect(page.locator('.media-index-banner')).toHaveCount(0);
  await expect(page.getByText('目录已就绪', { exact: true })).toBeVisible();
  const readyRegionY = await page.locator('.dashboard-content-region').evaluate((element) => element.getBoundingClientRect().y);
  expect(Math.abs(readyRegionY - bootstrapRegionY)).toBeLessThanOrEqual(1);
  const transientLabels = await page.evaluate(() => (window as unknown as { __coldReadyForbiddenLabels: string[] }).__coldReadyForbiddenLabels);
  expect(transientLabels).toEqual([]);
});

test('keeps MerchRoute usable while the media index warms, refreshes, becomes stale, or fails', async ({ page }) => {
  const stagesResponse = await page.request.get('/api/v1/stages');
  expect(stagesResponse.ok()).toBe(true);
  const original = await stagesResponse.json() as { stages: StageView[] };
  let status: MediaIndexStatus = 'WARMING';
  let rescanRequests = 0;
  let splitFreshness = false;
  const lastReconciledAt = '2026-08-07T16:00:00+08:00';
  const staleStageReconciledAt = '2026-08-01T16:00:00+08:00';

  await page.route('**/api/v1/media-index/events', async (route) => route.fulfill({ status: 503, body: '' }));
  await page.route('**/api/v1/stages', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        stages: original.stages.map((stage) => {
          const stageStatus: MediaIndexStatus = stage.enabled && stage.reviewEnabled
            ? splitFreshness ? stage.id === 'E001' ? 'STALE' : 'READY' : status
            : 'DISABLED';
          const stageReconciledAt = splitFreshness && stage.id === 'E001' ? staleStageReconciledAt : lastReconciledAt;
          return {
            ...stage,
            summary: stage.id === 'E001'
              ? { ...stage.summary, pending: 17, drafts: 3, approved: 2, totalTasks: 20, lastScannedAt: stageStatus === 'WARMING' ? null : stageReconciledAt }
              : stage.summary,
            index: {
              stageId: stage.id,
              status: stageStatus,
              watcherStatus: stage.enabled && stage.reviewEnabled ? 'ACTIVE' : 'DISABLED',
              pendingReconciliations: stageStatus === 'READY' ? 0 : 1,
              queueCount: stageStatus === 'READY' ? 0 : 1,
              ...(stageStatus === 'WARMING' ? {} : { lastReconciledAt: stageReconciledAt }),
              ...(stageStatus === 'ERROR' ? { error: '测试索引失败' } : {})
            }
          };
        })
      })
    });
  });
  await page.route('**/api/v1/stages/rescan', async (route) => {
    rescanRequests += 1;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ accepted: true, requestedAt: new Date().toISOString() }) });
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '产品图片审核与投递' })).toBeVisible();
  await expect(page.locator('.media-index-banner').getByText('首次建立索引', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '建立索引中' })).toBeVisible();
  await expect(page.locator('.pipeline-rail')).toBeVisible();
  await expect(page.locator('.stage-card').filter({ hasText: 'E001' }).getByText('—', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.page-stack > .ant-skeleton')).toHaveCount(0);

  status = 'READY';
  await page.reload();
  const e001Card = page.locator('.stage-card').filter({ hasText: 'E001' });
  await expect(e001Card.getByText('17', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '刷新状态' })).toBeVisible();
  const readyRailY = await page.locator('.pipeline-rail').evaluate((element) => element.getBoundingClientRect().y);
  const readyCardBoxes = await page.locator('.stage-card').evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { y: box.y, height: box.height };
  }));

  status = 'REFRESHING';
  await page.getByRole('button', { name: '刷新状态' }).click();
  await expect.poll(() => rescanRequests).toBe(1);
  await expect(page.getByRole('button', { name: '同步中' })).toBeVisible();
  await expect(page.locator('.stage-rescan-button')).toHaveClass(/ant-btn-loading/);
  await expect(page.locator('.media-index-banner')).toHaveCount(0);
  await expect(e001Card.getByText('17', { exact: true })).toBeVisible();
  const refreshingRailY = await page.locator('.pipeline-rail').evaluate((element) => element.getBoundingClientRect().y);
  const refreshingCardBoxes = await page.locator('.stage-card').evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { y: box.y, height: box.height };
  }));
  expect(Math.abs(refreshingRailY - readyRailY)).toBeLessThanOrEqual(1);
  expect(refreshingCardBoxes).toHaveLength(readyCardBoxes.length);
  for (const [index, readyBox] of readyCardBoxes.entries()) {
    expect(Math.abs(refreshingCardBoxes[index]!.y - readyBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(refreshingCardBoxes[index]!.height - readyBox.height)).toBeLessThanOrEqual(1);
  }

  status = 'STALE';
  await page.reload();
  await expect(page.locator('.media-index-banner').getByText('媒体索引等待校准', { exact: true })).toBeVisible();
  await expect(e001Card.getByText('17', { exact: true })).toBeVisible();
  await expect(e001Card.locator('.stage-index-state')).toContainText('截至');
  await page.locator('.media-index-banner').getByRole('button', { name: '重新校准' }).click();
  await expect.poll(() => rescanRequests).toBe(2);
  await expect(page.getByText('已提交后台校准', { exact: true })).toBeVisible();

  await page.goto('/review/downloads');
  await expect(page.getByRole('heading', { name: '下载中心', exact: true })).toBeVisible();
  await expect(page.locator('.media-index-banner').getByText('媒体索引等待校准', { exact: true })).toBeVisible();
  await expect(page.locator('.download-source-card').first().locator('.stage-index-state')).toContainText('截至');

  await page.goto('/history');
  await expect(page.locator('.history-workflow-shortcuts .media-index-compact-state')).toContainText('数据待校准');
  await expect(page.locator('.history-workflow-shortcuts .media-index-compact-state')).toContainText('08-07');

  splitFreshness = true;
  await page.goto('/');
  const staleBanner = page.locator('.media-index-banner');
  await expect(staleBanner.getByText('媒体索引等待校准', { exact: true })).toBeVisible();
  await expect(staleBanner).toContainText('2026-08-01 16:00:00');
  await expect(staleBanner).not.toContainText('2026-08-07 16:00:00');
  splitFreshness = false;

  status = 'ERROR';
  await page.goto('/');
  await expect(page.locator('.media-index-banner').getByText('媒体索引更新失败', { exact: true })).toBeVisible();
  await expect(page.locator('.media-index-banner')).toContainText('测试索引失败');
  await expect(page.locator('.stage-card').filter({ hasText: 'E001' }).getByText('17', { exact: true })).toBeVisible();

  status = 'READY';
  await page.reload();
  await expect(page.locator('.media-index-banner')).toHaveCount(0);
  await expect(page.locator('.stage-card').filter({ hasText: 'E001' }).getByText('17', { exact: true })).toBeVisible();

  status = 'DISABLED';
  await page.reload();
  await expect(page.locator('.media-index-banner')).toHaveCount(0);
  await expect(page.locator('.stage-card').filter({ hasText: 'E001' }).getByText('17', { exact: true })).toBeVisible();
  await expect(page.locator('.stage-index-state.is-disabled:not(.is-empty)')).toHaveCount(0);
});

test('keeps an explicit query failure stable without reporting an empty workflow configuration', async ({ page }) => {
  await page.route('**/api/v1/media-index/events', async (route) => route.fulfill({ status: 503, body: '' }));
  await page.route('**/api/v1/config', async (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_CONFIG_FAILURE', message: '配置读取失败' } }) }));
  await page.route('**/api/v1/stages', async (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'TEST_STAGES_FAILURE', message: '状态读取失败' } }) }));

  await page.goto('/');
  await expect(page.getByText('配置状态不可用', { exact: true })).toBeVisible();
  await expect(page.getByText('需要完成设置', { exact: true })).toHaveCount(0);
  await expect(page.getByText('无法读取工作流状态', { exact: true })).toBeVisible();
  await expect(page.getByText('还没有已启用的工作流', { exact: true })).toHaveCount(0);
  await expect(page.locator('.dashboard-bootstrap-state.is-error')).toBeVisible();
  const errorHeight = await page.locator('.dashboard-bootstrap-state.is-error').evaluate((element) => element.getBoundingClientRect().height);
  expect(errorHeight).toBeGreaterThanOrEqual(480);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: '产品图片审核与投递' })).toBeVisible();
  await expect(page.locator('.dashboard-bootstrap-state.is-error')).toBeVisible();
  await expect(page.locator('.stage-rescan-button')).toBeVisible();
});

test('coalesces media index event bursts and refreshes once after open, reconnect, and visible-page recovery', async ({ page }) => {
  const stagesResponse = await page.request.get('/api/v1/stages');
  expect(stagesResponse.ok()).toBe(true);
  const original = await stagesResponse.json() as { stages: StageView[] };
  const eventSnapshot = {
    stages: original.stages.map((stage) => ({
      ...stage,
      index: {
        ...stage.index,
        stageId: stage.id,
        status: stage.enabled && stage.reviewEnabled ? 'READY' as const : 'DISABLED' as const,
        watcherStatus: stage.enabled && stage.reviewEnabled ? 'ACTIVE' as const : 'DISABLED' as const,
        revision: stage.index?.revision || 'event-ready',
        pendingReconciliations: 0,
        queueCount: 0
      }
    }))
  };
  let detailTask: ProductTask | undefined;
  for (const stage of original.stages.filter((item) => item.enabled && item.reviewEnabled)) {
    const response = await page.request.get(`/api/v1/stages/${stage.id}/tasks?page=1&pageSize=1&sort=time&order=desc`);
    if (!response.ok()) continue;
    detailTask = ((await response.json()) as { items: ProductTask[] }).items[0];
    if (detailTask) break;
  }
  expect(detailTask).toBeDefined();
  const stageId = detailTask!.stageId;
  let stageRequests = 0;
  let taskListRequests = 0;
  let detailRequests = 0;
  await page.route(new RegExp(`/api/v1/stages/${stageId}/tasks\\?`), async (route) => {
    taskListRequests += 1;
    await route.continue();
  });
  await page.route(`**/api/v1/tasks/${detailTask!.taskId}`, async (route) => {
    detailRequests += 1;
    await route.continue();
  });

  await page.addInitScript(() => {
    class FakeEventSource extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSED = 2;
      readyState = 0;
      withCredentials = false;
      onopen = null;
      onmessage = null;
      onerror = null;
      constructor(public readonly url: string) {
        super();
        // Review-operation progress has its own SSE connection. Dispatch this
        // fixture's media events only to the media-index stream.
        if (new URL(url, window.location.href).pathname === '/api/v1/media-index/events') {
          (window as unknown as { __mediaIndexSource: FakeEventSource }).__mediaIndexSource = this;
        }
      }
      close() { this.readyState = FakeEventSource.CLOSED; }
    }
    Object.defineProperty(window, 'EventSource', { configurable: true, value: FakeEventSource });
  });
  await page.route('**/api/v1/stages', async (route) => {
    stageRequests += 1;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(eventSnapshot) });
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '产品图片审核与投递' })).toBeVisible();
  await expect.poll(() => stageRequests).toBe(1);
  await page.evaluate(() => {
    const source = (window as unknown as { __mediaIndexSource: EventTarget }).__mediaIndexSource;
    source.dispatchEvent(new Event('open'));
  });
  await expect.poll(() => stageRequests).toBe(2);
  await page.waitForTimeout(250);
  expect(stageRequests).toBe(2);

  const directStageLink = page.locator(`a[href="/review/${stageId}"]`).first();
  if (await directStageLink.count() === 0) {
    await page.locator('a[href="/review/downloads"]').first().click();
    await expect(page).toHaveURL(/\/review\/downloads$/);
  }
  await page.locator(`a[href="/review/${stageId}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/review/${stageId}$`));
  await expect.poll(() => taskListRequests).toBe(1);
  const beforeListBurstStages = stageRequests;
  const beforeListBurstTasks = taskListRequests;
  await page.evaluate(({ stageId }) => {
    const source = (window as unknown as { __mediaIndexSource: EventTarget }).__mediaIndexSource;
    for (let index = 0; index < 8; index += 1) {
      source.dispatchEvent(new MessageEvent('media-index', { data: JSON.stringify({
        type: 'index-changed', stageId, at: new Date().toISOString(),
        state: { stageId, status: 'READY', watcherStatus: 'ACTIVE', revision: `burst-list-${index}`, pendingReconciliations: 0, queueCount: 0 }
      }) }));
    }
  }, { stageId });
  expect(stageRequests).toBe(beforeListBurstStages);
  expect(taskListRequests).toBe(beforeListBurstTasks);
  await expect.poll(() => stageRequests).toBe(beforeListBurstStages + 1);
  await expect.poll(() => taskListRequests).toBe(beforeListBurstTasks + 1);
  await page.waitForTimeout(250);
  expect(stageRequests).toBe(beforeListBurstStages + 1);
  expect(taskListRequests).toBe(beforeListBurstTasks + 1);

  await page.locator(`a[href="/task/${detailTask!.taskId}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/task/${detailTask!.taskId}$`));
  await expect.poll(() => detailRequests).toBe(1);
  const beforeDetailBurstStages = stageRequests;
  const beforeDetailBurstTasks = taskListRequests;
  const beforeDetailBurstDetails = detailRequests;
  await page.evaluate(({ stageId }) => {
    const source = (window as unknown as { __mediaIndexSource: EventTarget }).__mediaIndexSource;
    for (let index = 0; index < 8; index += 1) {
      source.dispatchEvent(new MessageEvent('media-index', { data: JSON.stringify({
        type: 'index-changed', stageId, at: new Date().toISOString(),
        state: { stageId, status: 'READY', watcherStatus: 'ACTIVE', revision: `burst-detail-${index}`, pendingReconciliations: 0, queueCount: 0 }
      }) }));
    }
  }, { stageId });
  expect(stageRequests).toBe(beforeDetailBurstStages);
  expect(detailRequests).toBe(beforeDetailBurstDetails);
  await expect.poll(() => stageRequests).toBe(beforeDetailBurstStages + 1);
  await expect.poll(() => detailRequests).toBe(beforeDetailBurstDetails + 1);
  await page.waitForTimeout(250);
  expect(stageRequests).toBe(beforeDetailBurstStages + 1);
  expect(taskListRequests).toBe(beforeDetailBurstTasks);
  expect(detailRequests).toBe(beforeDetailBurstDetails + 1);

  const beforeReviewStages = stageRequests;
  const beforeReviewDetails = detailRequests;
  await page.evaluate(({ stageId }) => {
    const source = (window as unknown as { __mediaIndexSource: EventTarget }).__mediaIndexSource;
    for (let index = 0; index < 8; index += 1) {
      source.dispatchEvent(new MessageEvent('media-index', { data: JSON.stringify({
        type: 'review-state-changed', stageId, at: new Date().toISOString(),
        state: { stageId, status: 'READY', watcherStatus: 'ACTIVE', revision: `review-${index}`, pendingReconciliations: 0, queueCount: 0 }
      }) }));
    }
  }, { stageId });
  await expect.poll(() => stageRequests).toBe(beforeReviewStages + 1);
  await expect.poll(() => detailRequests).toBe(beforeReviewDetails + 1);
  await page.waitForTimeout(250);
  expect(stageRequests).toBe(beforeReviewStages + 1);
  expect(detailRequests).toBe(beforeReviewDetails + 1);

  const beforeConnectedVisibilityStages = stageRequests;
  const beforeConnectedVisibilityDetails = detailRequests;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(250);
  expect(stageRequests).toBe(beforeConnectedVisibilityStages);
  expect(detailRequests).toBe(beforeConnectedVisibilityDetails);

  const beforeReconnectStages = stageRequests;
  const beforeReconnectDetails = detailRequests;
  await page.evaluate(({ stageId }) => {
    const source = (window as unknown as { __mediaIndexSource: EventTarget }).__mediaIndexSource;
    source.dispatchEvent(new MessageEvent('media-index', { data: JSON.stringify({
      type: 'index-changed', stageId, at: new Date().toISOString(),
      state: { stageId, status: 'READY', watcherStatus: 'ACTIVE', revision: 'overlap-reconnect', pendingReconciliations: 0, queueCount: 0 }
    }) }));
  }, { stageId });
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const source = (window as unknown as { __mediaIndexSource: EventTarget }).__mediaIndexSource;
    source.dispatchEvent(new Event('error'));
    source.dispatchEvent(new Event('open'));
  });
  await expect.poll(() => stageRequests).toBe(beforeReconnectStages + 1);
  await expect.poll(() => detailRequests).toBe(beforeReconnectDetails + 1);
  await page.waitForTimeout(250);
  expect(stageRequests).toBe(beforeReconnectStages + 1);
  expect(detailRequests).toBe(beforeReconnectDetails + 1);
  await page.waitForTimeout(350);
  expect(stageRequests).toBe(beforeReconnectStages + 1);
  expect(detailRequests).toBe(beforeReconnectDetails + 1);

  const beforeVisibilityStages = stageRequests;
  const beforeVisibilityDetails = detailRequests;
  await page.evaluate(() => {
    const source = (window as unknown as { __mediaIndexSource: EventTarget }).__mediaIndexSource;
    source.dispatchEvent(new Event('error'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => stageRequests).toBe(beforeVisibilityStages + 1);
  await expect.poll(() => detailRequests).toBe(beforeVisibilityDetails + 1);
  await page.waitForTimeout(250);
  expect(stageRequests).toBe(beforeVisibilityStages + 1);
  expect(detailRequests).toBe(beforeVisibilityDetails + 1);
});
