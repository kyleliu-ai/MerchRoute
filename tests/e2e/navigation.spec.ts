import { expect, test } from '@playwright/test';

test.describe('左侧业务导航', () => {
  test('按业务分组展示菜单并保持路由归属', async ({ page }) => {
    await page.goto('/');

    const navigation = page.locator('.app-sider .primary-navigation');
    const topLevelItems = navigation.locator(':scope > li');
    await expect(topLevelItems).toHaveCount(7);
    expect(await navigation.evaluate((element) => [...element.children].map((item) => {
      const title = item.classList.contains('ant-menu-submenu')
        ? item.querySelector(':scope > .ant-menu-submenu-title .ant-menu-title-content')
        : item.querySelector(':scope > .ant-menu-title-content');
      return title?.textContent?.trim();
    }))).toEqual(['采购管理', '图片审核与投递', '上品管理', '售价管理', '运费管理', '系统设置', '消息中心']);

    const reviewGroup = navigation.locator(':scope > .ant-menu-submenu').filter({ hasText: '图片审核与投递' });
    await expect(reviewGroup).toHaveClass(/ant-menu-submenu-open/);
    await expect(reviewGroup).toHaveClass(/ant-menu-submenu-selected/);
    await expect(reviewGroup.locator(':scope > .ant-menu-sub .ant-menu-item .ant-menu-title-content')).toHaveText(['审核工作台', '待投递清单', '投递历史']);
    await expect(reviewGroup.getByText('审核工作台', { exact: true }).locator('..')).toHaveClass(/ant-menu-item-selected/);

    await reviewGroup.getByText('待投递清单', { exact: true }).click();
    await expect(page).toHaveURL(/\/pending$/);
    await expect(reviewGroup.getByText('待投递清单', { exact: true }).locator('..')).toHaveClass(/ant-menu-item-selected/);

    const listingGroup = navigation.locator(':scope > .ant-menu-submenu').filter({ hasText: '上品管理' });
    await listingGroup.locator(':scope > .ant-menu-submenu-title').click();
    await expect(listingGroup).toHaveClass(/ant-menu-submenu-open/);
    await expect(listingGroup.locator(':scope > .ant-menu-sub .ant-menu-item .ant-menu-title-content')).toHaveText(['WB上品', 'OZON上品']);
    await listingGroup.getByText('WB上品', { exact: true }).click();
    await expect(page).toHaveURL(/\/listing\/wb$/);
    await expect(listingGroup.getByText('WB上品', { exact: true }).locator('..')).toHaveClass(/ant-menu-item-selected/);
    await listingGroup.getByText('OZON上品', { exact: true }).click();
    await expect(page).toHaveURL(/\/listing\/ozon$/);
    await expect(listingGroup.getByText('OZON上品', { exact: true }).locator('..')).toHaveClass(/ant-menu-item-selected/);

    const pricingGroup = navigation.locator(':scope > .ant-menu-submenu').filter({ hasText: '售价管理' });
    await pricingGroup.locator(':scope > .ant-menu-submenu-title').click();
    await expect(pricingGroup).toHaveClass(/ant-menu-submenu-open/);
    await expect(reviewGroup).not.toHaveClass(/ant-menu-submenu-open/);
    await expect(pricingGroup.locator(':scope > .ant-menu-sub .ant-menu-item .ant-menu-title-content')).toHaveText(['售价查询', '售价计算', '定价模板']);
    await pricingGroup.getByText('售价查询', { exact: true }).click();
    await expect(page).toHaveURL(/\/pricing\/query$/);
    await expect(pricingGroup.getByText('售价查询', { exact: true }).locator('..')).toHaveClass(/ant-menu-item-selected/);
    await pricingGroup.getByText('定价模板', { exact: true }).click();
    await expect(page).toHaveURL(/\/pricing\/templates$/);

    await page.reload();
    await expect(pricingGroup).toHaveClass(/ant-menu-submenu-open/);
    await expect(pricingGroup.getByText('定价模板', { exact: true }).locator('..')).toHaveClass(/ant-menu-item-selected/);

    const shippingGroup = navigation.locator(':scope > .ant-menu-submenu').filter({ hasText: '运费管理' });
    await shippingGroup.locator(':scope > .ant-menu-submenu-title').click();
    await expect(shippingGroup).toHaveClass(/ant-menu-submenu-open/);
    await expect(pricingGroup).not.toHaveClass(/ant-menu-submenu-open/);
    await expect(shippingGroup.locator(':scope > .ant-menu-sub .ant-menu-item .ant-menu-title-content')).toHaveText(['运费计算', '运费模板']);
  });

  test('折叠后使用中文悬浮菜单，并兼容 320px 视口', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '折叠侧边栏' }).click();
    await expect(page.locator('.app-sider')).toHaveClass(/ant-layout-sider-collapsed/);
    await expect(page.getByRole('button', { name: '展开侧边栏' })).toBeVisible();

    await page.locator('.app-sider .primary-navigation > .ant-menu-submenu').filter({ hasText: '图片审核与投递' }).locator(':scope > .ant-menu-submenu-title').hover();
    const popup = page.locator('.primary-navigation-popup:visible');
    await expect(popup.getByText('审核工作台', { exact: true })).toBeVisible();
    await expect(popup.getByText('待投递清单', { exact: true })).toBeVisible();
    await expect(popup.getByText('投递历史', { exact: true })).toBeVisible();

    await page.setViewportSize({ width: 320, height: 720 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
