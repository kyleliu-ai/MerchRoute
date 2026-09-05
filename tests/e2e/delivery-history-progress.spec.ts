import { expect, test, type Page } from '@playwright/test';

const operation = { operationId: 'hidden-progress-operation', kind: 'BATCH', subjectKeys: ['task:fixture-task'], attempt: 1, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: new Date().toISOString() };
const pending = { id: 'fixture-pending', taskId: 'fixture-task', sourceStageId: 'E006', targetStageId: 'E001', sourceFolderName: 'fixture-product', selectedRelativePaths: ['1.png'], productSku: '9999999', productNameSnapshot: '进度隐藏测试商品', sourceStageEnabled: true, status: 'PACKAGING', conflictPolicy: 'new-revision', version: 1 };
const record = { submissionId: 'fixture-history', pendingSubmissionId: pending.id, taskId: pending.taskId, sourceStageId: 'E006', targetStageId: 'E001', sourceFolder: '/fixture/product', selectedImageCount: 1, productSku: pending.productSku, productNameSnapshot: pending.productNameSnapshot, startedAt: operation.createdAt, completedAt: operation.createdAt, status: 'SUCCESS' };

async function fakeEvents(page: Page) {
  await page.addInitScript(() => {
    class FakeSource extends EventTarget {
      onerror?: (event: Event) => void;
      constructor(url: string) {
        super();
        if (url.includes('review-operations/events')) (window as any).__reviewEvents = this;
      }
      close() {}
    }
    Object.defineProperty(window, 'EventSource', { value: FakeSource, configurable: true });
  });
}

for (const route of ['/pending', '/history']) {
  for (const status of ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED']) {
    test(`${route} hides the complete operation card for ${status}`, async ({ page }) => {
      await fakeEvents(page);
      await page.route('**/api/v1/review-operations?*', (request) => request.fulfill({ json: { items: [{ ...operation, status }] } }));
      await page.goto(route);
      await expect(page.getByRole('heading', { name: route === '/pending' ? '待投递清单' : '投递历史', exact: true })).toBeVisible();
      await expect(page.getByText('审核与投递进度', { exact: true })).toHaveCount(0);
      await expect(page.getByTestId('review-operation')).toHaveCount(0);
      await expect(page.getByText(operation.operationId, { exact: true })).toHaveCount(0);
      await expect(page.getByRole('columnheader', { name: '状态', exact: true })).toBeVisible();
    });
  }

  test(`${route} still refreshes delivery results through SSE without rendering a progress card`, async ({ page }) => {
    let completed = false;
    await fakeEvents(page);
    await page.route('**/api/v1/review-operations?*', (request) => request.fulfill({ json: { items: [{ ...operation, status: 'RUNNING' }] } }));
    await page.route('**/api/v1/pending-submissions?*', (request) => request.fulfill({ json: { items: completed ? [] : [pending], total: completed ? 0 : 1, page: 1, pageSize: 20 } }));
    await page.route('**/api/v1/submissions/history?*', (request) => request.fulfill({ json: { items: completed ? [record] : [], total: completed ? 1 : 0, page: 1, pageSize: 20 } }));
    await page.goto(route);
    const rows = page.locator('.ant-table-tbody > tr.ant-table-row');
    await expect(rows).toHaveCount(route === '/pending' ? 1 : 0);
    await expect.poll(() => page.evaluate(() => Boolean((window as any).__reviewEvents))).toBe(true);
    completed = true;
    await page.evaluate((result) => {
      const source = (window as any).__reviewEvents as EventTarget;
      source.dispatchEvent(new Event('open'));
      source.dispatchEvent(new MessageEvent('review-operation', { data: JSON.stringify(result) }));
    }, { ...operation, status: 'SUCCEEDED' });
    await expect(rows).toHaveCount(route === '/pending' ? 0 : 1);
    if (route === '/history') await expect(rows.first()).toContainText('投递成功');
    await expect(page.getByTestId('review-operation')).toHaveCount(0);
  });
}

