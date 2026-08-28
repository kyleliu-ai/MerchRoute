import { expect, test } from '@playwright/test';

test('采购产品规格分两行录入、允许独立留空并在列表和详情展示', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/purchases/url-download');
  await page.getByRole('button', { name: '新建采购产品' }).click();

  const drawer = page.getByRole('dialog', { name: '新建采购产品' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByLabel('运输方式')).toHaveCount(0);
  await expect(drawer.getByText('水桶包示例：高 30 × 深 15 × 宽 39 cm；净重 550 g')).toBeVisible();
  await expect(drawer.getByLabel('净重 (g)')).toHaveValue('');
  await expect(drawer.getByLabel('产品高度 (cm)')).toHaveValue('');
  await expect(drawer.getByLabel('产品深度 (cm)')).toHaveValue('');
  await expect(drawer.getByLabel('产品宽度 (cm)')).toHaveValue('');
  await expect(drawer.getByLabel('包装长度 (cm)')).toHaveValue('30');
  await expect(drawer.getByLabel('包装宽度 (cm)')).toHaveValue('15');
  await expect(drawer.getByLabel('包装高度 (cm)')).toHaveValue('10');

  const productName = `E2E-水桶包规格-${Date.now()}`;
  await drawer.getByLabel('产品名称').fill(productName);
  await drawer.getByLabel('采购价').fill('29.8');
  await drawer.getByLabel('产品 URL').fill(`https://mobile.yangkeduo.com/goods.html?goods_id=${Date.now()}`);
  await drawer.getByLabel('产品高度 (cm)').fill('30');
  await drawer.getByRole('button', { name: '保存采购信息' }).click();
  await expect(drawer).toBeHidden();

  const row = page.getByRole('row').filter({ hasText: productName });
  await expect(row).toContainText('产品：高 30 cm');
  await row.getByRole('button', { name: '编辑' }).click();
  const editDrawer = page.getByRole('dialog', { name: /编辑采购产品/ });
  await expect(editDrawer.getByLabel('产品高度 (cm)')).toHaveValue('30.000');
  await expect(editDrawer.getByLabel('产品深度 (cm)')).toHaveValue('');
  await editDrawer.getByLabel('净重 (g)').fill('550');
  await editDrawer.getByLabel('产品深度 (cm)').fill('15');
  await editDrawer.getByLabel('产品宽度 (cm)').fill('39');
  await editDrawer.getByRole('button', { name: '保存采购信息' }).click();
  await expect(editDrawer).toBeHidden();

  await expect(row).toContainText('产品：高 30 × 深 15 × 宽 39 cm · 净重 550 g');
  await expect(row).toContainText('包装：长 30 × 宽 15 × 高 10 cm');
  await row.getByRole('button', { name: '详情' }).click();

  const detail = page.getByRole('dialog', { name: /采购详情/ });
  await expect(detail).toContainText('产品：高 30 × 深 15 × 宽 39 cm · 净重 550 g');
  await expect(detail).toContainText('包装：长 30 × 宽 15 × 高 10 cm');
  await expect(detail.getByText('运输方式')).toHaveCount(0);
});
