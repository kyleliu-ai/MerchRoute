import { expect, test, type Page } from '@playwright/test';

const platforms = ['PDD', 'TAOBAO', '1688', 'AMAZON', 'OZON', 'WB', '新增平台'];
const folders = (platform: string, count: number) => Array.from({ length: count }, (_, index) => ({
  name: `商品${String(index + 1).padStart(2, '0')}`,
  relativePath: `${platform}/商品${String(index + 1).padStart(2, '0')}`,
  platform, hasChildren: true, childDirectoryCount: 1,
  createdAt: '2026-09-08T00:00:00.000Z', modifiedAt: '2026-09-08T00:00:00.000Z',
  importStatus: index === 0 ? 'IMPORTED' : 'NEW'
}));
const rootFolders = platforms.map((name) => ({ ...folders(name, 1)[0], name, relativePath: name }));

async function enterPlatform(page: Page, platform: string) {
  await page.locator('.local-directory-row.is-platform-root-row').filter({ has: page.getByRole('button', { name: platform, exact: true }) }).getByRole('button', { name: '导入产品媒体' }).click();
}

async function refreshDirectories(page: Page) {
  const response = page.waitForResponse((value) => value.url().includes('/local-import/directories?path=') && value.request().method() === 'GET');
  await page.getByRole('button', { name: /重试媒体复制/ }).click();
  await response;
}

for (const platform of platforms) {
  test(`${platform} paginates media directories without changing root entries or ordering`, async ({ page }) => {
    await page.route('**/api/v1/local-import/directories?*', (route) => {
      const path = new URL(route.request().url()).searchParams.get('path') || '';
      return route.fulfill({ json: { path, configHash: 'pagination-fixture', directories: path ? folders(path, 21) : rootFolders } });
    });
    await page.goto('/purchases/local-import');
    await expect(page.locator('.local-directory-row')).toHaveCount(7);
    await expect(page.getByLabel('媒体目录分页')).toHaveCount(0);
    await enterPlatform(page, platform);
    const rows = page.locator('.local-directory-row');
    const pager = page.getByLabel('媒体目录分页');
    await expect(rows).toHaveCount(10);
    await expect(rows.locator('.directory-name')).toHaveText(folders(platform, 10).map((item) => item.name));
    await expect(rows.first()).toContainText('已导入');
    await expect(pager).toContainText('共 21 条');
    await expect(pager.locator('.ant-select')).toHaveCount(0);
    await pager.locator('.ant-pagination-next').click();
    await expect(rows).toHaveCount(10);
    await expect(rows.first()).toContainText('商品11');
    await pager.locator('.ant-pagination-next').click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('商品21');
    await pager.locator('.ant-pagination-prev').click();
    await expect(rows.first()).toContainText('商品11');
    await page.setViewportSize({ width: 320, height: 760 });
    await expect(pager).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.getByRole('button', { name: '来源根目录', exact: true }).click();
    await enterPlatform(page, platform);
    await expect(rows.first()).toContainText('商品01');
    await expect(pager.locator('.ant-pagination-item-active')).toHaveText('1');
  });
}

