import { expect, test, type Page } from '@playwright/test';

const wbNotifications = [
  {
    id: 'wb-success', category: 'WB_LISTING', eventType: 'WB_LISTING_SUCCEEDED', severity: 'SUCCESS',
    title: 'WB 上品完成', message: 'SKU 0000030 已完成商品卡、媒体、价格、折扣和库存同步。',
    sourceType: 'WB_LISTING', sourceId: 'task-0000030', sku: '0000030',
    details: { sku: '0000030', status: 'SUCCEEDED', source: 'MANUAL', taskId: 'task-0000030', nmIds: [1280000030] },
    createdAt: '2026-07-20T02:00:00.000Z', updatedAt: '2026-07-20T02:00:00.000Z'
  },
  {
    id: 'wb-failed', category: 'WB_LISTING', eventType: 'WB_AUTO_PUBLISH_FAILED', severity: 'ERROR',
    title: 'WB 自动上品失败', message: 'SKU 0000031 缺少完整的 E005 图片投递，需要人工处理。',
    sourceType: 'WB_AUTO_PUBLISH_JOB', sourceId: '0000031', sku: '0000031',
    details: { sku: '0000031', status: 'NEEDS_ATTENTION', source: 'AUTOMATION', errorCode: 'MEDIA_NOT_READY' },
    createdAt: '2026-07-20T02:01:00.000Z', updatedAt: '2026-07-20T02:01:00.000Z'
  }
];

type NotificationSummary = { unreadCount: number; unresolvedErrorCount: number };

async function mockNotifications(page: Page, queries: string[] = [], patched: string[] = [], summary: NotificationSummary | (() => NotificationSummary) = { unreadCount: 2, unresolvedErrorCount: 1 }): Promise<void> {
  await page.route('**/api/v1/notifications**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/notifications/summary') {
      await route.fulfill({ json: typeof summary === 'function' ? summary() : summary });
      return;
    }
    if (url.pathname === '/api/v1/notifications' && request.method() === 'GET') {
      queries.push(url.search);
      await route.fulfill({ json: { items: wbNotifications, total: 2, page: 1, pageSize: 20 } });
      return;
    }
    if (request.method() === 'PATCH') {
      patched.push(url.pathname);
      const notification = wbNotifications.find((item) => url.pathname.endsWith(item.id)) || wbNotifications[0];
      await route.fulfill({ json: { notification: { ...notification, readAt: '2026-07-20T02:02:00.000Z' } } });
      return;
    }
    await route.fallback();
  });
}

test.describe('消息中心统一展示 WB 上品消息', () => {
  test('非消息中心页面不显示新增失败右上角弹窗', async ({ page }) => {
    let summaryCalls = 0;
    await mockNotifications(page, [], [], () => {
      summaryCalls += 1;
      return { unreadCount: 2, unresolvedErrorCount: summaryCalls === 1 ? 0 : 1 };
    });

    await page.goto('/purchases/url-download');

    await expect(page.getByRole('heading', { name: '产品URL下载' })).toBeVisible();
    await expect.poll(() => summaryCalls, { timeout: 8000 }).toBeGreaterThanOrEqual(2);
    await expect(page.locator('.ant-notification-notice').filter({ hasText: '任务失败' })).toHaveCount(0);
    await expect(page.getByText('消息中心收到新的失败消息，请打开通知栏查看详情。')).toHaveCount(0);
  });

  test('展示成功和失败标签，并支持 WB 来源与事件筛选', async ({ page }) => {
    const queries: string[] = [];
    await mockNotifications(page, queries);
    await page.goto('/notifications');

    await expect(page.getByRole('heading', { name: '消息中心' })).toBeVisible();
    await expect(page.getByText('集中查看下载与 WB 上品结果，优先处理失败任务并跟踪业务状态。')).toBeVisible();
    await expect(page.getByText('WB 上品完成', { exact: true })).toBeVisible();
    await expect(page.getByText('WB 自动上品失败', { exact: true })).toBeVisible();
    await expect(page.locator('.notification-center-card').getByText('上品完成', { exact: true })).toBeVisible();
    await expect(page.locator('.notification-center-card').getByText('自动上品失败', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '查看WB上品' })).toHaveCount(2);

    const filters = page.locator('.notification-focus-card .ant-select');
    await filters.nth(2).click();
    const sourcePopup = page.locator('.ant-select-dropdown:visible');
    await expect(sourcePopup.getByText('WB上品', { exact: true })).toBeVisible();
    await expect(sourcePopup.getByText('WB自动上品', { exact: true })).toBeVisible();
    await sourcePopup.getByText('WB上品', { exact: true }).click();
    await expect.poll(() => queries.some((query) => new URLSearchParams(query).get('sourceType') === 'WB_LISTING')).toBe(true);

    await filters.nth(3).click();
    const eventPopup = page.locator('.ant-select-dropdown:visible');
    await expect(eventPopup.getByText('WB上品完成', { exact: true })).toBeVisible();
    await expect(eventPopup.getByText('WB上品失败', { exact: true })).toBeVisible();
    await expect(eventPopup.getByText('WB自动上品失败', { exact: true })).toBeVisible();
    await eventPopup.getByText('WB上品失败', { exact: true }).click();
    await expect.poll(() => queries.some((query) => new URLSearchParams(query).get('eventType') === 'WB_LISTING_FAILED')).toBe(true);

    await page.getByRole('button', { name: '查看WB上品' }).first().click();
    await expect(page).toHaveURL(/\/listing\/wb$/);
  });

  test('通知抽屉点击 WB 消息后标记已读并跳转 WB 上品页', async ({ page }) => {
    const patched: string[] = [];
    await mockNotifications(page, [], patched);
    await page.goto('/notifications');
    await page.getByRole('button', { name: '打开消息通知中心' }).click();

    const drawer = page.locator('.notification-drawer');
    await expect(drawer.getByText('WB 上品完成', { exact: true })).toBeVisible();
    await expect(drawer.getByText('WB上品', { exact: true }).first()).toBeVisible();
    await drawer.getByText('WB 上品完成', { exact: true }).click();

    await expect(page).toHaveURL(/\/listing\/wb$/);
    await expect.poll(() => patched).toContain('/api/v1/notifications/wb-success');
  });
});
