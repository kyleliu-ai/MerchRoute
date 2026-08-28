import { expect, test } from '@playwright/test';

const activeBatchStorageKey = 'pixroute.purchase-download-active-batch.v1';
const batchId = 'e2e-compact-purchase-batch';

function batch(status: 'RUNNING' | 'COMPLETED') {
  return {
    id: batchId,
    totalRequested: 3,
    queuedCount: 3,
    skippedCount: 1,
    skippedItems: [{ sku: '0000003', workflowCode: 'E006', reason: 'duplicate', message: '测试跳过' }],
    status,
    counts: {
      QUEUED: status === 'RUNNING' ? 1 : 0,
      WAITING_RESOURCE: 0,
      RUNNING: status === 'RUNNING' ? 1 : 0,
      SUCCEEDED: status === 'COMPLETED' ? 2 : 1,
      FAILED: status === 'COMPLETED' ? 1 : 0
    },
    createdAt: '2026-08-06T08:00:00.000Z',
    finishedAt: status === 'COMPLETED' ? '2026-08-06T08:01:00.000Z' : undefined,
    items: []
  };
}

test('采购批量下载完成卡片紧凑显示且不改变进行中卡片', async ({ page }) => {
  let batchStatus: 'RUNNING' | 'COMPLETED' = 'COMPLETED';
  await page.addInitScript(({ key, id }) => sessionStorage.setItem(key, id), { key: activeBatchStorageKey, id: batchId });
  await page.route('**/api/v1/purchases?**', async (route) => {
    await route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 50 } });
  });
  await page.route(`**/api/v1/purchase-download-batches/${batchId}`, async (route) => {
    await route.fulfill({ json: { batch: batch(batchStatus) } });
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/purchases/url-download');

  const completeCard = page.locator('.batch-progress-card.is-complete');
  await expect(completeCard).toContainText('批量下载已结束');
  await expect(completeCard).toContainText('成功 2');
  await expect(completeCard).toContainText('失败 1');
  await expect(completeCard).toContainText('跳过 1');
  await expect(completeCard.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');

  const compactMetrics = await completeCard.evaluate((element) => {
    const body = element.querySelector<HTMLElement>(':scope > .ant-card-body')!;
    const eyebrow = element.querySelector<HTMLElement>('.batch-progress-eyebrow')!;
    const heading = element.querySelector<HTMLElement>('.batch-progress-copy h4')!;
    const tag = element.querySelector<HTMLElement>('.batch-progress-copy .ant-tag')!;
    const circle = element.querySelector<HTMLElement>('.ant-progress-circle')!;
    const meter = element.querySelector<HTMLElement>('.batch-progress-meter')!;
    return {
      bodyPadding: getComputedStyle(body).padding,
      eyebrowFontSize: getComputedStyle(eyebrow).fontSize,
      headingFontSize: getComputedStyle(heading).fontSize,
      headingLineHeight: getComputedStyle(heading).lineHeight,
      tagFontSize: getComputedStyle(tag).fontSize,
      tagLineHeight: getComputedStyle(tag).lineHeight,
      circleWidth: circle.getBoundingClientRect().width,
      meterDirection: getComputedStyle(meter).flexDirection,
      cardHeight: element.getBoundingClientRect().height,
      hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  });
  expect(compactMetrics).toMatchObject({
    bodyPadding: '12px 16px',
    eyebrowFontSize: '11px',
    headingFontSize: '15px',
    tagFontSize: '11px',
    tagLineHeight: '18px',
    meterDirection: 'row',
    hasHorizontalOverflow: false
  });
  expect(parseFloat(compactMetrics.headingLineHeight)).toBeCloseTo(18.75, 1);
  expect(compactMetrics.circleWidth).toBeCloseTo(52, 0);
  expect(compactMetrics.cardHeight).toBeLessThanOrEqual(90);

  await page.setViewportSize({ width: 320, height: 760 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(completeCard.getByRole('button', { name: '收起' })).toBeVisible();

  batchStatus = 'RUNNING';
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  const runningCard = page.locator('.batch-progress-card:not(.is-complete)');
  await expect(runningCard).toContainText('正在后台串行下载');
  await expect(runningCard.getByRole('button', { name: '收起' })).toHaveCount(0);
  await expect.poll(async () => runningCard.getByRole('progressbar').evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(76, 0);

  batchStatus = 'COMPLETED';
  await page.reload();
  await completeCard.getByRole('button', { name: '收起' }).click();
  await expect(completeCard).toHaveCount(0);
  await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), activeBatchStorageKey)).toBeNull();
});
