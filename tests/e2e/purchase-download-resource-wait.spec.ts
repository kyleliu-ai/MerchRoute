import { expect, test } from '@playwright/test';

const waitingPurchase = {
  sku: '0099007',
  productName: 'E2E-1688资源等待',
  variants: [],
  createdAt: '2026-08-01T13:00:00.000Z',
  updatedAt: '2026-08-01T13:00:00.000Z',
  procurement: {
    id: '00000000-0000-4000-8000-000000009907',
    versionNo: 1,
    downloadWorkflowCode: 'E007',
    purchasePrice: '10.0000',
    courierFee: '2.0000',
    currency: 'CNY',
    grossWeightGrams: '500.000',
    lengthCm: '20.000',
    widthCm: '10.000',
    heightCm: '8.000',
    transportMode: '',
    providerUrl: 'https://detail.1688.com/offer/850722460359.html',
    createdAt: '2026-08-01T13:00:00.000Z'
  },
  latestDownloadJob: {
    id: '00000000-0000-4000-8000-000000006607',
    status: 'WAITING_RESOURCE',
    workflowCode: 'E007',
    createdAt: '2026-08-01T13:01:00.000Z',
    errorMessage: '1688 专用浏览器正在用于登录或另一条下载任务；释放后系统将自动重试。',
    nextAttemptAt: '2026-08-01T13:06:00.000Z',
    retryReason: 'profile_busy',
    resourceRetryCount: 3
  }
};

test('采购页面显示 E007 资源等待状态并阻止重复入队', async ({ page }) => {
  await page.route('**/api/v1/purchases?**', async (route) => {
    await route.fulfill({ json: { items: [waitingPurchase], total: 1, page: 1, pageSize: 50 } });
  });
  await page.goto('/purchases/url-download');

  const row = page.getByRole('row').filter({ hasText: waitingPurchase.productName });
  await expect(row).toContainText('等待下载浏览器释放');
  await expect(row).toContainText('第 3 次等待');
  await expect(row.getByRole('checkbox')).toBeDisabled();

  const statusSelector = page.locator('.filter-bar .ant-select-selector').nth(1);
  const filteredRequest = page.waitForRequest((request) => new URL(request.url()).searchParams.get('status') === 'WAITING_RESOURCE');
  await statusSelector.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '等待下载浏览器释放' }).click();
  await filteredRequest;

  await page.setViewportSize({ width: 320, height: 760 });
  await expect(row.getByText('等待下载浏览器释放', { exact: false })).toBeVisible();
});