test('directory refresh clamps and persists the last valid page, including empty lists', async ({ page }) => {
  let count = 21;
  const previewResponse = await page.request.post('/api/v1/local-import/preview', {
    data: { directories: ['PDD/E2E红色'], primaryDirectory: 'PDD/E2E红色' }
  });
  expect(previewResponse.ok()).toBeTruthy();
  const previewPayload = await previewResponse.json();
  await page.route('**/api/v1/local-import/preview', (route) => route.fulfill({ json: previewPayload }));
  // A retryable result exercises the same directory invalidation as a completed import,
  // without writing business data or changing the shared regression fixture.
  const retryable = { import: { id: 'pagination-retry', status: 'COPY_FAILED_RETRYABLE', errorMessage: '测试媒体复制失败' } };
  await page.route('**/api/v1/local-import/imports', (route) => route.fulfill({ json: retryable }));
  await page.route('**/api/v1/local-import/imports/pagination-retry/retry', (route) => route.fulfill({ json: retryable }));
  await page.route('**/api/v1/local-import/directories?*', (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') || '';
    return route.fulfill({ json: { path, configHash: 'pagination-fixture', directories: path ? folders(path, count) : rootFolders } });
  });
  await page.goto('/purchases/local-import');
  await enterPlatform(page, 'PDD');
  const pager = page.getByLabel('媒体目录分页');
  const rows = page.locator('.local-directory-row');
  await rows.first().getByRole('checkbox').check();
  await page.getByRole('button', { name: '预览并编辑' }).click();
  await page.getByLabel('产品名称').fill('分页刷新测试');
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试媒体复制', exact: true })).toBeVisible();
  await pager.getByTitle('3', { exact: true }).click();
  count = 11;
  await refreshDirectories(page);
  await expect(rows).toHaveCount(1);
  await expect(pager.locator('.ant-pagination-item-active')).toHaveText('2');
  count = 21;
  await refreshDirectories(page);
  await expect(pager.locator('.ant-pagination-item-active')).toHaveText('2');
  await expect(rows).toHaveCount(10);
  count = 10;
  await refreshDirectories(page);
  await expect(rows).toHaveCount(10);
  await expect(pager.locator('.ant-pagination-item-active')).toHaveText('1');
  await expect(pager.locator('.ant-pagination-next')).toHaveClass(/ant-pagination-disabled/);
  count = 0;
  await refreshDirectories(page);
  await expect(rows).toHaveCount(0);
  await expect(page.getByText('当前目录没有可选子目录')).toBeVisible();
  await expect(pager).toContainText('共 0 条');
});

test('cross-page selection retains the primary directory and edited preview', async ({ page }) => {
  const response = await page.request.get('/api/v1/local-import/directories?path=PDD');
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  const red = payload.directories.find((item: { name: string }) => item.name === 'E2E红色');
  const blue = payload.directories.find((item: { name: string }) => item.name === 'E2E蓝色');
  expect(red).toBeTruthy();
  expect(blue).toBeTruthy();
  await page.route('**/api/v1/local-import/directories?*', (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') || '';
    return route.fulfill({ json: { ...payload, path, directories: path === 'PDD' ? [red, ...folders('PDD', 9), blue] : path ? folders(path, 11) : rootFolders } });
  });
  await page.goto('/purchases/local-import');
  await enterPlatform(page, 'PDD');
  const pager = page.getByLabel('媒体目录分页');
  await page.getByRole('checkbox', { name: '选择 PDD/E2E红色', exact: true }).check();
  await pager.locator('.ant-pagination-next').click();
  await page.getByRole('checkbox', { name: '选择 PDD/E2E蓝色', exact: true }).check();
  await expect(page.getByText('已选 2 个目录')).toBeVisible();
  await expect(page.locator('.primary-directory .ant-select-selection-item')).toHaveText('PDD/E2E红色');
  await page.getByRole('button', { name: '预览并编辑' }).click();
  await expect(page.locator('.local-source-summary')).toContainText('E2E红色');
  await expect(page.locator('.local-source-summary')).toContainText('E2E蓝色');
  await page.getByLabel('产品名称').fill('分页预览保留');
  await pager.locator('.ant-pagination-prev').click();
  await expect(page.getByRole('checkbox', { name: '选择 PDD/E2E红色', exact: true })).toBeChecked();
  await expect(page.getByLabel('产品名称')).toHaveValue('分页预览保留');
  await page.getByRole('checkbox', { name: '选择 PDD/E2E红色', exact: true }).uncheck();
  await expect(page.getByText('已选 1 个目录')).toBeVisible();
  await expect(page.locator('.primary-directory .ant-select-selection-item')).toHaveText('PDD/E2E蓝色');
  await pager.locator('.ant-pagination-next').click();
  await expect(page.getByRole('checkbox', { name: '选择 PDD/E2E蓝色', exact: true })).toBeChecked();
  await page.getByRole('button', { name: '来源根目录', exact: true }).click();
  await enterPlatform(page, 'WB');
  await page.getByRole('checkbox', { name: '选择 WB/商品01', exact: true }).click();
  await expect(page.getByText('一次导入只能选择同一平台的媒体目录')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '选择 WB/商品01', exact: true })).not.toBeChecked();
  await expect(page.getByText('已选 1 个目录')).toBeVisible();
});
