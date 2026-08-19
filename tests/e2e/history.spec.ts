import { expect, test } from '@playwright/test';
import type { SubmissionRecord } from '@n8n-media-review/shared';

const historyRecords: SubmissionRecord[] = [
  {
    submissionId: 'history-17-success', pendingSubmissionId: 'pending-17-success', taskId: 'task-17', sourceStageId: 'E006', targetStageId: 'E001',
    sourceFolder: 'C:\\source\\0000017运动鞋', targetFolder: 'C:\\target\\0000017运动鞋', archiveFolder: 'C:\\archive\\0000017运动鞋',
    selectedImageCount: 5, productSku: '0000017', productNameSnapshot: 'E2E运动鞋', variantName: '红色', status: 'SUCCESS',
    startedAt: '2026-07-19T08:00:00.000Z', completedAt: '2026-07-19T08:01:00.000Z'
  },
  {
    submissionId: 'history-17-failed', pendingSubmissionId: 'pending-17-failed', taskId: 'task-17', sourceStageId: 'E006', targetStageId: 'E002',
    sourceFolder: 'C:\\source\\0000017运动鞋', selectedImageCount: 2, productSku: '0000017', productNameSnapshot: 'E2E运动鞋', variantName: '蓝色',
    status: 'FAILED', errorCode: 'COPY_FAILED', errorMessage: '测试复制失败', startedAt: '2026-07-19T09:00:00.000Z', completedAt: '2026-07-19T09:01:00.000Z'
  },
  {
    submissionId: 'history-18-success', pendingSubmissionId: 'pending-18-success', taskId: 'task-18', sourceStageId: 'E006', targetStageId: 'E001',
    sourceFolder: 'C:\\source\\0000018休闲鞋', selectedImageCount: 4, productSku: '0000018', productNameSnapshot: 'E2E休闲鞋', status: 'SUCCESS',
    startedAt: '2026-07-19T10:00:00.000Z', completedAt: '2026-07-19T10:01:00.000Z'
  },
  {
    submissionId: 'history-legacy', pendingSubmissionId: 'pending-legacy', taskId: 'task-legacy', sourceStageId: 'E006', targetStageId: 'E001',
    sourceFolder: 'C:\\source\\旧记录', selectedImageCount: 1, status: 'SUCCESS', startedAt: '2026-07-18T08:00:00.000Z', completedAt: '2026-07-18T08:01:00.000Z'
  }
];

test('shows compact workflow shortcuts above history filters without changing the dashboard rail', async ({ page }) => {
  await page.route('**/api/v1/submissions/history*', async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ items: historyRecords })
  }));

  await page.goto('/history');
  const intro = page.locator('.workflow-navigation-intro');
  const shortcuts = page.locator('.history-workflow-shortcuts');
  const rail = shortcuts.getByRole('region', { name: '工作流导航' });
  await expect(intro.locator('.page-title + .history-workflow-shortcuts')).toBeVisible();
  await expect(page.locator('.workflow-navigation-intro + .history-filter-bar')).toBeVisible();
  await expect(shortcuts.getByRole('heading', { name: '工作流导航' })).toHaveCSS('font-size', '16px');
  await expect(shortcuts.getByText('WORKFLOW SHORTCUTS', { exact: true })).toHaveCount(0);
  await expect(shortcuts.getByText('点击进入对应审核页面', { exact: true })).toBeVisible();
  await expect(intro).toHaveCSS('gap', '10px');
  const historyTitleMetrics = await intro.getByRole('heading', { name: '投递历史', exact: true }).evaluate((element) => {
    const style = getComputedStyle(element);
    return { fontSize: Number.parseFloat(style.fontSize), lineHeight: Number.parseFloat(style.lineHeight) };
  });
  expect(historyTitleMetrics.fontSize).toBeGreaterThanOrEqual(26);
  expect(historyTitleMetrics.fontSize).toBeLessThanOrEqual(34);
  expect(historyTitleMetrics.lineHeight).toBeLessThanOrEqual(37);
  await expect(rail).toHaveClass(/is-compact/);
  await expect(rail.getByRole('link', { name: '进入下载中心' })).toHaveAttribute('href', '/review/downloads');

  for (const entry of [
    { id: 'E001', label: '抠图-E001' },
    { id: 'E002', label: '五视图-E002' },
    { id: 'E003', label: '套图-E003' },
    { id: 'E004', label: '视频-E004' },
    { id: 'E005', label: 'LOGO-E005' }
  ]) {
    await expect(rail.getByRole('link', { name: `进入 ${entry.label} 审核` })).toHaveAttribute('href', `/review/${entry.id}`);
  }
  await expect(rail.locator('[aria-current]')).toHaveCount(0);
  await expect(page.locator('.primary-navigation .ant-menu-item-selected')).toContainText('投递历史');
  expect(await rail.evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBeLessThanOrEqual(100);

  await page.setViewportSize({ width: 320, height: 760 });
  await expect.poll(() => rail.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);

  const firstStage = rail.getByRole('link', { name: '进入 抠图-E001 审核' });
  await firstStage.focus();
  await expect(firstStage).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/review\/E001$/);

  await page.goto('/');
  await expect(page.locator('.pipeline-rail')).not.toHaveClass(/is-compact/);
});