test('review workbench and task detail retain their visible operation card', async ({ page }) => {
  await fakeEvents(page);
  await page.route('**/api/v1/review-operations?*', (request) => request.fulfill({ json: { items: [{ ...operation, status: 'RUNNING' }] } }));
  await page.goto('/review/E005');
  await expect(page.getByText('审核与投递进度', { exact: true })).toBeVisible();
  await page.goto('/task/progress-visibility-fixture');
  await expect(page.getByText('审核与投递进度', { exact: true })).toBeVisible();
});

test('history distinguishes five outcomes and retains details and appropriate recovery actions', async ({ page }) => {
  await fakeEvents(page);
  const items = [
    { ...record, submissionId: 'successful' },
    { ...record, submissionId: 'failed', status: 'FAILED', errorCode: 'COPY_FAILED', errorMessage: 'fixture copy failed' },
    { ...record, submissionId: 'archive', status: 'PARTIAL_SUCCESS', errorCode: 'ARCHIVE_ROOT_UNAVAILABLE' },
    { ...record, submissionId: 'unknown', status: 'FAILED', errorCode: 'DELIVERY_OUTCOME_UNKNOWN', errorMessage: 'fixture awaiting readback' },
    { ...record, submissionId: 'skipped', status: 'SKIPPED_CONFLICT', errorCode: 'TARGET_FOLDER_EXISTS' }
  ];
  await page.route('**/api/v1/submissions/history?*', (request) => request.fulfill({ json: { items, total: 5, page: 1, pageSize: 20 } }));
  const retried: string[] = [];
  await page.route('**/api/v1/submissions/*/retry', async (request) => {
    retried.push(request.request().url().split('/').at(-2)!);
    await request.fulfill({ status: 202, json: { operation: { ...operation, status: 'QUEUED' } } });
  });
  await page.goto('/history');
  const rows = page.locator('.ant-table-tbody > tr.ant-table-row');
  await expect(rows).toHaveCount(5);
  for (const label of ['投递成功', '投递失败', '已投递，归档未完成', '结果待核对', '重名跳过']) await expect(page.getByText(label, { exact: true })).toBeVisible();
  await rows.filter({ hasText: 'failed' }).locator('.ant-table-row-expand-icon').click();
  await expect(page.getByText('COPY_FAILED: fixture copy failed', { exact: true })).toBeVisible();
  await rows.filter({ hasText: 'unknown' }).getByRole('button', { name: '重新核对结果' }).click();
  await expect.poll(() => retried).toEqual(['unknown']);
  await expect(page.getByText('重试请求已接收，结果请查看投递历史', { exact: true })).toBeVisible();
  await rows.filter({ hasText: 'archive' }).getByRole('button', { name: '重试归档' }).click();
  await expect.poll(() => retried).toEqual(['unknown', 'archive']);
});

test('hidden progress uses low-frequency polling after SSE disconnects', async ({ page }) => {
  let completed = false, requests = 0;
  await fakeEvents(page);
  await page.clock.install();
  await page.route('**/api/v1/review-operations?*', (request) => { requests++; return request.fulfill({ json: { items: [{ ...operation, status: completed ? 'SUCCEEDED' : 'RUNNING' }] } }); });
  await page.route('**/api/v1/submissions/history?*', (request) => request.fulfill({ json: { items: completed ? [record] : [], total: completed ? 1 : 0, page: 1, pageSize: 20 } }));
  await page.goto('/history');
  await expect.poll(() => requests).toBe(1);
  await page.evaluate(() => (window as any).__reviewEvents.dispatchEvent(new Event('open')));
  await page.waitForTimeout(100);
  await page.clock.fastForward(31_000);
  expect(requests).toBe(1);
  completed = true;
  await page.evaluate(() => (window as any).__reviewEvents.onerror?.(new Event('error')));
  await page.waitForTimeout(100);
  await page.clock.fastForward(31_000);
  await expect.poll(() => requests).toBe(2);
  await expect(page.getByText('投递成功', { exact: true })).toBeVisible();
  await expect(page.getByTestId('review-operation')).toHaveCount(0);
});
