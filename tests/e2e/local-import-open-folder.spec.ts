import { expect, test } from '@playwright/test';

for (const { platform, hasChildren, importStatus } of [
  { platform: 'PDD', hasChildren: false, importStatus: 'NEW' },
  { platform: 'WB', hasChildren: true, importStatus: 'IMPORTED' }
]) {
  test(`opens ${platform} variant names without changing selection or browser path`, async ({ page }) => {
    const name = '938669001556-R1 中文 & 空格';
    const relativePath = `${platform}/${name}`;
    const entry = { name, relativePath, platform, hasChildren, importStatus, childDirectoryCount: hasChildren ? 1 : 0, createdAt: '2026-09-08T00:00:00Z', modifiedAt: '2026-09-08T00:00:00Z' };
    await page.route('**/api/v1/local-import/directories?**', (route) => {
      const current = new URL(route.request().url()).searchParams.get('path') || '';
      return route.fulfill({ json: { path: current, configHash: 'source-config-hash', directories: current === '' ? [{ ...entry, name: platform, relativePath: platform, hasChildren: true }] : current === platform ? [entry] : [] } });
    });
    const requests: Array<{ method: string; body: unknown }> = [];
    let complete: (() => void) | undefined;
    await page.route('**/api/v1/local-import/directories/open-folder', async (route) => {
      requests.push({ method: route.request().method(), body: route.request().postDataJSON() });
      await new Promise<void>((resolve) => { complete = resolve; });
      await route.fulfill({ status: 202, json: { accepted: true } });
    });
    await page.goto('/purchases/local-import');
    await page.getByRole('button', { name: platform, exact: true }).click();
    const checkbox = page.getByRole('checkbox', { name: `选择 ${relativePath}` });
    await checkbox.check();
    const nameButton = page.getByRole('button', { name, exact: true });
    await nameButton.click();
    await expect(nameButton).toBeDisabled();
    await nameButton.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0]).toEqual({ method: 'POST', body: { relativePath, configHash: 'source-config-hash' } });
    complete!();
    await expect(page.getByText('正在打开变体目录')).toBeVisible();
    await expect(nameButton).toBeEnabled();
    await expect(checkbox).toBeChecked();
    await expect(page.getByText('已选 1 个目录')).toBeVisible();
    await expect(page.locator('.ant-breadcrumb')).toHaveText(`来源根目录/${platform}`);
    await expect(page).toHaveURL(/\/purchases\/local-import$/);
    if (hasChildren) {
      await page.locator('.local-directory-action').getByRole('button', { name: '打开', exact: true }).click();
      await expect(page.locator('.ant-breadcrumb')).toContainText(name);
      expect(requests).toHaveLength(1);
    }
  });
}

test('failed variant opening shows the server message without navigating or clearing selection', async ({ page }) => {
  const entry = { name: '失败目录', relativePath: 'PDD/失败目录', platform: 'PDD', hasChildren: false, childDirectoryCount: 0, createdAt: '2026-09-08T00:00:00Z', modifiedAt: '2026-09-08T00:00:00Z', importStatus: 'NEW' };
  await page.route('**/api/v1/local-import/directories?**', (route) => {
    const current = new URL(route.request().url()).searchParams.get('path') || '';
    return route.fulfill({ json: { path: current, configHash: 'config-hash', directories: current ? [entry] : [{ ...entry, name: 'PDD', relativePath: 'PDD', hasChildren: true }] } });
  });
  await page.route('**/api/v1/local-import/directories/open-folder', (route) => route.fulfill({ status: 409, json: { error: { code: 'LOCAL_IMPORT_CONFIG_CHANGED', message: '来源目录配置已变化，请刷新目录列表后重试' } } }));
  await page.goto('/purchases/local-import');
  await page.getByRole('button', { name: 'PDD', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 PDD/失败目录' }).check();
  await page.getByRole('button', { name: '失败目录', exact: true }).click();
  await expect(page.getByText('来源目录配置已变化，请刷新目录列表后重试')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '选择 PDD/失败目录' })).toBeChecked();
  await expect(page).toHaveURL(/\/purchases\/local-import$/);
  await expect(page.getByRole('button', { name: '失败目录', exact: true })).toBeEnabled();
});
