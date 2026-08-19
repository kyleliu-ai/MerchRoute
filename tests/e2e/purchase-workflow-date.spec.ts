import { expect, test } from '@playwright/test';

test('采购产品根据 URL 自动切换并锁定工作流，批量下载仍可二次选择', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/purchases');
  await expect(page.getByRole('heading', { name: '采购管理' })).toBeVisible();

  await page.getByRole('button', { name: '新建采购产品' }).click();
  const drawer = page.getByRole('dialog', { name: '新建采购产品' });
  await expect(drawer).toBeVisible();
  const workflowInput = drawer.getByRole('combobox', { name: '本次下载工作流' });
  const workflowField = workflowInput.locator('xpath=ancestor::div[contains(@class,"ant-form-item")][1]');
  await expect(workflowInput).toBeDisabled();
  await expect(workflowField).toContainText('粘贴产品 URL 后自动选择');
  await expect(workflowField.locator('.ant-select-selection-item')).toHaveCount(0);

  const productName = `E2E-工作流偏好-${Date.now()}`;
  const pddUrl = `https://mobile.yangkeduo.com/goods.html?goods_id=${Date.now()}01`;
  const url1688 = `https://detail.1688.com/offer/${Date.now()}02.html`;
  await drawer.getByLabel('产品名称').fill(productName);
  await drawer.getByLabel('采购价').fill('19.8');
  await drawer.getByLabel('产品 URL').fill(pddUrl);
  await expect(workflowField).toContainText('PDD下载-E006 · 拼多多商品媒体下载');
  await drawer.getByLabel('产品 URL').fill(url1688);
  await expect(workflowField).toContainText('1688下载-E007 · 1688产品媒体下载');
  await drawer.getByLabel('产品 URL').fill(pddUrl);
  await expect(workflowField).toContainText('PDD下载-E006 · 拼多多商品媒体下载');
  await drawer.getByLabel('产品 URL').fill(url1688);
  await expect(workflowField).toContainText('1688下载-E007 · 1688产品媒体下载');
  await drawer.getByRole('button', { name: '保存采购信息' }).click();
  await expect(drawer).toBeHidden();

  const row = page.getByRole('row').filter({ hasText: productName });
  await expect(row).toBeVisible();
  await expect(row.getByText('E007', { exact: true })).toBeVisible();
  await row.getByRole('checkbox').check();
  await expect(row.locator('.ant-select-selection-item').filter({ hasText: /1688下载-E007/ })).toBeVisible();

  await row.locator('.ant-select-selector').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'PDD下载-E006' }).click();
  await expect(row.locator('.ant-select-selection-item').filter({ hasText: /PDD下载-E006/ })).toBeVisible();
  await row.getByRole('checkbox').uncheck();
  await row.getByRole('checkbox').check();
  await expect(row.locator('.ant-select-selection-item').filter({ hasText: /1688下载-E007/ })).toBeVisible();
  await row.getByRole('checkbox').uncheck();

  const dateSelector = page.locator('.filter-bar .ant-select-selector').first();
  const todayRequest = page.waitForRequest((request) => request.url().includes('/api/v1/purchases?') && new URL(request.url()).searchParams.has('createdFrom'));
  await dateSelector.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '当天' }).click();
  const todayParams = new URL((await todayRequest).url()).searchParams;
  expect(Date.parse(todayParams.get('createdTo')!) - Date.parse(todayParams.get('createdFrom')!)).toBe(24 * 60 * 60 * 1000);
  await expect(page.getByRole('row').filter({ hasText: productName })).toBeVisible();

  const yesterdayRequest = page.waitForRequest((request) => request.url().includes('/api/v1/purchases?') && new URL(request.url()).searchParams.has('createdFrom'));
  await dateSelector.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '昨天' }).click();
  const yesterdayParams = new URL((await yesterdayRequest).url()).searchParams;
  expect(Date.parse(yesterdayParams.get('createdTo')!) - Date.parse(yesterdayParams.get('createdFrom')!)).toBe(24 * 60 * 60 * 1000);
  await expect(page.getByRole('row').filter({ hasText: productName })).toHaveCount(0);

  const sevenDaysRequest = page.waitForRequest((request) => request.url().includes('/api/v1/purchases?') && new URL(request.url()).searchParams.has('createdFrom'));
  await dateSelector.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '近 7 天' }).click();
  const sevenDaysParams = new URL((await sevenDaysRequest).url()).searchParams;
  expect(Date.parse(sevenDaysParams.get('createdTo')!) - Date.parse(sevenDaysParams.get('createdFrom')!)).toBe(7 * 24 * 60 * 60 * 1000);

  await dateSelector.click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '时间段查询' }).click();
  await expect(page.getByPlaceholder('开始日期')).toBeVisible();
  await expect(page.getByPlaceholder('结束日期')).toBeVisible();

  await page.locator('.filter-bar .ant-btn').filter({ hasText: /重\s*置/ }).click();
  await expect(dateSelector).toContainText('全部日期');
  await expect(page.getByPlaceholder('开始日期')).toHaveCount(0);
});

