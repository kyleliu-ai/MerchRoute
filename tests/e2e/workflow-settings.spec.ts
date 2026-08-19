import { expect, test } from '@playwright/test';

test.describe.serial('dynamic workflow settings', () => {
  test('shows grouped aliases and gives E007 the same configuration surfaces as E006', async ({ page }) => {
    await page.goto('/settings');
    const navigation = page.getByLabel('工作流设置菜单');
    for (const group of ['下载组', '抠图组', '生图组', '视频组', 'LOGO组']) await expect(navigation.getByText(group, { exact: true })).toBeVisible();
    await expect(navigation.getByText('PDD下载-E006', { exact: true })).toBeVisible();
    await expect(navigation.getByText('1688下载-E007', { exact: true })).toBeVisible();
    await navigation.locator('.workflow-settings-item').filter({ hasText: 'E007' }).click();
    await expect(page.getByRole('tab', { name: '图片审核与投递' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '工作流参数' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '下载调用' })).toBeVisible();
    await page.getByRole('tab', { name: '下载调用' }).click();
    await expect(page.getByLabel('Webhook 完整地址')).toHaveValue('http://localhost:5678/webhook/1688-product-media-download');
  });

  test('shows system maintenance only with review and delivery settings', async ({ page }) => {
    await page.goto('/settings');
    const maintenance = page.locator('.system-maintenance-card');
    await expect(maintenance).toBeVisible();
    await expect(maintenance.getByRole('button', { name: '保存全局设置' })).toBeVisible();

    await page.getByRole('tab', { name: '工作流参数' }).click();
    await expect(maintenance).toHaveCount(0);

    const navigation = page.getByLabel('工作流设置菜单');
    await navigation.locator('.workflow-settings-item').filter({ hasText: 'E007' }).click();
    await page.getByRole('tab', { name: '下载调用' }).click();
    await expect(maintenance).toHaveCount(0);

    await page.getByRole('tab', { name: '图片审核与投递' }).click();
    await expect(maintenance).toBeVisible();
  });

  test('hides maintenance on direct download entry and falls back for non-download workflows', async ({ page }) => {
    await page.goto('/settings/download-workflows');
    await expect(page.getByRole('tab', { name: '下载调用' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.system-maintenance-card')).toHaveCount(0);

    await page.getByLabel('工作流设置菜单').locator('.workflow-settings-item').filter({ hasText: 'E001' }).click();
    await expect(page.getByRole('tab', { name: '图片审核与投递' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.system-maintenance-card')).toBeVisible();
  });

  test('renders v002 settings when an older response omits downloadSync', async ({ page }) => {
    await page.route('**/api/v1/config', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      delete body.downloadSync;
      await route.fulfill({ response, json: body });
    });
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: '系统设置' })).toBeVisible();
    await expect(page.getByLabel('工作流设置菜单')).toBeVisible();
  });

  test('shows a recoverable warning instead of crashing against a stale v001 backend', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.route('**/api/v1/config', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.config.version = 'v001';
      delete body.config.workflowGroups;
      body.config.stages = body.config.stages.map(({ alias: _alias, groupId: _groupId, download: _download, ...stage }: Record<string, unknown>) => stage);
      delete body.downloadSync;
      await route.fulfill({ response, json: body });
    });
    await page.goto('/settings');
    await expect(page.getByText('前后端版本不一致', { exact: true })).toBeVisible();
    await expect(page.getByText(/当前后端仍为 v001/)).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test('creates, edits, groups and safely deletes a workflow from the UI', async ({ page }) => {
    await page.goto('/settings');
    await page.locator('.page-title').getByRole('button', { name: '新建工作流' }).click();
    const createDrawer = page.locator('.ant-drawer').filter({ hasText: '新建工作流' });
    await createDrawer.getByLabel('工作流编号').fill('E008');
    await createDrawer.getByLabel('显示别名').fill('淘宝下载');
    await createDrawer.getByLabel('完整名称').fill('淘宝商品媒体下载');
    await createDrawer.getByLabel('n8n 工作流名称').fill('E008-淘宝商品媒体下载');
    await createDrawer.getByLabel('功能说明').fill('动态工作流端到端测试');
    await createDrawer.getByText('下载组', { exact: true }).click();
    await page.locator('.ant-select-dropdown:visible').getByText('生图组', { exact: true }).click();
    await createDrawer.getByRole('button', { name: '创建工作流' }).click();
    await expect(page.getByText('淘宝下载-E008 已创建')).toBeVisible();
    await expect(page.locator('.workflow-settings-item.is-active')).toContainText('淘宝下载-E008');

    await page.locator('.workflow-settings-detail').getByLabel('显示别名').fill('淘宝下载新版');
    await page.getByRole('button', { name: '保存工作流' }).click();
    await expect(page.getByText('淘宝下载新版-E008 已保存')).toBeVisible();
    await expect(page.locator('.workflow-settings-item.is-active')).toContainText('淘宝下载新版-E008');

    await page.locator('.page-title').getByRole('button', { name: '管理分组' }).click();
    const groupDrawer = page.locator('.ant-drawer:visible').filter({ hasText: '管理工作流分组' });
    await groupDrawer.getByRole('button', { name: '添加分组' }).click();
    await groupDrawer.getByLabel('分组名称 6').fill('测试组');
    const e008Group = groupDrawer.getByRole('combobox', { name: 'E008 所属分组' });
    await e008Group.press('Enter');
    await e008Group.press('End');
    await e008Group.press('Enter');
    await groupDrawer.getByRole('button', { name: '保存分组' }).click();
    await expect(page.getByText('工作流分组已保存')).toBeVisible();
    await expect(page.getByLabel('工作流设置菜单').getByText('测试组', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: '删除工作流' }).click();
    await page.getByRole('button', { name: '检查并删除' }).click();
    await expect(page.getByText('工作流 E008 配置已删除，参数文件已归档')).toBeVisible();
    await expect(page.getByLabel('工作流设置菜单').getByText('淘宝下载新版-E008', { exact: true })).toHaveCount(0);
  });

  test('keeps the grouped settings usable at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 760 });
    await page.goto('/settings');
    await expect(page.getByLabel('工作流设置菜单')).toBeHidden();
    const mobilePicker = page.locator('.workflow-settings-mobile-picker');
    await expect(mobilePicker.getByRole('combobox', { name: '移动端工作流选择' })).toBeVisible();
    await mobilePicker.locator('.ant-select').click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '套图-E003' }).click();
    await expect(page.getByRole('tab', { name: '工作流参数' })).toBeVisible();
    await page.getByRole('tab', { name: '工作流参数' }).click();
    await expect(page.locator('.system-maintenance-card')).toHaveCount(0);
    expect(await page.locator('.workflow-settings-shell').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  });

  test('keeps WB media templates read-only and links the E004 and E005 OZON template draft', async ({ page }) => {
    await page.goto('/settings');
    await page.locator('.workflow-settings-item').filter({ hasText: 'E004' }).click();
    const e004 = page.getByLabel('E004 WB 共享媒体输出目录模板');
    await expect(e004).toHaveAttribute('readonly');
    await expect(page.getByText('WB上品设置', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '打开设置' })).toHaveAttribute('href', '/listing/wb?settings=1');
    const wbTemplate = await e004.inputValue();

    await page.locator('.workflow-settings-item').filter({ hasText: 'E005' }).click();
    const e005 = page.getByLabel('E005 WB 共享媒体输出目录模板');
    await expect(e005).toHaveAttribute('readonly');
    await expect(e005).toHaveValue(wbTemplate);

    await page.getByLabel('E005 OZON 共享媒体输出目录模板').fill('C:\\e2e-ozon-root\\inbox\\SKU\\variants');
    await expect(page.getByText('目录模板必须包含且只能包含一个 <SKU>')).toBeVisible();

    const ozonTemplate = 'G:\\01_MerchRoute\\OZON-Auto-Publish\\inbox\\<SKU>\\variants';
    await page.getByLabel('E005 OZON 共享媒体输出目录模板').fill(ozonTemplate);
    await expect(page.getByText(`示例 SKU 解析结果：${ozonTemplate.replace('<SKU>', '0000001')}`)).toBeVisible();
    await page.locator('.workflow-settings-item').filter({ hasText: 'E004' }).click();
    await expect(page.getByLabel('E004 OZON 共享媒体输出目录模板')).toHaveValue(ozonTemplate);
  });
});