test('shows workflow shortcuts immediately while stage summaries continue loading', async ({ page }) => {
  const stagesResponse = await page.request.get('/api/v1/stages');
  expect(stagesResponse.ok()).toBe(true);
  const original = await stagesResponse.json();
  let releaseStages: () => void = () => undefined;
  const stagesGate = new Promise<void>((resolve) => { releaseStages = resolve; });
  await page.route('**/api/v1/stages', async (route) => {
    await stagesGate;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(original) });
  });
  await page.route('**/api/v1/submissions/history*', async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ items: historyRecords })
  }));

  await page.goto('/history');
  const rail = page.locator('.history-workflow-shortcuts .pipeline-rail');
  await expect(rail).toBeVisible();
  await expect(rail.getByRole('link', { name: '进入 抠图-E001 审核' })).toBeVisible();
  await expect(rail.getByText('状态更新中 · —', { exact: true }).first()).toBeVisible();
  releaseStages();
  await expect(rail.getByText('状态更新中 · —', { exact: true })).toHaveCount(0, { timeout: 7_000 });
});

test('shows the same compact workflow shortcuts above the pending delivery controls', async ({ page }) => {
  const stagesResponse = await page.request.get('/api/v1/stages');
  expect(stagesResponse.ok()).toBe(true);
  const original = await stagesResponse.json();
  let releaseStages: () => void = () => undefined;
  const stagesGate = new Promise<void>((resolve) => { releaseStages = resolve; });
  await page.route('**/api/v1/stages', async (route) => {
    await stagesGate;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(original) });
  });
  await page.route('**/api/v1/pending-submissions', async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ items: [] })
  }));

  await page.goto('/pending');
  const intro = page.locator('.workflow-navigation-intro');
  const shortcuts = page.locator('.pending-workflow-shortcuts');
  const rail = shortcuts.getByRole('region', { name: '工作流导航' });
  await expect(intro.locator('.page-title + .pending-workflow-shortcuts')).toBeVisible();
  await expect(page.locator('.workflow-navigation-intro + .batch-toolbar')).toBeVisible();
  await expect(shortcuts.getByRole('heading', { name: '工作流导航' })).toHaveCSS('font-size', '16px');
  await expect(shortcuts.getByText('WORKFLOW SHORTCUTS', { exact: true })).toHaveCount(0);
  await expect(intro).toHaveCSS('gap', '10px');
  const pendingTitleMetrics = await intro.getByRole('heading', { name: '待投递清单', exact: true }).evaluate((element) => {
    const style = getComputedStyle(element);
    return { fontSize: Number.parseFloat(style.fontSize), lineHeight: Number.parseFloat(style.lineHeight) };
  });
  expect(pendingTitleMetrics.fontSize).toBeGreaterThanOrEqual(26);
  expect(pendingTitleMetrics.fontSize).toBeLessThanOrEqual(34);
  expect(pendingTitleMetrics.lineHeight).toBeLessThanOrEqual(37);
  await expect(rail).toHaveClass(/is-compact/);
  await expect(rail.getByRole('link', { name: '进入下载中心' })).toHaveAttribute('href', '/review/downloads');
  await expect(rail.getByRole('link', { name: '进入 抠图-E001 审核' })).toHaveAttribute('href', '/review/E001');
  await expect(rail.getByText('状态更新中 · —', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.primary-navigation .ant-menu-item-selected')).toContainText('待投递清单');

  await page.setViewportSize({ width: 320, height: 760 });
  await expect.poll(() => rail.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  releaseStages();
  await expect(rail.getByText('状态更新中 · —', { exact: true })).toHaveCount(0, { timeout: 7_000 });
});

test('hides disabled workflow shortcuts and keeps history available when stage data is empty or unavailable', async ({ page }) => {
  const stagesResponse = await page.request.get('/api/v1/stages');
  expect(stagesResponse.ok()).toBe(true);
  const original = await stagesResponse.json() as { stages: Array<Record<string, unknown> & { id: string }> };
  let mode: 'disabled' | 'empty' | 'error' = 'disabled';
  await page.route('**/api/v1/stages', async (route) => {
    if (mode === 'error') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '测试阶段加载失败' } }) });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        stages: original.stages.map((stage) => ({ ...stage, enabled: mode === 'empty' ? false : stage.id === 'E003' ? false : stage.enabled }))
      })
    });
  });
  await page.route('**/api/v1/submissions/history*', async (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ items: historyRecords })
  }));

  await page.goto('/history');
  const shortcuts = page.locator('.history-workflow-shortcuts');
  await expect(shortcuts.getByRole('link', { name: '进入 套图-E003 审核' })).toHaveCount(0);
  await expect(shortcuts.getByRole('link', { name: '进入 抠图-E001 审核' })).toBeVisible();
  await expect(page.getByText('history-17-success', { exact: true })).toBeVisible();

  mode = 'empty';
  await page.reload();
  await expect(shortcuts.getByText('暂无已启用的工作流', { exact: true })).toBeVisible();
  await expect(shortcuts.getByRole('link', { name: '打开系统设置' })).toHaveAttribute('href', '/settings');
  await expect(page.getByText('history-17-success', { exact: true })).toBeVisible();

  mode = 'error';
  await page.reload();
  await expect(shortcuts.getByText('导航状态更新失败', { exact: true })).toBeVisible();
  await expect(shortcuts.getByRole('region', { name: '工作流导航' })).toBeVisible();
  await expect(page.getByText('history-17-success', { exact: true })).toBeVisible();
  mode = 'disabled';
  await shortcuts.getByRole('button', { name: '重试状态' }).click();
  await expect(shortcuts.getByRole('region', { name: '工作流导航' })).toBeVisible();
});

