import { expect, test, type Page, type Request } from '@playwright/test';

const reviewStageIds = ['E000', 'E001', 'E002', 'E003', 'E004', 'E005', 'E006', 'E007'] as const;

function productTask(stageId: string) {
  return {
    taskId: `${stageId.toLocaleLowerCase()}-open-folder`,
    stageId,
    sourceFolder: `C:\\MerchRoute\\${stageId}\\0000167-中文 产品`,
    sourceFolderName: `0000167-${stageId}-中文 产品`,
    imageCount: 3,
    videoCount: 0,
    mediaCount: 3,
    subfolderCount: 1,
    lastModifiedAt: '2026-09-02T07:00:00.000Z',
    status: 'PENDING_REVIEW',
    representativeImages: [],
    representativeMedia: []
  };
}

async function mockTaskList(page: Page, stageId: string): Promise<ReturnType<typeof productTask>> {
  const task = productTask(stageId);
  await page.route(new RegExp(`/api/v1/stages/${stageId}/tasks\\?`), (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [task], total: 1, page: 1, pageSize: 24 })
  }));
  return task;
}

test.describe('review product folder opening', () => {
  for (const stageId of reviewStageIds) {
    test(`${stageId} opens the product folder without navigating to review`, async ({ page }) => {
      const task = await mockTaskList(page, stageId);
      let request: Request | undefined;
      await page.route(`**/api/v1/tasks/${task.taskId}/open-folder`, (route) => {
        request = route.request();
        return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ accepted: true }) });
      });

      await page.goto(`/review/${stageId}`);
      const row = page.locator('.task-table .ant-table-tbody tr').filter({ hasText: task.sourceFolderName });
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: `打开产品文件夹 ${task.sourceFolderName}` }).click();

      await expect.poll(() => request?.method()).toBe('POST');
      expect(request?.postDataJSON()).toEqual({});
      await expect(page).toHaveURL(new RegExp(`/review/${stageId}$`));
      await expect(page.getByText('正在打开产品文件夹')).toBeVisible();
      await expect(row.getByRole('link', { name: '进入审核' })).toHaveAttribute('href', `/task/${task.taskId}`);
    });
  }

  test('card view uses the same folder action and keeps its review entry', async ({ page }) => {
    const task = await mockTaskList(page, 'E001');
    let request: Request | undefined;
    await page.route(`**/api/v1/tasks/${task.taskId}/open-folder`, (route) => {
      request = route.request();
      return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ accepted: true }) });
    });

    await page.goto('/review/E001');
    await page.locator('.ant-radio-button-wrapper').filter({ hasText: '卡片' }).click();
    const card = page.locator('.product-card').filter({ hasText: task.sourceFolderName });
    await card.getByRole('button', { name: `打开产品文件夹 ${task.sourceFolderName}` }).click();

    await expect.poll(() => request?.method()).toBe('POST');
    await expect(page).toHaveURL(/\/review\/E001$/);
    await expect(card.getByRole('link', { name: '进入审核' })).toHaveAttribute('href', `/task/${task.taskId}`);
    await card.getByRole('link', { name: '进入审核' }).click();
    await expect(page).toHaveURL(new RegExp(`/task/${task.taskId}$`));
  });

  test('open-folder errors remain on the list and show a readable message', async ({ page }) => {
    const task = await mockTaskList(page, 'E002');
    await page.route(`**/api/v1/tasks/${task.taskId}/open-folder`, (route) => route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'SOURCE_FOLDER_MISSING', message: '产品任务不存在或已被移动' } })
    }));

    await page.goto('/review/E002');
    await page.getByRole('button', { name: `打开产品文件夹 ${task.sourceFolderName}` }).click();

    await expect(page.getByText('产品任务不存在或已被移动')).toBeVisible();
    await expect(page).toHaveURL(/\/review\/E002$/);
  });
});
