import { expect, test } from '@playwright/test';

test('新建采购产品时拦截已录入 URL 并显示原 SKU', async ({ page }) => {
  await page.goto('/purchases/url-download');
  const before = await page.request.get('/api/v1/purchases?page=1&pageSize=100');
  const beforeBody = await before.json();

  await page.getByRole('button', { name: '新建采购产品' }).click();
  const drawer = page.getByRole('dialog', { name: '新建采购产品' });
  await drawer.getByLabel('产品名称').fill('重复 URL 测试产品');
  await drawer.getByLabel('采购价').fill('10');
  await drawer.getByLabel('产品 URL').fill('https://mobile.yangkeduo.com/goods.html?goods_id=910000000000001');
  await drawer.getByRole('button', { name: '保存采购信息' }).click();

  await expect(drawer.getByText('产品已经录入', { exact: true })).toBeVisible();
  await expect(drawer.getByText('0000001', { exact: true })).toBeVisible();
  await expect(drawer).toBeVisible();

  const after = await page.request.get('/api/v1/purchases?page=1&pageSize=100');
  const afterBody = await after.json();
  expect(afterBody.total).toBe(beforeBody.total);
});