test('filters submission history by one exact SKU and preserves detail viewing', async ({ page }) => {
  const requestedSkus: Array<string | null> = [];
  await page.route('**/api/v1/submissions/history*', async (route) => {
    const sku = new URL(route.request().url()).searchParams.get('sku');
    requestedSkus.push(sku);
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ items: sku ? historyRecords.filter((item) => item.productSku === sku) : historyRecords })
    });
  });

  await page.goto('/history');
  await expect(page.getByRole('heading', { name: '投递历史' })).toBeVisible();
  await expect(page.getByText('共 4 条记录', { exact: true })).toBeVisible();
  await expect(page.getByText('history-legacy', { exact: true })).toBeVisible();

  const skuInput = page.getByRole('textbox', { name: '按 SKU 筛选投递历史' });
  await skuInput.fill('0000017');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect(page.getByText('共 2 条记录', { exact: false })).toBeVisible();
  await expect(page.getByText('history-17-success', { exact: true })).toBeVisible();
  await expect(page.getByText('history-17-failed', { exact: true })).toBeVisible();
  await expect(page.getByText('history-18-success', { exact: true })).toHaveCount(0);
  await expect(page.getByText('history-legacy', { exact: true })).toHaveCount(0);
  expect(requestedSkus.at(-1)).toBe('0000017');

  const filteredRow = page.locator('.ant-table-tbody > tr.ant-table-row').filter({ hasText: 'history-17-success' });
  await filteredRow.locator('button.ant-table-row-expand-icon').click();
  await expect(page.getByText('最终产品身份', { exact: true })).toBeVisible();
  await expect(page.getByText('0000017 · E2E运动鞋 · 红色', { exact: true })).toBeVisible();

  const requestCountBeforeInvalidSearch = requestedSkus.length;
  await skuInput.fill('123');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('SKU 必须是完整的 7 位数字');
  await page.waitForTimeout(200);
  expect(requestedSkus).toHaveLength(requestCountBeforeInvalidSearch);
  await expect(page.getByText('history-17-success', { exact: true })).toBeVisible();

  await skuInput.fill('0000018');
  await skuInput.press('Enter');
  await expect(page.getByText('history-18-success', { exact: true })).toBeVisible();
  await expect(page.getByText('history-17-success', { exact: true })).toHaveCount(0);
  expect(requestedSkus.at(-1)).toBe('0000018');

  await skuInput.fill('9999999');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await expect(page.getByText('SKU 9999999 暂无投递记录', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(page.getByText('共 4 条记录', { exact: true })).toBeVisible();
  await expect(skuInput).toHaveValue('');
  expect(requestedSkus).toContain(null);

  await page.setViewportSize({ width: 320, height: 760 });
  await expect(skuInput).toBeVisible();
  await expect(page.getByRole('button', { name: '查询', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '清除筛选', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
});

test('filters submission history by completed date only after clicking query', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-07-29T06:30:00.000Z'));
  const dateRecords: SubmissionRecord[] = [
    { ...historyRecords[0], submissionId: 'history-today', productSku: '0000017', completedAt: '2026-07-29T08:00:00.000Z' },
    { ...historyRecords[1], submissionId: 'history-yesterday', productSku: '0000018', completedAt: '2026-07-28T08:00:00.000Z' },
    { ...historyRecords[2], submissionId: 'history-seven-days', productSku: '0000019', completedAt: '2026-07-23T08:00:00.000Z' },
    { ...historyRecords[2], submissionId: 'history-before-seven-days', productSku: '0000020', completedAt: '2026-07-22T15:59:59.000Z' },
    { ...historyRecords[3], submissionId: 'history-without-completed-at', completedAt: undefined }
  ];
  const requests: URLSearchParams[] = [];
  await page.route('**/api/v1/submissions/history*', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    requests.push(new URLSearchParams(params));
    const sku = params.get('sku');
    const completedFrom = params.get('completedFrom');
    const completedTo = params.get('completedTo');
    const items = dateRecords.filter((item) => {
      if (sku && item.productSku !== sku) return false;
      if (!completedFrom && !completedTo) return true;
      if (!item.completedAt) return false;
      const completedAt = Date.parse(item.completedAt);
      return (!completedFrom || completedAt >= Date.parse(completedFrom)) && (!completedTo || completedAt < Date.parse(completedTo));
    });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items }) });
  });

  await page.goto('/history');
  const filter = page.locator('.history-filter-bar');
  const datePreset = filter.locator('.history-date-preset');
  const queryButton = filter.getByRole('button', { name: '查询', exact: true });
  const choosePreset = async (label: string) => {
    await datePreset.click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: label }).click();
  };

  const initialRequestCount = requests.length;
  await choosePreset('当天');
  await page.waitForTimeout(100);
  expect(requests).toHaveLength(initialRequestCount);
  await queryButton.click();
  await expect(page.getByText('history-today', { exact: true })).toBeVisible();
  await expect(page.getByText('history-yesterday', { exact: true })).toHaveCount(0);
  expect(requests.at(-1)?.get('completedFrom')).toBe('2026-07-28T16:00:00.000Z');
  expect(requests.at(-1)?.get('completedTo')).toBe('2026-07-29T16:00:00.000Z');
  await expect(filter.getByText('完成日期 当天', { exact: false })).toBeVisible();

  await choosePreset('昨天');
  await queryButton.click();
  await expect(page.getByText('history-yesterday', { exact: true })).toBeVisible();
  await expect(page.getByText('history-today', { exact: true })).toHaveCount(0);

  await choosePreset('近 7 天');
  await queryButton.click();
  await expect(page.getByText('history-today', { exact: true })).toBeVisible();
  await expect(page.getByText('history-yesterday', { exact: true })).toBeVisible();
  await expect(page.getByText('history-seven-days', { exact: true })).toBeVisible();
  await expect(page.getByText('history-before-seven-days', { exact: true })).toHaveCount(0);
  await expect(page.getByText('history-without-completed-at', { exact: true })).toHaveCount(0);
  expect(Date.parse(requests.at(-1)?.get('completedTo') || '') - Date.parse(requests.at(-1)?.get('completedFrom') || '')).toBe(7 * 24 * 60 * 60 * 1000);

  await choosePreset('时间段查询');
  const requestCountBeforeIncompleteRange = requests.length;
  await queryButton.click();
  await expect(filter.getByRole('alert')).toHaveText('请选择完整的投递日期开始时间和结束时间');
  expect(requests).toHaveLength(requestCountBeforeIncompleteRange);

  const startDate = filter.getByPlaceholder('开始日期');
  const endDate = filter.getByPlaceholder('结束日期');
  await startDate.fill('2026-07-28');
  await endDate.fill('2026-07-29');
  await endDate.press('Enter');
  await queryButton.click();
  await expect(page.getByText('history-today', { exact: true })).toBeVisible();
  await expect(page.getByText('history-yesterday', { exact: true })).toBeVisible();
  expect(requests.at(-1)?.get('completedFrom')).toBe('2026-07-27T16:00:00.000Z');
  expect(requests.at(-1)?.get('completedTo')).toBe('2026-07-29T16:00:00.000Z');

  await filter.getByRole('textbox', { name: '按 SKU 筛选投递历史' }).fill('0000017');
  await queryButton.click();
  await expect(page.getByText('history-today', { exact: true })).toBeVisible();
  await expect(page.getByText('history-yesterday', { exact: true })).toHaveCount(0);
  expect(requests.at(-1)?.get('sku')).toBe('0000017');

  await filter.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(filter.getByText('共 5 条记录', { exact: true })).toBeVisible();
  expect(requests.at(-1)?.toString()).toBe('');
  await expect(datePreset).toContainText('全部投递日期');

  await page.setViewportSize({ width: 320, height: 760 });
  await expect(filter.getByRole('combobox', { name: '投递日期' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
});