test('空值、语法错误和不支持的 URL 给出对应提示且不发送保存请求', async ({ page }) => {
  await page.goto('/purchases');
  let createRequests = 0;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname === '/api/v1/purchases') createRequests += 1;
  });

  await page.getByRole('button', { name: '新建采购产品' }).click();
  const drawer = page.getByRole('dialog', { name: '新建采购产品' });
  const workflowInput = drawer.getByRole('combobox', { name: '本次下载工作流' });
  const workflowField = workflowInput.locator('xpath=ancestor::div[contains(@class,"ant-form-item")][1]');
  const providerUrl = drawer.getByLabel('产品 URL');
  await drawer.getByLabel('产品名称').fill(`E2E-不支持URL-${Date.now()}`);
  await drawer.getByLabel('采购价').fill('9.9');

  await drawer.getByRole('button', { name: '保存采购信息' }).click();
  await expect(drawer.getByText('请输入产品 URL', { exact: true })).toBeVisible();
  await providerUrl.fill('not-a-url');
  await expect(drawer.getByText('请输入有效 URL', { exact: true })).toBeVisible();

  await providerUrl.fill(`https://mobile.yangkeduo.com/goods.html?goods_id=${Date.now()}03`);
  await expect(workflowField).toContainText('PDD下载-E006 · 拼多多商品媒体下载');
  await providerUrl.fill('https://mobile.yangkeduo.com/goods.html');
  await expect(drawer.getByText('无法下载', { exact: true })).toBeVisible();
  await expect(workflowField.locator('.ant-select-selection-item')).toHaveCount(0);

  await providerUrl.fill('https://item.taobao.com/item.htm?id=123456789');
  await expect(drawer.getByText('无法下载', { exact: true })).toBeVisible();
  await expect(workflowField.locator('.ant-select-selection-item')).toHaveCount(0);
  await drawer.getByRole('button', { name: '保存采购信息' }).click();
  await expect(drawer).toBeVisible();
  expect(createRequests).toBe(0);
});

test('编辑历史错配记录时按 URL 纠正，保存后创建新采购版本', async ({ page }) => {
  await page.goto('/purchases?query=E2E-历史错配工作流');
  const row = page.getByRole('row').filter({ hasText: 'E2E-历史错配工作流' });
  await expect(row).toContainText('E006');
  await row.getByRole('button', { name: '编辑' }).click();

  const drawer = page.getByRole('dialog', { name: /编辑采购产品/ });
  const workflowInput = drawer.getByRole('combobox', { name: '本次下载工作流' });
  const workflowField = workflowInput.locator('xpath=ancestor::div[contains(@class,"ant-form-item")][1]');
  await expect(workflowInput).toBeDisabled();
  await expect(workflowField).toContainText('1688下载-E007 · 1688产品媒体下载');
  await drawer.getByRole('button', { name: '保存采购信息' }).click();
  await expect(drawer).toBeHidden();
  await expect(row).toContainText('E007');

  await row.getByRole('button', { name: '详情' }).click();
  const detail = page.getByRole('dialog', { name: /采购详情/ });
  const latestVersion = detail.getByRole('row').filter({ hasText: 'V2' });
  await expect(latestVersion).toContainText('E007');
});
