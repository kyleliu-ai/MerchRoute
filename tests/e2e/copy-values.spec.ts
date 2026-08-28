import { expect, test, type Locator, type Page } from '@playwright/test';

test.describe('关键字段一键复制', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:4183' });
  });

  test('采购管理中的 SKU 与产品名逐项复制并保留前导零', async ({ page }) => {
    const purchase = {
      sku: '0000007', productName: '布鞋', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      procurement: {
        id: 'purchase-version-7', versionNo: 1, purchasePrice: '5.0000', courierFee: '3.0000', currency: 'CNY',
        grossWeightGrams: '550.000', lengthCm: '30.000', widthCm: '15.000', heightCm: '10.000',
        providerUrl: 'https://example.com/product/7', createdAt: new Date().toISOString()
      }
    };
    await page.route('**/api/v1/purchases?*', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [purchase], total: 1, page: 1, pageSize: 50 }) }));
    await page.route('**/api/v1/download-workflows?*', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }));
    await page.goto('/purchases/url-download');

    const row = page.locator('.purchase-table-card .ant-table-tbody tr').filter({ hasText: purchase.sku });
    const skuCopy = copyButton(row, 'SKU', purchase.sku);
    const nameCopy = copyButton(row, '产品名', purchase.productName);
    await expectCopied(page, skuCopy, purchase.sku);
    await expectCopied(page, nameCopy, purchase.productName);
    await expect(skuCopy).not.toHaveClass(/is-copied/);

    await page.setViewportSize({ width: 320, height: 720 });
    await expect(nameCopy).toBeVisible();
    expect((await nameCopy.boundingBox())!.width).toBeGreaterThanOrEqual(34);
    await nameCopy.focus();
    await expect(nameCopy).toBeFocused();
  });

  test('WB 上品资料的产品 SKU 支持悬停提示和复制', async ({ page }) => {
    const listing = { sku: '0000020', productName: 'WB复制测试商品', titleRu: 'Тестовый товар', status: 'DRAFT', draftVersion: 1, generatedVersionId: 'generated-copy-test', mediaCount: 0 };
    await page.route('**/api/v1/wb/listings?*', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [listing], total: 1, page: 1, pageSize: 100 }) }));
    await page.route('**/api/v1/wb/publications?*', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{
      id: '11111111-1111-4111-8111-111111111111', sku: listing.sku, generatedVersionId: listing.generatedVersionId,
      storeId: '22222222-2222-4222-8222-222222222222', storeAlias: 'sample-store', storeDisplayName: '测试店铺',
      status: 'SUCCEEDED', source: 'MANUAL', revision: 1, draftVersion: listing.draftVersion,
      presetDefinitionHash: `sha256:${'a'.repeat(64)}`, planHash: `sha256:${'b'.repeat(64)}`,
      configSnapshot: { draftVersion: listing.draftVersion }, nmIds: [], productUrls: [], result: {}, rowVersion: 1,
      createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z'
    }], total: 1 }) }));
    await page.goto('/listing/wb?view=manual');

    const row = page.locator('.wb-manual-table .ant-table-tbody tr').filter({ hasText: listing.sku });
    const skuCopy = copyButton(row, 'SKU', listing.sku);
    await skuCopy.hover();
    await expect(page.getByRole('tooltip')).toHaveText('复制SKU');
    await expectCopied(page, skuCopy, listing.sku);
  });

  test('投递历史每条产品身份的 SKU 支持悬停提示和复制', async ({ page }) => {
    const record = {
      submissionId: 'history-copy-sku', pendingSubmissionId: 'pending-copy-sku', taskId: 'task-copy-sku',
      sourceStageId: 'E004', targetStageId: 'WB_SHARED_MEDIA', sourceFolder: 'C:\\source\\0000019',
      selectedImageCount: 1, productSku: '0000019', productNameSnapshot: '投递历史复制测试',
      status: 'SUCCESS', createdAt: new Date().toISOString(), completedAt: new Date().toISOString()
    };
    await page.route('**/api/v1/submissions/history*', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [record] }) }));
    await page.goto('/history');

    const row = page.locator('.ant-table-tbody tr').filter({ hasText: record.submissionId });
    const skuCopy = copyButton(row, 'SKU', record.productSku);
    await skuCopy.hover();
    await expect(page.getByRole('tooltip')).toHaveText('复制SKU');
    await expectCopied(page, skuCopy, record.productSku);
  });

  test('运费计算中的最低运费和渠道报价互不串值并支持键盘复制', async ({ page }) => {
    await page.goto('/shipping');
    const calculateButton = page.getByRole('button', { name: '计算全部渠道' });
    await expect(calculateButton).toBeEnabled();
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/v1/shipping/calculate') && response.request().method() === 'POST');
    await calculateButton.click();
    const result = await (await responsePromise).json();
    expect(result.summary.cheapestFreightAmount).toBeTruthy();
    expect(result.quotes.length).toBeGreaterThan(0);

    const minimumCopy = copyButton(page, `最低运费 ${result.summary.currency}`, result.summary.cheapestFreightAmount);
    await expectCopied(page, minimumCopy, result.summary.cheapestFreightAmount);
    const firstQuote = result.quotes[0];
    const quoteCard = page.locator('.shipping-quote-card').first();
    const quoteCopy = copyButton(quoteCard, `预计运费 ${firstQuote.currency}`, firstQuote.freightAmount);
    await quoteCopy.focus();
    await page.keyboard.press('Enter');
    await expect(quoteCopy).toHaveClass(/is-copied/);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(firstQuote.freightAmount);
    await expect(minimumCopy).not.toHaveClass(/is-copied/);
  });
});

async function expectCopied(page: Page, button: Locator, value: string) {
  await button.click();
  await expect(button).toHaveClass(/is-copied/);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(value);
}

function copyButton(container: Page | Locator, label: string, value: string) {
  return container.getByRole('button', { name: new RegExp(`${escapeRegExp(label)}.*${escapeRegExp(value)}`) });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
