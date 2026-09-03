import { expect, test } from '@playwright/test';

test('recovers a lost approval acknowledgement and reloads batch progress without SSE', async ({ page }) => {
  const before = (await (await page.request.get('/api/v1/submissions/history')).json()).items;
  const existingIds = new Set(before.map((record: any) => record.submissionId));
  await page.route('**/api/v1/review-operations/events', (route) => route.abort());
  await page.goto('/review/E006');
  const row = page.locator('.task-table .ant-table-tbody tr').filter({ hasText: 'E2E-测试产品A' });
  await row.locator('a[href^="/task/"]').first().click();
  await page.getByRole('button', { name: '当前目录全选' }).click();
  let requestBody: any;
  let key = '';
  let operationId = '';
  let approveUrl = '';
  await page.route('**/api/v1/tasks/*/approve', async (route) => {
    requestBody = route.request().postDataJSON();
    key = route.request().headers()['idempotency-key']!;
    approveUrl = route.request().url();
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    operationId = (await response.json()).operation.operationId;
    await route.abort('connectionfailed');
  });
  await page.getByRole('button', { name: '审核通过' }).click();
  await page.getByRole('button', { name: '加入待投递清单' }).click();
  await expect.poll(() => operationId).not.toBe('');
  await page.unroute('**/api/v1/tasks/*/approve');
  await page.reload();
  await page.goto('/pending');
  const pending = page.locator('.ant-table-tbody tr').filter({ hasText: 'E2E-测试产品A' });
  await expect(pending).toHaveCount(1);
  const replay = await page.request.post(approveUrl, { headers: { Prefer: 'respond-async', 'Idempotency-Key': key }, data: requestBody });
  expect(replay.status()).toBe(202);
  expect((await replay.json()).operation.operationId).toBe(operationId);
  await expect(pending).toHaveCount(1);
  await pending.locator('label.ant-checkbox-wrapper').click();
  const accepted = page.waitForResponse((response) => response.url().endsWith('/api/v1/submissions/batch') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '批量投递' }).click();
  const response = await accepted;
  expect(response.status()).toBe(202);
  const batchOperationId = (await response.json()).operation.operationId;
  await page.reload();
  await expect(page.getByTestId('review-operation').filter({ hasText: batchOperationId })).toContainText('已完成');
  await expect(pending).toHaveCount(0);
  const batchReplay = await page.request.post(response.url(), {
    headers: { Prefer: 'respond-async', 'Idempotency-Key': response.request().headers()['idempotency-key']! },
    data: response.request().postDataJSON()
  });
  expect(batchReplay.status()).toBe(202);
  expect((await batchReplay.json()).operation.operationId).toBe(batchOperationId);
  const history = (await (await page.request.get('/api/v1/submissions/history')).json()).items;
  const delivered = history.filter((record: any) => record.sourceFolder.includes('E2E-测试产品A') && !existingIds.has(record.submissionId));
  expect(delivered).toHaveLength(1);
});
