import { expect, test, type Page } from '@playwright/test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function completedOperation(page: Page, response: any): Promise<any> {
  if (!response.operation) return response;
  let row: any;
  await expect.poll(async () => {
    row = await (await page.request.get('/api/v1/review-operations/' + response.operation.operationId)).json();
    return ['SUCCEEDED', 'PARTIAL_SUCCESS', 'FAILED', 'NEEDS_ATTENTION'].includes(row.status);
  }).toBe(true);
  expect(row.status).toBe('SUCCEEDED');
  return row.result;
}

async function openReviewTaskFromTable(page: Page, sourceFolderName: string): Promise<void> {
  const row = page.locator('.task-table .ant-table-tbody tr').filter({ hasText: sourceFolderName });
  await expect(row).toBeVisible();
  await row.locator('a[href^="/task/"]').first().click();
}

test.describe.serial('v002 review and delivery', () => {
  test('serves assets created after startup with JavaScript MIME and never falls back to HTML', async ({ page }) => {
    const assetName = `runtime-route-${Date.now()}.js`;
    const assetPath = path.resolve('apps/web/dist/assets', assetName);
    await writeFile(assetPath, 'export const runtimeRoute = true;\n', 'utf8');
    try {
      const response = await page.request.get(`/assets/${assetName}`);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toContain('application/javascript');
      expect(await response.text()).toContain('runtimeRoute = true');

      const missing = await page.request.get(`/assets/missing-${Date.now()}.js`);
      expect(missing.status()).toBe(404);
      expect(missing.headers()['content-type']).not.toContain('text/html');
    } finally {
      await rm(assetPath, { force: true });
    }
  });

  test('groups every active download review workflow in one download center and restores source hierarchy', async ({ page }) => {
    const stagesResponse = await page.request.get('/api/v1/stages');
    expect(stagesResponse.ok()).toBeTruthy();
    const stageViews = (await stagesResponse.json()).stages as Array<{
      id: string; alias: string; groupId: string; enabled: boolean; reviewEnabled: boolean;
      targets: Array<{ targetStageId: string }>;
      summary: { pending: number; drafts: number; approved: number };
    }>;
    const downloadStages = stageViews.filter((stage) => stage.groupId === 'downloads' && stage.enabled && stage.reviewEnabled);
    const expected = downloadStages.reduce((summary, stage) => ({
      pending: summary.pending + stage.summary.pending,
      drafts: summary.drafts + stage.summary.drafts,
      approved: summary.approved + stage.summary.approved
    }), { pending: 0, drafts: 0, approved: 0 });

    await page.goto('/');
    await expect(page.getByRole('heading', { name: '下载来源', exact: true })).toHaveCount(0);
    await expect(page.locator('.download-center-overview')).toHaveCount(0);
    await expect(page.locator('.stage-card').filter({ hasText: 'E006' })).toHaveCount(0);
    await expect(page.locator('.stage-card').filter({ hasText: 'E007' })).toHaveCount(0);
    const downloadRail = page.locator('.rail-stop-download');
    await expect(downloadRail).toHaveCount(1);
    await expect(downloadRail).toContainText(`${downloadStages.length} 个下载审核来源`);
    await expect(downloadRail).toContainText(`${expected.pending} 待审核 · ${expected.drafts} 草稿`);

    await downloadRail.click();
    await expect(page).toHaveURL(/\/review\/downloads$/);
    await expect(page.getByRole('heading', { name: '下载中心', exact: true })).toBeVisible();
    const downloadTargetIds = [...new Set(downloadStages.flatMap((stage) => stage.targets.map((target) => target.targetStageId)))];
    const downloadTargetStrip = page.locator('.delivery-target-strip');
    await expect(downloadTargetStrip).toBeVisible();
    await expect(downloadTargetStrip.locator('.delivery-target-item')).toHaveCount(downloadTargetIds.length);
    for (const targetId of downloadTargetIds) {
      const targetStage = stageViews.find((stage) => stage.id === targetId);
      await expect(downloadTargetStrip.locator('.delivery-target-item').filter({ hasText: targetId })).toContainText(targetStage?.alias || '目标配置缺失');
    }
    const centerSummary = page.locator('.download-center-summary-card');
    for (const [status, value] of Object.entries(expected)) {
      await expect(centerSummary.locator(`.download-summary-stat[data-status="${status}"]`)).toContainText(String(value));
    }
    const sourceCards = page.locator('.download-source-card:not(.is-disabled)');
    await expect(sourceCards).toHaveCount(downloadStages.length);
    expect(await sourceCards.evaluateAll((cards) => cards.map((card) => card.querySelector('.mono-badge')?.textContent))).toEqual(downloadStages.map((stage) => stage.id));
    await expect(sourceCards.filter({ hasText: 'E006' })).toContainText('PDD下载');
    await expect(sourceCards.filter({ hasText: 'E007' })).toContainText('1688下载');

    await page.setViewportSize({ width: 320, height: 760 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await sourceCards.filter({ hasText: 'E006' }).getByRole('button', { name: '进入 E006 审核' }).click();
    await expect(page).toHaveURL(/\/review\/E006$/);
    await expect(page.locator('.ant-breadcrumb').getByText('下载中心', { exact: true })).toBeVisible();
  });

  test('在每个审核列表顶部按工作流配置显示投递目标', async ({ page }) => {
    const response = await page.request.get('/api/v1/stages');
    expect(response.ok()).toBeTruthy();
    const stages = (await response.json()).stages as Array<{
      id: string; alias: string; enabled: boolean; targets: Array<{ targetStageId: string }>;
    }>;
    const stagesById = new Map(stages.map((stage) => [stage.id, stage]));

    for (const sourceId of ['E001', 'E002', 'E003']) {
      const source = stagesById.get(sourceId)!;
      await page.goto(`/review/${sourceId}`);
      const strip = page.locator('.delivery-target-strip');
      await expect(strip).toBeVisible();
      await expect(strip.locator('.delivery-target-item')).toHaveCount(source.targets.length);
      for (const [index, target] of source.targets.entries()) {
        const targetStage = stagesById.get(target.targetStageId);
        const item = strip.locator('.delivery-target-item').nth(index);
        await expect(item).toContainText(targetStage?.alias || '目标配置缺失');
        await expect(item).toContainText(target.targetStageId);
      }
    }

    for (const sourceId of ['E004', 'E005']) {
      await page.goto(`/review/${sourceId}`);
      const strip = page.locator('.delivery-target-strip');
      await expect(strip.locator('.delivery-target-item')).toHaveCount(2);
      await expect(strip.locator('.delivery-target-item').nth(0)).toContainText('WB上品目录');
      await expect(strip.locator('.delivery-target-item').nth(1)).toContainText('OZON上品目录');
    }

    await page.setViewportSize({ width: 320, height: 760 });
    await page.goto('/review/E003');
    await expect(page.locator('.delivery-target-strip')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });

  test('opens every review stage from the workflow rail while retaining the original card actions', async ({ page }) => {
    const entries = [
      { id: 'E001', label: '抠图-E001' },
      { id: 'E002', label: '五视图-E002' },
      { id: 'E003', label: '套图-E003' },
      { id: 'E004', label: '视频-E004' },
      { id: 'E005', label: 'LOGO-E005' }
    ];

    await page.goto('/');
    const rail = page.locator('.pipeline-rail');
    for (const entry of entries) {
      const link = rail.getByRole('link', { name: `进入 ${entry.label} 审核` });
      await expect(link).toHaveAttribute('href', `/review/${entry.id}`);
      await expect(link).toHaveCSS('cursor', 'pointer');
      const card = page.locator('.stage-card').filter({ hasText: entry.id });
      await expect(card.getByRole('button', { name: '进入审核' })).toBeVisible();
      await expect(card.locator(`a[href="/review/${entry.id}"]`)).toHaveCount(1);
    }

    const firstLink = rail.getByRole('link', { name: '进入 抠图-E001 审核' });
    await firstLink.hover();
    await expect(firstLink).toHaveCSS('background-color', 'rgba(22, 164, 178, 0.12)');
    await firstLink.focus();
    await expect(firstLink).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/review\/E001$/);

    for (const entry of entries.slice(1)) {
      await page.goto('/');
      await page.locator('.pipeline-rail').getByRole('link', { name: `进入 ${entry.label} 审核` }).click();
      await expect(page).toHaveURL(new RegExp(`/review/${entry.id}$`));
    }

    await page.goto('/');
    await page.setViewportSize({ width: 320, height: 760 });
    await page.locator('.pipeline-rail').getByRole('link', { name: '进入 LOGO-E005 审核' }).scrollIntoViewIfNeeded();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });

  test('defaults review stages to switchable tables and keeps E004 fixed to table', async ({ page }) => {
    for (const stageId of ['E000', 'E001', 'E002', 'E003', 'E005', 'E006', 'E007']) {
      await page.goto(`/review/${stageId}`);
      await expect(page.getByRole('radio', { name: '表格' })).toBeChecked();
      await expect(page.locator('.filter-bar .ant-radio-button-wrapper').filter({ hasText: '卡片' })).toBeVisible();
      await expect(page.locator('.product-card')).toHaveCount(0);
    }

    await page.goto('/review/E005');
    await expect(page.getByRole('radio', { name: '表格' })).toBeChecked();
    const cardViewButton = page.locator('.filter-bar .ant-radio-button-wrapper').filter({ hasText: '卡片' });
    await expect(cardViewButton).toBeVisible();
    await cardViewButton.click();
    await expect(page.getByRole('radio', { name: '卡片' })).toBeChecked();

    await page.evaluate(() => {
      window.history.pushState({}, '', '/review/E006');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page).toHaveURL(/\/review\/E006$/);
    await expect(page.getByRole('radio', { name: '表格' })).toBeChecked();
    await expect(page.locator('.task-table')).toBeVisible();
    await page.setViewportSize({ width: 320, height: 760 });
    const e006TableScroller = page.locator('.task-table .ant-table-content');
    await expect(e006TableScroller).toBeVisible();
    expect(await e006TableScroller.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto('/review/E004');
    await expect(page.getByRole('radio', { name: '卡片' })).toHaveCount(0);
    await expect(page.getByRole('radio', { name: '表格' })).toHaveCount(0);
    await expect(page.locator('.product-card')).toHaveCount(0);

    const table = page.locator('.task-table');
    await expect(table).toBeVisible();
    const row = table.locator('.ant-table-tbody tr').filter({ hasText: 'E2E-E004视频产品' });
    await expect(row).toContainText('待审核');
    await expect(row).toContainText('0 图 / 1 视频');
    await expect(row).toContainText('1');
    await expect(row.getByRole('link', { name: '进入审核' })).toBeVisible();
    await expect(page.locator('.ant-pagination')).toBeVisible();

    const search = page.getByPlaceholder('搜索产品文件夹');
    await search.fill('不存在的视频任务');
    await expect(page.getByText('当前目录没有可审核的产品文件夹')).toBeVisible();
    await search.fill('E2E-E004视频产品');
    await expect(row).toBeVisible();
    await page.getByRole('button', { name: '重新扫描' }).click();
    await expect(page.getByText('扫描完成')).toBeVisible();

    await row.getByRole('link', { name: '进入审核' }).click();
    await expect(page).toHaveURL(/\/task\/[a-f0-9]+$/);
    await page.goBack();

    const tasksResponse = await page.request.get('/api/v1/stages/E004/tasks?page=1&pageSize=24&sort=time&order=desc');
    expect(tasksResponse.ok()).toBeTruthy();
    const task = (await tasksResponse.json()).items.find((item: { sourceFolderName: string }) => item.sourceFolderName === 'E2E-E004视频产品');
    expect(task).toBeTruthy();
    const draftResponse = await page.request.put(`/api/v1/tasks/${task.taskId}/draft`, { data: { selectedRelativePaths: [] } });
    expect(draftResponse.ok()).toBeTruthy();

    await page.reload();
    const draftRow = page.locator('.task-table .ant-table-tbody tr').filter({ hasText: 'E2E-E004视频产品' });
    await expect(draftRow).toContainText('草稿');
    await expect(draftRow.getByRole('link', { name: '继续草稿' })).toBeVisible();

    await page.locator('.filter-bar .ant-select-selector').click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '草稿' }).click();
    await expect(draftRow).toBeVisible();

    await page.setViewportSize({ width: 320, height: 760 });
    const tableScroller = page.locator('.task-table .ant-table-content');
    await expect(tableScroller).toBeVisible();
    expect(await tableScroller.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);

    await draftRow.getByRole('link', { name: '继续草稿' }).click();
    await expect(page).toHaveURL(/\/task\/[a-f0-9]+$/);
  });

  test('opens a stable E005 workbench without duplicate stage, task or operation requests', async ({ page }) => {
    const counts = { stages: 0, tasks: 0, operations: 0 };
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/v1/stages') counts.stages += 1;
      if (url.pathname === '/api/v1/stages/E005/tasks') counts.tasks += 1;
      if (url.pathname === '/api/v1/review-operations') counts.operations += 1;
    });

    await page.goto('/review/E005', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('radio', { name: '表格' })).toBeChecked();
    await page.waitForTimeout(1_200);

    expect(counts).toEqual({ stages: 1, tasks: 1, operations: 1 });
  });

  test('keeps stage configuration and workflow parameter pages independent', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('.page-title').getByRole('button', { name: '导出配置' })).toBeVisible();
    await expect(page.locator('.page-title').getByRole('button', { name: '导入配置' })).toBeVisible();
    await expect(page.locator('.page-title').getByRole('button', { name: '管理分组' })).toBeVisible();
    await expect(page.locator('.page-title').getByRole('button', { name: '新建工作流' })).toBeVisible();
    await expect(page.getByText('投递与缩略图', { exact: true })).toBeVisible();
    await expect(page.getByText('残留暂存目录', { exact: true })).toBeVisible();

    for (const stageId of ['E000', 'E006', 'E007', 'E001', 'E002', 'E003', 'E004', 'E005']) {
      await page.locator('.workflow-settings-item').filter({ hasText: stageId }).click();
      const activeStageCard = page.locator('.settings-stage:visible');
      const enableSwitch = activeStageCard.getByRole('switch', { name: `${stageId} 启用流程` });
      await expect(enableSwitch).toBeVisible();
      await expect(page.getByRole('button', { name: '保存工作流' })).toBeVisible();
      if (['E000', 'E006', 'E007', 'E001', 'E002', 'E003'].includes(stageId)) {
        await expect(activeStageCard.getByText('输出目录', { exact: true })).toHaveCount(0);
      } else {
        await expect(page.getByLabel(`${stageId} WB 共享媒体输出目录模板`)).toBeVisible();
        await expect(page.getByLabel(`${stageId} OZON 共享媒体输出目录模板`)).toBeVisible();
      }
    }

    const [configDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('.page-title').getByRole('button', { name: '导出配置' }).click()
    ]);
    const exportedConfig = JSON.parse(await readFile(await configDownload.path(), 'utf8'));
    for (const stageId of ['E000', 'E006', 'E007', 'E001', 'E002', 'E003']) {
      expect(exportedConfig.stages.find((stage: { id: string }) => stage.id === stageId)).not.toHaveProperty('outputRoot');
    }

    await page.locator('.workflow-settings-item').filter({ hasText: 'E006' }).click();

    await page.getByRole('tab', { name: '工作流参数' }).click();
    const parameterCard = page.locator('.workflow-parameter-card:visible');
    await expect(parameterCard.getByRole('switch', { name: 'E006 启用流程' })).toHaveCount(0);
    await expect(parameterCard.getByRole('button', { name: '导出参数模板' })).toBeVisible();
    await expect(parameterCard.getByRole('button', { name: '导入参数模板' })).toBeVisible();
    await expect(parameterCard.getByRole('button', { name: '保存参数模板' })).toBeVisible();
    await expect(parameterCard.locator('.ant-card-body').getByRole('button', { name: '保存参数模板' })).toHaveCount(0);
    await expect(page.locator('.system-maintenance-card')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '保存全局设置' })).toHaveCount(0);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      parameterCard.getByRole('button', { name: '导出参数模板' }).click()
    ]);
    expect(download.suggestedFilename()).toBe('E006_n8n_product_image_task.template.json');
    const exported = JSON.parse(await readFile((await download.path())!, 'utf8'));
    expect(exported).toMatchObject({ stageId: 'E006', parameters: expect.any(Object), parameterOptions: expect.any(Object) });
    expect(exported.parameters).toMatchObject({ SKU: '', productName: '' });
    const skuRow = parameterCard.locator('.parameter-template-row.is-system').filter({ has: page.locator('input[value="SKU"]') });
    const productNameRow = parameterCard.locator('.parameter-template-row.is-system').filter({ has: page.locator('input[value="productName"]') });
    await expect(skuRow.locator('input[value="SKU"]')).toBeDisabled();
    await expect(skuRow.locator('.parameter-type-select')).toHaveClass(/ant-select-disabled/);
    await expect(skuRow.locator('textarea')).toBeDisabled();
    await expect(skuRow.getByText('运行时自动写入')).toBeVisible();
    await expect(productNameRow.locator('input[value="productName"]')).toBeDisabled();

    const templateInput = parameterCard.locator('input[type="file"]');
    await templateInput.setInputFiles({
      name: 'E006_n8n_product_image_task.template.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ stageId: 'E006', parameters: { importedMode: 'quality', importedCount: 2 }, parameterOptions: { importedMode: ['quality', 'fast'], importedCount: [2, 4] } }))
    });
    await expect(page.getByText('E006 参数模板已导入，保存后生效')).toBeVisible();
    await expect(parameterCard.locator('.parameter-template-row')).toHaveCount(4);
    await expect(parameterCard.locator('input[value="importedMode"]')).toBeVisible();

    await templateInput.setInputFiles({
      name: 'wrong-stage.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ stageId: 'E001', parameters: { shouldNotAppear: true }, parameterOptions: {} }))
    });
    await expect(page.getByText('模板属于 E001，不能导入当前阶段 E006')).toBeVisible();
    await expect(parameterCard.locator('input[value="importedMode"]')).toBeVisible();

    await templateInput.setInputFiles({
      name: 'plain-parameters.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ rawString: 'compatible', rawBoolean: true }))
    });
    await expect(parameterCard.locator('.parameter-template-row')).toHaveCount(4);
    await expect(parameterCard.locator('input[value="rawString"]')).toBeVisible();
    await expect(parameterCard.locator('input[value="importedMode"]')).toHaveCount(0);

    await page.reload();
    await page.getByRole('tab', { name: '工作流参数' }).click();
    await expect(page.locator('.workflow-parameter-card:visible').locator('input[value="importedMode"]')).toHaveCount(0);

    await page.setViewportSize({ width: 320, height: 760 });
    const mobileCard = page.locator('.workflow-parameter-card:visible');
    await expect(mobileCard.getByRole('button', { name: '导出参数模板' })).toBeVisible();
    await expect(mobileCard.getByRole('button', { name: '保存参数模板' })).toBeVisible();
    expect(await mobileCard.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  });

  test('shows type selectors for all stages and the exact typed E004 defaults', async ({ page }) => {
    await page.goto('/settings');
    for (const stageId of ['E000', 'E006', 'E007', 'E001', 'E002', 'E003', 'E004', 'E005']) {
      await page.locator('.workflow-settings-item').filter({ hasText: stageId }).click();
      await page.getByRole('tab', { name: '工作流参数' }).click();
      await expect(page.locator('.workflow-parameter-card:visible .parameter-type-select').first()).toBeVisible();
      await expect(page.locator('.workflow-parameter-card:visible .parameter-template-row.is-system')).toHaveCount(['E002', 'E003', 'E004', 'E005'].includes(stageId) ? 3 : 2);
    }
    await page.locator('.workflow-settings-item').filter({ hasText: 'E004' }).click();
    await page.getByRole('tab', { name: '工作流参数' }).click();
    const activeCard = page.locator('.workflow-parameter-card:visible');
    const numberRow = activeCard.locator('.parameter-template-row').filter({ has: page.locator('input[value="targetDuration"]') });
    const booleanRow = activeCard.locator('.parameter-template-row').filter({ has: page.locator('input[value="enableLogo"]') });
    const arrayRow = activeCard.locator('.parameter-template-row').filter({ has: page.locator('input[value="allowedImageExtensions"]') });
    await expect(numberRow.locator('.parameter-type-select')).toContainText('Number');
    await expect(booleanRow.locator('.parameter-type-select')).toContainText('Boolean');
    await expect(arrayRow.locator('.parameter-type-select')).toContainText('Array');
    await expect(arrayRow.locator('textarea')).toHaveValue('[\n  ".jpg",\n  ".jpeg",\n  ".png",\n  ".webp"\n]');
  });

  test('requires a manual purchase selection when folder identity is not unique and remains usable at 320px', async ({ page }) => {
    await page.goto('/review/E006');
    await openReviewTaskFromTable(page, 'E2E-需要人工关联');
    const identity = page.locator('.product-identity-strip');
    await expect(identity).toContainText('尚未识别采购 SKU');
    await expect(page.getByRole('button', { name: '审核通过' })).toBeDisabled();
    const purchaseSelector = identity.getByRole('combobox', { name: '选择采购 SKU' });
    await purchaseSelector.click();
    await purchaseSelector.pressSequentially('0000001');
    await page.locator('.ant-select-dropdown:visible').getByText(/0000001 · E2E-测试产品A/).click();
    await identity.getByRole('button', { name: '确认关联' }).click();
    await expect(identity).toContainText('0000001');
    await expect(identity).toContainText('E2E-测试产品A');
    await expect(page.getByRole('button', { name: '审核通过' })).toBeEnabled();

    await page.setViewportSize({ width: 320, height: 760 });
    expect(await identity.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  });

  test('configures target workflow parameters and keeps the pending snapshot independent', async ({ page }) => {
    await page.goto('/settings');
    await page.locator('.workflow-settings-item').filter({ hasText: 'E003' }).click();
    await page.getByRole('tab', { name: '工作流参数' }).click();
    await expect(page.getByText('E003_n8n_product_image_task.json')).toBeVisible();
    await page.getByRole('button', { name: '添加参数字段' }).click();
    const newRow = page.locator('.parameter-template-row').last();
    await newRow.locator('input[placeholder="字段名"]').fill('e2eField');
    await expect(newRow.locator('.parameter-type-select')).toContainText('String');
    await newRow.locator('textarea').fill('E003-default');
    await newRow.getByRole('switch', { name: 'e2eField 启用下拉选项' }).click();
    await newRow.getByRole('button', { name: '管理选项 (2)' }).click();
    const optionsModal = page.locator('.parameter-options-modal');
    await optionsModal.locator('input[aria-label="选项 2"]').fill('E003-task');
    await optionsModal.getByRole('button', { name: '添加选项' }).click();
    await optionsModal.locator('input[aria-label="选项 3"]').fill('E003-alt');
    await optionsModal.getByRole('button', { name: '上移选项 2' }).click();
    await expect(optionsModal.locator('input[aria-label="选项 1"]')).toHaveValue('E003-task');
    await optionsModal.getByRole('button', { name: '下移选项 1' }).click();
    await expect(optionsModal.locator('input[aria-label="选项 1"]')).toHaveValue('E003-default');
    await optionsModal.getByRole('button', { name: '应用选项' }).click();
    await page.getByRole('button', { name: '添加参数字段' }).click();
    const numberRow = page.locator('.parameter-template-row').last();
    await numberRow.locator('input[placeholder="字段名"]').fill('e2eNumber');
    await numberRow.locator('.parameter-type-select').click();
    await page.locator('.ant-select-dropdown:visible').getByText('Number', { exact: true }).click();
    await numberRow.locator('input[type="number"]').fill('12');
    await numberRow.getByRole('switch', { name: 'e2eNumber 启用下拉选项' }).click();
    await numberRow.getByRole('button', { name: '管理选项 (2)' }).click();
    await optionsModal.locator('input[aria-label="选项 2"]').fill('24');
    await optionsModal.getByRole('button', { name: '应用选项' }).click();
    await page.getByRole('button', { name: '添加参数字段' }).click();
    const arrayRow = page.locator('.parameter-template-row').last();
    await arrayRow.locator('input[placeholder="字段名"]').fill('e2eArray');
    await arrayRow.locator('.parameter-type-select').click();
    await page.locator('.ant-select-dropdown:visible').getByText('Array', { exact: true }).click();
    await arrayRow.locator('textarea').fill('not-json');
    await page.getByRole('button', { name: '保存参数模板' }).click();
    await expect(arrayRow.getByText('请输入有效的 JSON 数组')).toBeVisible();
    await arrayRow.locator('textarea').fill('["alpha", "beta"]');
    await page.getByRole('button', { name: '保存参数模板' }).click();
    await expect(page.getByText('E003 参数模板已保存')).toBeVisible();

    await page.reload();
    await page.locator('.workflow-settings-item').filter({ hasText: 'E003' }).click();
    await page.getByRole('tab', { name: '工作流参数' }).click();
    const savedRow = page.locator('.parameter-template-row').filter({ has: page.locator('input[value="e2eField"]') });
    const savedNumberRow = page.locator('.parameter-template-row').filter({ has: page.locator('input[value="e2eNumber"]') });
    await expect(savedRow.locator('input[placeholder="字段名"]')).toHaveValue('e2eField');
    await expect(savedRow.locator('.parameter-value-cell .ant-select-selection-item')).toHaveText('E003-default');
    await expect(savedRow.getByRole('button', { name: '管理选项 (3)' })).toBeVisible();
    await expect(savedNumberRow.locator('.parameter-type-select')).toContainText('Number');
    await expect(savedNumberRow.locator('.parameter-value-cell .ant-select-selection-item')).toHaveText('12');

    await page.goto('/review/E002');
    await openReviewTaskFromTable(page, 'E2E-五视图产品');
    await expect(page.locator('.product-identity-strip')).toContainText('E2E-五视图产品');
    await expect(page.locator('.product-identity-strip')).toContainText('已从 PostgreSQL 校验');
    await page.getByRole('button', { name: '当前目录全选' }).click();
    await page.getByRole('button', { name: '审核通过' }).click();
    await expect(page.locator('.ant-modal').getByRole('checkbox')).toBeChecked();
    await page.getByRole('button', { name: '加入待投递清单' }).click();

    const pendingRow = page.locator('.ant-table-tbody tr').filter({ hasText: 'E2E-五视图产品' });
    await expect(page.locator('.batch-toolbar .ant-select-selection-item')).toHaveText('目标重名：创建修订版本');
    await expect(pendingRow).toContainText('创建修订版本');
    await pendingRow.getByRole('button', { name: 'n8n任务配置' }).click();
    const modal = page.locator('.task-parameter-modal');
    await expect(modal).toContainText('E003');
    await expect(modal.locator('.pending-parameter-row.is-system')).toHaveCount(3);
    await expect(modal.locator('.pending-parameter-row.is-system textarea').first()).toBeDisabled();
    await expect(modal.getByText('系统写入').first()).toBeVisible();
    await expect(modal.locator('.pending-parameter-row.is-system').filter({ hasText: 'variants' }).locator('textarea')).toHaveValue('默认变体');
    const customValueRow = modal.locator('.pending-parameter-row').filter({ hasText: 'e2eField' });
    const customNumberRow = modal.locator('.pending-parameter-row').filter({ hasText: 'e2eNumber' });
    const customValue = customValueRow.locator('.parameter-value-cell .ant-select-selector');
    const customNumber = customNumberRow.locator('.parameter-value-cell .ant-select-selector');
    await expect(customValueRow.locator('.ant-select-selection-item')).toHaveText('E003-default');
    await expect(customNumberRow.locator('.ant-select-selection-item')).toHaveText('12');
    await customValue.click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'E003-task' }).click();
    await customNumber.click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '24' }).click();
    await modal.getByRole('button', { name: '保存任务配置' }).click();
    await expect(page.getByText('n8n 任务配置已保存')).toBeVisible();

    await pendingRow.getByRole('button', { name: 'n8n任务配置' }).click();
    await expect(customValueRow.locator('.ant-select-selection-item')).toHaveText('E003-task');
    await expect(customNumberRow.locator('.ant-select-selection-item')).toHaveText('24');
    await modal.getByRole('button', { name: '重置为当前默认值' }).click();
    await expect(customValueRow.locator('.ant-select-selection-item')).toHaveText('E003-default');
    await expect(customNumberRow.locator('.ant-select-selection-item')).toHaveText('12');
    await customValue.click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'E003-task' }).click();
    await modal.getByRole('button', { name: '保存任务配置' }).click();

    await pendingRow.locator('label.ant-checkbox-wrapper').click();
    let releaseBatchRequest: () => void = () => undefined;
    const batchRequestGate = new Promise<void>((resolve) => { releaseBatchRequest = resolve; });
    await page.route('**/api/v1/submissions/batch', async (route) => { await batchRequestGate; await route.continue(); });
    const batchResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/v1/submissions/batch') && response.request().method() === 'POST');
    const submitButton = page.getByRole('button', { name: '批量投递' });
    await submitButton.click();
    await expect(page.locator('.ant-drawer').filter({ hasText: '投递进度' })).toHaveCount(0);
    await expect(page.getByText('批量投递完成')).toHaveCount(0);
    await expect(submitButton).toBeDisabled();
    releaseBatchRequest();
    const accepted = await batchResponsePromise;
    expect(accepted.status()).toBe(202);
    const batchBody = await completedOperation(page, await accepted.json());
    await page.unroute('**/api/v1/submissions/batch');
    const batchResults = batchBody.results as Array<{ status: string; submissionId: string }>;
    expect(batchResults.map((item) => item.status)).toEqual(['SUCCESS']);
    await expect(page.getByText('批量投递完成')).toHaveCount(0);
    await expect(page.locator('.ant-drawer').filter({ hasText: '投递进度' })).toHaveCount(0);
    await expect(pendingRow).toHaveCount(0);
    await page.goto('/history');
    await expect(page.locator('.ant-table-tbody > tr.ant-table-row').filter({ hasText: batchResults[0]!.submissionId })).toContainText('SUCCESS');
  });

  test('creates multiple E001 variant selection groups and freezes one pending task per variant', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/review/E001');
    await openReviewTaskFromTable(page, 'E2E-E001变体分组');
    const variantInput = page.locator('.platform-color-lane.is-wb .ant-select-selection-search-input');
    const ozonInput = page.locator('.platform-color-lane.is-ozon .ant-select-selection-search-input');
    await variantInput.fill('红色');
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option')
      .filter({ hasText: /红色.*Красный/ })
      .click();
    await expect(page.getByText('自动匹配', { exact: true })).toBeVisible();
    await expect(page.locator('.platform-color-lane.is-ozon .ant-select-selection-item')).toContainText('红色 / Красный');
    await ozonInput.fill('сапфир');
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '黑蓝宝石' }).click();
    await expect(page.getByText('人工选择', { exact: true })).toBeVisible();
    await page.locator('.platform-color-lane.is-ozon .ant-select-selector').hover();
    await page.locator('.platform-color-lane.is-ozon .ant-select-clear').click();
    await expect(page.getByText('未设置', { exact: true }).last()).toBeVisible();
    await ozonInput.fill('黑蓝');
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '黑蓝宝石' }).click();
    for (const fileName of ['01.png', '02.png', '03.png', '04.png', '05.png', '06.png']) await page.getByRole('button', { name: `选择媒体 ${fileName}` }).click();
    await expect(page.locator('.selected-image-count')).toHaveText('已选 6 张');
    await page.getByRole('button', { name: '保存草稿' }).click();
    await expect(page.getByText('草稿已保存')).toBeVisible();
    await page.reload();
    await expect(page.locator('.selected-image-count')).toHaveText('已选 6 张');
    const taskUrl = page.url();
    await page.getByRole('button', { name: '审核通过' }).click();
    await expect(page.getByText('产品变体“红色”已选择 6 张图片，每个变体最多 5 张，请修改图片数量后再审核。')).toBeVisible();
    await expect(page.getByRole('dialog', { name: '确认审核通过' })).toHaveCount(0);
    await expect(page.locator('.variant-group-tab.is-active')).toContainText('红色');
    expect(page.url()).toBe(taskUrl);
    await page.getByRole('button', { name: '选择媒体 06.png' }).click();
    await expect(page.locator('.selected-image-count')).toHaveText('已选 5 张');
    await page.locator('.variant-group-rail').getByRole('button', { name: '新增' }).click();
    await expect(page.locator('.selected-image-count')).toHaveText('已选 0 张');
    await variantInput.fill('白色');
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option')
      .filter({ hasText: /白色.*Белый/ })
      .click();
    await expect(page.locator('.platform-color-lane.is-ozon .ant-select-selection-item')).toContainText('白色 / Белый');
    await page.locator('.platform-color-lane.is-ozon .ant-select-selector').click();
    await ozonInput.fill('Белый');
    await ozonInput.press('ArrowDown');
    await ozonInput.press('Enter');
    await page.locator('.platform-color-lane.is-ozon .ant-select-selector').hover();
    await page.locator('.platform-color-lane.is-ozon .ant-select-clear').click();
    await page.getByRole('button', { name: '选择媒体 01.png' }).click();
    await page.getByRole('button', { name: '选择媒体 06.png' }).click();
    await expect(page.locator('.selected-image-count')).toHaveText('已选 2 张');
    await expect(page.locator('.variant-group-tab')).toHaveCount(2);
    await page.setViewportSize({ width: 320, height: 760 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect(page.locator('.variant-group-rail')).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('button', { name: '审核通过' }).click();
    await expect(page.locator('.ant-modal').getByText('红色', { exact: true })).toBeVisible();
    await expect(page.locator('.ant-modal').getByText('白色', { exact: true })).toBeVisible();
    await expect(page.locator('.variant-approval-row').filter({ hasText: '红色' })).toContainText('黑蓝宝石 / черный сапфир');
    await expect(page.locator('.variant-approval-row').filter({ hasText: '白色' })).toContainText('OZON未设置选填');
    await page.getByRole('button', { name: '加入待投递清单' }).click();
    const rows = page.locator('.ant-table-tbody tr').filter({ hasText: 'E2E-E001变体分组' });
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: '红色' })).toHaveCount(1);
    await expect(rows.filter({ hasText: '白色' })).toHaveCount(1);
    await rows.filter({ hasText: '红色' }).getByRole('button', { name: 'n8n任务配置' }).click();
    const modal = page.locator('.task-parameter-modal');
    await expect(modal.locator('.pending-parameter-row.is-system').filter({ hasText: 'variants' }).locator('textarea')).toHaveValue('红色');
    await expect(modal.locator('.pending-parameter-row.is-system').filter({ hasText: 'variants' }).locator('textarea')).toBeDisabled();
    await modal.locator('.ant-modal-close').click();
    await rows.locator('label.ant-checkbox-wrapper').first().click();
    await rows.locator('label.ant-checkbox-wrapper').nth(1).click();
    const batchResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/v1/submissions/batch') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '批量投递' }).click();
    await expect(page.locator('.ant-drawer').filter({ hasText: '投递进度' })).toHaveCount(0);
    const accepted = await batchResponsePromise;
    expect(accepted.status()).toBe(202);
    const batchBody = await completedOperation(page, await accepted.json());
    expect(batchBody.results.map((item: { status: string; errorCode?: string }) => ({ status: item.status, errorCode: item.errorCode }))).toEqual([
      { status: 'SUCCESS' },
      { status: 'SUCCESS' }
    ]);
    await expect(page.getByText('批量投递完成')).toHaveCount(0);
    await expect(page.locator('.ant-drawer').filter({ hasText: '投递进度' })).toHaveCount(0);
  });

  test('navigates the image preview by mouse and keyboard without changing selection', async ({ page }) => {
    await page.goto('/review/E006');
    await openReviewTaskFromTable(page, 'E2E-预览切换');
    const selectedImageCount = page.locator('.selected-image-count');
    await expect(selectedImageCount).toHaveText('已选 0 张');
    const firstCell = page.locator('.contact-cell').first();
    await firstCell.hover();
    await firstCell.locator('.cell-preview').click();

    const modal = page.locator('.preview-modal');
    const previous = modal.getByRole('button', { name: '上一张图片' });
    const next = modal.getByRole('button', { name: '下一张图片' });
    await expect(modal).toBeVisible();
    await expect(modal.getByText('预览组/01-portrait.png', { exact: true })).toBeVisible();
    await expect(previous).toBeEnabled();
    await expect(next).toBeEnabled();
    await expect(modal.getByRole('button', { name: '选择此图' })).toBeVisible();

    await previous.click();
    await expect(modal.getByText('预览组/04-three-four.png', { exact: true })).toBeVisible();
    await expect(page.getByText('0 / 4 已选择')).toBeVisible();
    await next.click();
    await expect(modal.getByText('预览组/01-portrait.png', { exact: true })).toBeVisible();
    await next.click();
    await expect(modal.getByText('预览组/02-landscape.png', { exact: true })).toBeVisible();
    await expect(page.getByText('0 / 4 已选择')).toBeVisible();

    await modal.getByRole('button', { name: '选择此图' }).click();
    await expect(modal.getByRole('button', { name: '取消选择' })).toBeVisible();
    await expect(page.getByText('1 / 4 已选择')).toBeVisible();
    await expect(selectedImageCount).toHaveText('已选 1 张');
    await next.click();
    await expect(modal.getByText('预览组/03-square.png', { exact: true })).toBeVisible();
    await expect(modal.getByRole('button', { name: '选择此图' })).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(modal.getByText('预览组/02-landscape.png', { exact: true })).toBeVisible();
    await expect(modal.getByRole('button', { name: '取消选择' })).toBeVisible();

    await page.keyboard.press('Space');
    await expect(page.getByText('0 / 4 已选择')).toBeVisible();
    await expect(selectedImageCount).toHaveText('已选 0 张');
    await expect(modal.getByText('预览组/02-landscape.png', { exact: true })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(modal.getByText('预览组/03-square.png', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
  });

  test('keeps preview controls clear of images and disables them for a single-image folder', async ({ page }) => {
    await page.goto('/review/E006');
    await openReviewTaskFromTable(page, 'E2E-预览切换');
    const previewCell = page.locator('.contact-cell').first();
    await previewCell.hover();
    await previewCell.locator('.cell-preview').click();

    const modal = page.locator('.preview-modal');
    await expect(modal).toBeVisible();
    const actions = modal.locator('.preview-actions');
    expect(await actions.evaluate((element) => Boolean(element.querySelector('.preview-shortcuts')?.compareDocumentPosition(element.querySelector('.preview-select-action')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 600, height: 760 }]) {
      await page.setViewportSize(viewport);
      const boxes = await modal.evaluate((element) => {
        const image = element.querySelector<HTMLImageElement>('.preview-media img')!.getBoundingClientRect();
        const previous = element.querySelector<HTMLButtonElement>('.preview-nav-previous')!.getBoundingClientRect();
        const next = element.querySelector<HTMLButtonElement>('.preview-nav-next')!.getBoundingClientRect();
        const actions = element.querySelector<HTMLElement>('.preview-actions')!.getBoundingClientRect();
        const shortcuts = element.querySelector<HTMLElement>('.preview-shortcuts')!.getBoundingClientRect();
        const selectAction = element.querySelector<HTMLButtonElement>('.preview-select-action')!.getBoundingClientRect();
        return {
          previousRight: previous.right,
          imageLeft: image.left,
          imageRight: image.right,
          nextLeft: next.left,
          imageBottom: image.bottom,
          actionsTop: actions.top,
          actionsLeft: actions.left,
          actionsRight: actions.right,
          shortcutsLeft: shortcuts.left,
          selectActionLeft: selectAction.left,
          selectActionRight: selectAction.right,
          hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
        };
      });
      expect(boxes.previousRight).toBeLessThanOrEqual(boxes.imageLeft + 1);
      expect(boxes.nextLeft).toBeGreaterThanOrEqual(boxes.imageRight - 1);
      expect(boxes.actionsTop).toBeGreaterThanOrEqual(boxes.imageBottom);
      expect(Math.abs(boxes.shortcutsLeft - boxes.actionsLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(boxes.selectActionRight - boxes.actionsRight)).toBeLessThanOrEqual(1);
      expect(boxes.shortcutsLeft).toBeLessThan(boxes.selectActionLeft);
      expect(boxes.hasHorizontalOverflow).toBe(false);
      if (viewport.width === 1440) {
        await modal.getByRole('button', { name: '选择此图' }).click();
        const cancelButton = modal.getByRole('button', { name: '取消选择' });
        await expect(cancelButton).toBeVisible();
        await expect.poll(async () => {
          const [actionsBox, cancelBox] = await Promise.all([actions.boundingBox(), cancelButton.boundingBox()]);
          return Math.abs((actionsBox!.x + actionsBox!.width) - (cancelBox!.x + cancelBox!.width));
        }).toBeLessThanOrEqual(1);
        await cancelButton.click();
      }
      await modal.getByRole('button', { name: '下一张图片' }).click();
    }
    await modal.locator('.ant-modal-close').click();
    await expect(modal).toBeHidden();

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/review/E006');
    await openReviewTaskFromTable(page, 'E2E-测试产品A');
    const singleImageCell = page.locator('.contact-cell').first();
    await singleImageCell.hover();
    await singleImageCell.locator('.cell-preview').click();
    await expect(modal.getByRole('button', { name: '上一张图片' })).toBeDisabled();
    await expect(modal.getByRole('button', { name: '下一张图片' })).toBeDisabled();
  });

  test('saves a draft, restores it and delivers E006 to E001', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '产品图片审核与投递' })).toBeVisible();
    await page.locator('.rail-stop-download').click();
    const e006 = page.locator('.download-source-card').filter({ hasText: 'E006' });
    await e006.getByRole('button', { name: '进入 E006 审核' }).click();
    await expect(page.getByText('E2E-测试产品A', { exact: true }).first()).toBeVisible();
    await openReviewTaskFromTable(page, 'E2E-测试产品A');
    await page.getByRole('button', { name: '当前目录全选' }).click();
    await expect(page.getByText('1 / 2 已选择')).toBeVisible();
    await page.getByRole('button', { name: '保存草稿' }).click();
    await expect(page.getByText('草稿已保存')).toBeVisible();
    await page.reload();
    await expect(page.getByText('1 / 2 已选择')).toBeVisible();
    await page.getByRole('button', { name: '审核通过' }).click();
    await expect(page.locator('.ant-modal').getByRole('checkbox')).toBeChecked();
    await page.getByRole('button', { name: '加入待投递清单' }).click();
    await expect(page.getByRole('heading', { name: '待投递清单' })).toBeVisible();
    await expect(page.getByText('E2E-测试产品A', { exact: true }).first()).toBeVisible();
    await page.locator('.ant-table-tbody tr').filter({ hasText: 'E2E-测试产品A' }).locator('label.ant-checkbox-wrapper').click();
    const batchResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/v1/submissions/batch') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '批量投递' }).click();
    await expect(page.locator('.ant-drawer').filter({ hasText: '投递进度' })).toHaveCount(0);
    const accepted = await batchResponsePromise;
    expect(accepted.status()).toBe(202);
    const batchBody = await completedOperation(page, await accepted.json());
    expect(batchBody.results.map((item: { status: string }) => item.status)).toEqual(['SUCCESS']);
    await expect(page.getByText('批量投递完成')).toHaveCount(0);
    await expect(page.locator('.ant-drawer').filter({ hasText: '投递进度' })).toHaveCount(0);
  });

  test('keeps the E003 selected-media order through controls, preview, draft save and refresh', async ({ page }) => {
    await page.goto('/review/E003');
    await openReviewTaskFromTable(page, 'E2E-E003排序');
    const grid = page.locator('.contact-sheet-grid');
    for (const fileName of ['07.png', '01.png', '04.png']) {
      await grid.locator('.contact-cell').filter({ hasText: fileName }).click();
    }

    const rows = page.locator('.selection-list.is-ordered .selected-row');
    const selectedPaths = () => rows.locator('.selected-row-path').allTextContents();
    await expect(rows).toHaveCount(3);
    await expect(rows.locator('.selected-row-sequence')).toHaveText(['1', '2', '3']);
    await expect.poll(selectedPaths).toEqual(['排序/07.png', '排序/01.png', '排序/04.png']);
    await expect(page.getByText('首图', { exact: true })).toHaveCount(0);

    await rows.nth(2).getByRole('button', { name: '将第 3 项上移' }).click();
    await expect.poll(selectedPaths).toEqual(['排序/07.png', '排序/04.png', '排序/01.png']);
    await rows.nth(2).getByRole('button', { name: '将第 3 项置顶' }).click();
    await expect.poll(selectedPaths).toEqual(['排序/01.png', '排序/07.png', '排序/04.png']);
    await rows.nth(0).getByRole('button', { name: '将第 1 项下移' }).click();
    await expect.poll(selectedPaths).toEqual(['排序/07.png', '排序/01.png', '排序/04.png']);

    await rows.nth(0).locator('.selected-drag-handle').dragTo(rows.nth(2));
    await expect.poll(selectedPaths).toEqual(['排序/01.png', '排序/04.png', '排序/07.png']);
    await rows.nth(2).locator('.selected-drag-handle').dragTo(rows.nth(0));
    await expect.poll(selectedPaths).toEqual(['排序/07.png', '排序/01.png', '排序/04.png']);

    await rows.nth(0).locator('.selected-media-preview').click();
    const preview = page.locator('.preview-modal');
    await expect(preview.getByText('排序/07.png', { exact: true })).toBeVisible();
    await preview.getByRole('button', { name: '下一张图片' }).click();
    await expect(preview.getByText('排序/01.png', { exact: true })).toBeVisible();
    await preview.locator('.ant-modal-close').click();

    await rows.nth(1).getByRole('button', { name: '移除第 2 项' }).click();
    await grid.locator('.contact-cell').filter({ hasText: '01.png' }).click();
    await expect.poll(selectedPaths).toEqual(['排序/07.png', '排序/04.png', '排序/01.png']);
    await rows.nth(2).getByRole('button', { name: '将第 3 项上移' }).click();
    await expect.poll(selectedPaths).toEqual(['排序/07.png', '排序/01.png', '排序/04.png']);

    const draftRequest = page.waitForRequest((request) => request.url().includes('/draft') && request.method() === 'PUT');
    await page.getByRole('button', { name: '保存草稿' }).click();
    expect((await draftRequest).postDataJSON()).toMatchObject({
      selectedRelativePaths: ['排序/07.png', '排序/01.png', '排序/04.png']
    });
    await expect(page.getByText('草稿已保存')).toBeVisible();
    await page.reload();
    await expect.poll(() => page.locator('.selection-list.is-ordered .selected-row-path').allTextContents()).toEqual([
      '排序/07.png',
      '排序/01.png',
      '排序/04.png'
    ]);
  });

  test('approves one E003 selection for both E004 and E005', async ({ page }) => {
    await page.goto('/review/E003');
    await expect(page.getByText('E2E-测试套图A')).toBeVisible();
    await openReviewTaskFromTable(page, 'E2E-测试套图A');
    await page.getByRole('button', { name: '当前目录全选' }).click();
    await page.getByRole('button', { name: '审核通过' }).click();
    const modal = page.getByRole('dialog', { name: '确认审核通过' });
    for (const label of ['视频-E004', 'LOGO-E005']) {
      const target = modal.locator('label.ant-checkbox-wrapper').filter({ hasText: label });
      const checkbox = target.getByRole('checkbox');
      if (!(await checkbox.isChecked())) await target.click();
      await expect(checkbox).toBeChecked();
    }
    await page.getByRole('button', { name: '加入待投递清单' }).click();
    const rows = page.locator('.ant-table-tbody tr').filter({ hasText: 'E2E-测试套图A' });
    await expect(rows).toHaveCount(2);
    await rows.nth(0).locator('label.ant-checkbox-wrapper').click();
    await rows.nth(1).locator('label.ant-checkbox-wrapper').click();
    const batchResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/v1/submissions/batch') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '批量投递' }).click();
    await expect(page.locator('.ant-drawer').filter({ hasText: '投递进度' })).toHaveCount(0);
    const accepted = await batchResponsePromise;
    expect(accepted.status()).toBe(202);
    const batchBody = await completedOperation(page, await accepted.json());
    expect(batchBody.results.map((item: { status: string }) => item.status)).toEqual(['SUCCESS', 'SUCCESS']);
    await expect(page.getByText('批量投递完成')).toHaveCount(0);
    await expect(page.locator('.ant-drawer').filter({ hasText: '投递进度' })).toHaveCount(0);
  });

  test('hides a disabled stage and locks its review and pending delivery entry until re-enabled', async ({ page }) => {
    await page.goto('/settings');
    await page.locator('.workflow-settings-item').filter({ hasText: 'E001' }).click();
    const initialSwitch = page.locator('.settings-stage:visible').getByRole('switch', { name: 'E001 启用流程' });
    if (!(await initialSwitch.isChecked())) {
      await initialSwitch.click();
      await page.getByRole('button', { name: '保存工作流' }).click();
      await expect(page.getByText('抠图-E001 已保存')).toBeVisible();
    }
    await page.goto('/review/E006');
    await openReviewTaskFromTable(page, 'E2E-预览切换');
    await page.getByRole('button', { name: '当前目录全选' }).click();
    await page.getByRole('button', { name: '审核通过' }).click();
    await page.getByRole('button', { name: '加入待投递清单' }).click();
    const pendingRow = page.locator('.ant-table-tbody tr').filter({ hasText: 'E2E-预览切换' });
    await expect(pendingRow).toBeVisible();

    await page.goto('/settings');
    await page.locator('.workflow-settings-item').filter({ hasText: 'E001' }).click();
    const settingsCard = page.locator('.settings-stage:visible');
    await settingsCard.getByRole('switch', { name: 'E001 启用流程' }).click();
    await page.getByRole('button', { name: '保存工作流' }).click();
    await expect(page.getByText('抠图-E001 已保存')).toBeVisible();
    await expect(page.locator('.workflow-settings-item.is-active').getByText('已停用', { exact: true })).toBeVisible();

    await page.goto('/');
    await expect(page.locator('.stage-card').filter({ hasText: 'E001' })).toHaveCount(0);
    await expect(page.locator('.rail-stop').filter({ hasText: 'E001' })).toHaveCount(0);
    await page.goto('/review/E001');
    await expect(page.getByText('流程 E001 已停用', { exact: true })).toBeVisible();

    await page.goto('/pending');
    const lockedRow = page.locator('.ant-table-tbody tr').filter({ hasText: 'E2E-预览切换' });
    await expect(lockedRow.getByText('不可投递')).toBeVisible();
    await expect(lockedRow.locator('input[type="checkbox"]')).toBeDisabled();
    await lockedRow.getByText('返回修改').click();
    await expect(page.getByRole('button', { name: '审核通过' })).toBeDisabled();

    await page.goto('/settings');
    await page.locator('.workflow-settings-item').filter({ hasText: 'E001' }).click();
    const restoredCard = page.locator('.settings-stage:visible');
    await restoredCard.getByRole('switch', { name: 'E001 启用流程' }).click();
    await page.getByRole('button', { name: '保存工作流' }).click();
    await expect(page.getByText('抠图-E001 已保存')).toBeVisible();
    await expect(page.locator('.workflow-settings-item.is-active').getByText('运行中', { exact: true })).toBeVisible();
    await page.goto('/pending');
    const restoredRow = page.locator('.ant-table-tbody tr').filter({ hasText: 'E2E-预览切换' });
    await expect(restoredRow.locator('input[type="checkbox"]')).toBeEnabled();
    await restoredRow.getByRole('button', { name: '移出' }).click();
    await expect(restoredRow).toHaveCount(0);
  });
});
