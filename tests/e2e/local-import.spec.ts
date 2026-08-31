import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.describe.serial('E000 local import and E001 delivery', () => {
  let sku = '';
  let taskId = '';
  let sourceFolderName = '';

  test('imports multiple same-platform media folders through the configurable E000 source', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/purchases/local-import');
    await expect(page.getByRole('heading', { name: '本地导入图片' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '导入产品', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: '已导入产品清单' })).toBeVisible();
    await expect(page.locator('.local-import-contract')).toContainText('来源目录');
    const rootDirectoryResponse = await page.request.get('/api/v1/local-import/directories?path=');
    expect(rootDirectoryResponse.ok()).toBeTruthy();
    const rootDirectoryPayload = await rootDirectoryResponse.json() as { directories: Array<{ name: string; childDirectoryCount: number; modifiedAt: string }> };
    expect(rootDirectoryPayload.directories.map((item) => item.name)).toEqual(['WB', 'PDD']);
    expect(rootDirectoryPayload.directories.map((item) => item.childDirectoryCount)).toEqual([2, 2]);
    expect(Date.parse(rootDirectoryPayload.directories[0]!.modifiedAt)).toBeGreaterThan(Date.parse(rootDirectoryPayload.directories[1]!.modifiedAt));
    await expect(page.locator('.local-directory-row').filter({ hasText: 'adaptation-diagnostics' })).toHaveCount(0);
    await expect(page.locator('.local-directory-row').filter({ hasText: 'EMPTY-PLATFORM' })).toHaveCount(0);
    const platformHeader = page.locator('.local-directory-header.is-platform-root-header');
    await expect(platformHeader).toContainText('平台文件夹');
    await expect(platformHeader).toContainText('子目录数');
    await expect(platformHeader).toContainText('最后修改时间');
    await expect(platformHeader).toContainText('操作');
    const platformRows = page.locator('.local-directory-row.is-platform-root-row');
    await expect(platformRows.locator('.directory-name')).toHaveText(['WB', 'PDD']);
    await expect(platformRows.locator('.local-directory-child-count')).toHaveText(['2', '2']);
    await expect(platformRows.locator('.local-directory-modified-at').first()).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    await expect(platformRows.getByRole('checkbox')).toHaveCount(0);
    await expect(platformRows.getByRole('button', { name: '导入产品媒体' })).toHaveCount(2);
    await page.setViewportSize({ width: 320, height: 760 });
    await expect(platformHeader).toBeHidden();
    await expect(platformRows.first().locator('.local-directory-child-count')).toHaveAttribute('data-label', '子目录数');
    await expect(platformRows.first().locator('.local-directory-modified-at')).toHaveAttribute('data-label', '最后修改时间');
    await expect(platformRows.first().getByRole('button', { name: '导入产品媒体' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await platformRows.filter({ hasText: 'PDD' }).getByRole('button', { name: '导入产品媒体' }).click();
    const directoryHeader = page.locator('.local-directory-header.is-product-media-header');
    await expect(directoryHeader).toContainText('变体目录');
    await expect(directoryHeader).toContainText('创建日期');
    await expect(directoryHeader).toContainText('平台来源');
    await expect(directoryHeader).toContainText('操作');
    const directoryResponse = await page.request.get('/api/v1/local-import/directories?path=PDD');
    expect(directoryResponse.ok()).toBeTruthy();
    const directoryPayload = await directoryResponse.json() as { directories: Array<{ name: string; createdAt: string }> };
    expect(directoryPayload.directories.map((item) => item.name)).toEqual(['E2E蓝色', 'E2E红色']);
    expect(directoryPayload.directories.every((item) => !Number.isNaN(Date.parse(item.createdAt)))).toBe(true);
    const mediaRows = page.locator('.local-directory-row.is-product-media-row');
    await expect(mediaRows.locator('.directory-name')).toHaveText(['E2E蓝色', 'E2E红色']);
    await expect(mediaRows.locator('.local-directory-created-at').first()).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    await expect(mediaRows.locator('.local-directory-platform').first()).toContainText('PDD');
    await page.setViewportSize({ width: 320, height: 760 });
    await expect(directoryHeader).toBeHidden();
    await expect(mediaRows.first().getByRole('button', { name: '打开' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('checkbox', { name: '选择 PDD/E2E红色' }).check();
    await page.getByRole('checkbox', { name: '选择 PDD/E2E蓝色' }).check();
    await expect(page.getByText('已选 2 个目录')).toBeVisible();
    await expect(page.locator('.primary-directory .ant-select-selection-item')).toHaveText('PDD/E2E红色');
    await page.getByRole('button', { name: '预览并编辑' }).click();
    await expect(page.getByText('预览采购与媒体信息')).toBeVisible();
    await expect(page.locator('.local-source-summary')).toContainText('productInformation-sku.json');
    await expect(page.locator('.local-import-workflow-label')).toContainText('本地导入-PDD');
    await expect(page.locator('.local-import-workflow-label')).toContainText('不创建下载任务');
    await expect(page.getByLabel('产品名称')).toHaveValue('E2E本地导入包');
    await expect(page.getByLabel('商品 URL')).toHaveValue('https://example.com/e2e-local-import');
    await expect(page.getByLabel('零售价格(RUB)')).toHaveValue('');
    await expect(page.getByLabel('零售价格(RUB)')).toHaveAttribute('readonly', '');
    await expect(page.getByLabel('汇率')).toHaveValue('不适用或未提供');
    await expect(page.getByLabel('国内采购价(CNY)')).toHaveValue('39.8');
    await page.setViewportSize({ width: 320, height: 760 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.getByRole('button', { name: '确认导入' }).click();
    const success = page.locator('.local-import-result');
    await expect(success).toContainText('已导入');
    const text = await success.textContent();
    sku = text?.match(/内部 SKU (\d{7})/)?.[1] || '';
    expect(sku).toMatch(/^\d{7}$/);

    const purchase = await page.request.get(`/api/v1/purchases/${sku}`);
    expect(purchase.ok()).toBeTruthy();
    const detail = (await purchase.json()).purchase;
    expect(detail.procurementVersions[0]).toMatchObject({ providerUrl: 'https://example.com/e2e-local-import', purchasePrice: '39.8000', retailPrice: null, currency: 'CNY' });
    expect(detail.procurementVersions[0].downloadWorkflowCode).toBeNull();
    expect(detail.downloadJobs).toEqual([]);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: '查看该产品' }).click();
    await expect(page).toHaveURL(new RegExp(`/purchases/local-import\\?.*view=history.*query=${sku}`));
    await expect(page.getByRole('tab', { name: '已导入产品清单', exact: true })).toHaveAttribute('aria-selected', 'true');
    const row = page.locator('.ant-table-row').filter({ hasText: sku });
    await expect(row).toContainText('本地导入-PDD');
    await expect(row).toContainText('已导入');

    await page.getByLabel('来源平台').first().click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').filter({ hasText: 'PDD' }).click();
    await page.getByLabel('导入状态').first().click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').filter({ hasText: '已导入' }).click();
    await page.getByLabel('导入日期').first().click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').filter({ hasText: '当天' }).click();
    await expect(page).toHaveURL(/platform=PDD/);
    await expect(page).toHaveURL(/status=IMPORTED/);
    await expect(page).toHaveURL(/datePreset=TODAY/);
    await page.reload();
    await expect(page.getByLabel('来源平台').first()).toContainText('PDD');
    await expect(page.getByLabel('导入状态').first()).toContainText('已导入');
    await expect(page.getByLabel('导入日期').first()).toContainText('当天');

    const filteredRow = page.locator('.ant-table-row').filter({ hasText: sku });
    await filteredRow.getByRole('button', { name: /详情/ }).click();
    const detailDrawer = page.getByRole('dialog').filter({ hasText: '本地导入详情' });
    await expect(detailDrawer).toContainText('当前采购信息');
    await expect(detailDrawer).toContainText('导入来源信息');
    await expect(detailDrawer).toContainText('PDD/E2E红色');
    await detailDrawer.getByRole('button', { name: 'Close' }).click();

    await filteredRow.getByRole('button', { name: /编辑/ }).click();
    const editDrawer = page.getByRole('dialog').filter({ hasText: `编辑采购信息 · ${sku}` });
    await expect(editDrawer).toContainText('不会重新复制媒体或启动 n8n');
    await editDrawer.getByLabel('产品名称').fill('E2E本地导入包-已编辑');
    await editDrawer.getByLabel('零售价格(RUB)').fill('88');
    await expect(editDrawer.getByLabel('国内采购价(CNY)')).toHaveValue('39.8000');
    await editDrawer.getByRole('button', { name: '保存采购信息' }).click();
    await expect(page.getByText('采购信息已保存，新版本已创建')).toBeVisible();
    await expect(filteredRow).toContainText('E2E本地导入包-已编辑');

    const updatedPurchase = await page.request.get(`/api/v1/purchases/${sku}`);
    const updatedDetail = (await updatedPurchase.json()).purchase;
    expect(updatedDetail.procurementVersions).toHaveLength(2);
    expect(updatedDetail.procurementVersions[0].downloadWorkflowCode).toBeNull();
    expect(updatedDetail.procurementVersions[0]).toMatchObject({ purchasePrice: '39.8000', retailPrice: '88.0000', currency: 'CNY' });
    expect(updatedDetail.procurementVersions[1]).toMatchObject({ purchasePrice: '39.8000', retailPrice: null, currency: 'CNY' });
    expect(updatedDetail.downloadJobs).toEqual([]);

    const sharedListResponse = await page.request.get(`/api/v1/purchases?page=1&pageSize=50&query=${sku}`);
    expect(sharedListResponse.ok()).toBeTruthy();
    expect((await sharedListResponse.json()).items).toEqual([expect.objectContaining({ sku })]);
    const urlDownloadListResponse = await page.request.get(`/api/v1/purchases?page=1&pageSize=50&query=${sku}&source=URL_DOWNLOAD`);
    expect(urlDownloadListResponse.ok()).toBeTruthy();
    expect(await urlDownloadListResponse.json()).toMatchObject({ items: [], total: 0 });

    await page.goto(`/purchases/url-download?query=${sku}`);
    await expect(page.getByRole('heading', { name: '产品URL下载' })).toBeVisible();
    await expect(page.locator('.ant-table-row').filter({ hasText: sku })).toHaveCount(0);
    await page.goto(`/purchases/local-import?view=history&query=${sku}`);
    await expect(page.locator('.ant-table-row').filter({ hasText: sku })).toContainText('本地导入-PDD');
  });

  test('converts RUB retail price with Exchange and requires manual CNY price when Exchange is missing', async ({ page }) => {
    await page.goto('/purchases/local-import');
    await page.locator('.local-directory-row.is-platform-root-row').filter({ hasText: 'WB' }).getByRole('button', { name: '导入产品媒体' }).click();
    await page.getByRole('checkbox', { name: '选择 WB/E2E汇率' }).check();
    await page.getByRole('button', { name: '预览并编辑' }).click();
    await expect(page.getByLabel('零售价格(RUB)')).toHaveValue('1384');
    await expect(page.getByLabel('零售价格(RUB)')).toHaveAttribute('readonly', '');
    await expect(page.getByRole('textbox', { name: '汇率', exact: true })).toHaveValue('1 CNY = 12 RUB');
    await expect(page.getByLabel('国内采购价(CNY)')).toHaveValue('115.3333');
    await page.getByLabel('国内采购价(CNY)').fill('120.25');
    await expect(page.getByRole('button', { name: '确认导入' })).toBeEnabled();
    await page.setViewportSize({ width: 320, height: 760 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);

    await page.getByRole('button', { name: '返回选择' }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('checkbox', { name: '选择 WB/E2E汇率' }).uncheck();
    await page.getByRole('checkbox', { name: '选择 WB/E2E缺少汇率' }).check();
    await page.getByRole('button', { name: '预览并编辑' }).click();
    await expect(page.getByLabel('零售价格(RUB)')).toHaveValue('1200');
    await expect(page.getByRole('textbox', { name: '汇率', exact: true })).toHaveValue('不适用或未提供');
    await expect(page.getByLabel('国内采购价(CNY)')).toHaveValue('');
    await expect(page.getByText('缺少 Exchange，无法自动换算')).toBeVisible();
    await expect(page.getByText('系统不会使用默认汇率。请手动填写国内采购价(CNY)，有效后才能确认导入。')).toBeVisible();
    await expect(page.getByRole('button', { name: '确认导入' })).toBeDisabled();
    await page.getByLabel('国内采购价(CNY)').fill('100');
    await expect(page.getByRole('button', { name: '确认导入' })).toBeEnabled();
  });

  test('keeps a legacy RUB version unchanged and requires a new CNY purchase price when edited', async ({ page }) => {
    const listResponse = await page.request.get('/api/v1/local-import/imports?page=1&pageSize=10&query=E2E%E5%8E%86%E5%8F%B2RUB%E6%9C%AC%E5%9C%B0%E5%AF%BC%E5%85%A5');
    expect(listResponse.ok()).toBeTruthy();
    const legacyRecord = (await listResponse.json()).items[0] as { sku: string };
    expect(legacyRecord.sku).toMatch(/^\d{7}$/);

    await page.goto(`/purchases/local-import?view=history&query=${legacyRecord.sku}`);
    const row = page.locator('.ant-table-row').filter({ hasText: legacyRecord.sku });
    await expect(row).toContainText('历史采购价 RUB 1384.00');
    await expect(row).toContainText('旧版本保留原币种');
    await row.getByRole('button', { name: /详情/ }).click();
    const detailDrawer = page.getByRole('dialog').filter({ hasText: '本地导入详情' });
    await expect(detailDrawer).toContainText('这是旧版 RUB 采购数据');
    await expect(detailDrawer).toContainText('RUB 1384.00');
    await detailDrawer.getByRole('button', { name: 'Close' }).click();

    await row.getByRole('button', { name: /编辑/ }).click();
    const editDrawer = page.getByRole('dialog').filter({ hasText: `编辑采购信息 · ${legacyRecord.sku}` });
    await expect(editDrawer).toContainText('旧 RUB 版本将转换为新的 CNY 采购版本');
    await expect(editDrawer.getByLabel('零售价格(RUB)')).toHaveValue('1384.0000');
    await expect(editDrawer.getByLabel('国内采购价(CNY)')).toHaveValue('');
    await expect(editDrawer.getByRole('button', { name: '保存采购信息' })).toBeEnabled();
    await editDrawer.getByRole('button', { name: '保存采购信息' }).click();
    await expect(editDrawer.getByText('请输入国内采购价')).toBeVisible();
    await editDrawer.getByLabel('国内采购价(CNY)').fill('115.3333');
    await editDrawer.getByRole('button', { name: '保存采购信息' }).click();
    await expect(page.getByText('采购信息已保存，新版本已创建')).toBeVisible();

    const purchaseResponse = await page.request.get(`/api/v1/purchases/${legacyRecord.sku}`);
    const versions = (await purchaseResponse.json()).purchase.procurementVersions;
    expect(versions[0]).toMatchObject({ versionNo: 2, purchasePrice: '115.3333', retailPrice: '1384.0000', currency: 'CNY' });
    expect(versions[1]).toMatchObject({ versionNo: 1, purchasePrice: '1384.0000', retailPrice: null, currency: 'RUB' });
  });

  test('reviews E000 in table mode and creates an exact ordered E001 package', async ({ page }) => {
    await page.goto('/review/E000');
    await expect(page.getByRole('radio', { name: '表格' })).toBeChecked();
    const tasks = await page.request.get('/api/v1/stages/E000/tasks?page=1&pageSize=24&sort=time&order=desc');
    const imported = (await tasks.json()).items.find((item: { sourceFolderName: string }) => item.sourceFolderName.startsWith(`${sku}-`));
    expect(imported).toBeTruthy();
    taskId = imported.taskId;
    sourceFolderName = imported.sourceFolderName;
    const taskResponse = await page.request.get(`/api/v1/tasks/${taskId}`);
    const task = await taskResponse.json();
    expect(task.productIdentity).toMatchObject({ status: 'RESOLVED', sku, productName: 'E2E本地导入包-已编辑', source: 'TASK_CONTEXT' });
    const selected = [
      task.images.find((item: { relativePath: string }) => item.relativePath.includes('E2E蓝色/详情图/image.png')).relativePath,
      task.images.find((item: { relativePath: string }) => item.relativePath.includes('E2E红色/主图/image.png')).relativePath
    ];
    expect(task.images.some((item: { relativePath: string }) => item.relativePath.includes('not-selected.png'))).toBe(true);
    const approved = await page.request.post(`/api/v1/tasks/${taskId}/approve`, { data: { selectedRelativePaths: selected, targetStageIds: ['E001'] } });
    expect(approved.ok(), await approved.text()).toBeTruthy();
    const pendingResponse = await page.request.get('/api/v1/pending-submissions');
    const pending = (await pendingResponse.json()).items.find((item: { taskId: string }) => item.taskId === taskId);
    expect(pending).toBeTruthy();
    expect(pending.selectedRelativePaths).toEqual(selected);
    const submit = await page.request.post('/api/v1/submissions/batch', { data: { batchId: `e000-${Date.now()}`, pendingSubmissionIds: [pending.id], conflictPolicy: 'fail' } });
    expect(submit.ok()).toBeTruthy();
    expect((await submit.json()).results[0].status).toBe('SUCCESS');

    const targetRoot = path.resolve('.e2e-data', 'roots', 'E001', 'input');
    const targetName = (await readdir(targetRoot)).find((name) => name.startsWith(`${sourceFolderName}-已经审核`));
    expect(targetName).toBeTruthy();
    const target = path.join(targetRoot, targetName!);
    const files = await readdir(target);
    const parameterName = files.find((name) => /^n8n_setParameter_E001_SUB-\d{14}-[a-f0-9]{8}\.json$/.test(name));
    expect(parameterName).toBeTruthy();
    expect(files).toEqual(expect.arrayContaining(['task-context.json', 'selection-manifest.json', 'handoff.json', '_READY.json']));
    const imageFiles = files.filter((name) => name.endsWith('.png'));
    expect(imageFiles).toHaveLength(2);
    expect(imageFiles[0]).toContain('__');
    expect(files.some((name) => name.includes('not-selected'))).toBe(false);
    const manifest = JSON.parse(await readFile(path.join(target, 'selection-manifest.json'), 'utf8'));
    expect(manifest.selectedFiles.map((item: { sourceRelativePath: string }) => item.sourceRelativePath)).toEqual(selected);
    const parameters = JSON.parse(await readFile(path.join(target, parameterName!), 'utf8'));
    expect(parameters).toMatchObject({ SKU: sku, productName: 'E2E本地导入包-已编辑' });
    expect(parameters).toHaveProperty('downloadFatherFolder');
    expect(JSON.parse(await readFile(path.join(target, '_READY.json'), 'utf8'))).toMatchObject({ ready: true, sourceStageId: 'E000', targetStageId: 'E001', imageCount: 2 });
    const archive = path.resolve('.e2e-data', 'roots', 'E000', 'archive', targetName!);
    expect((await stat(archive)).isDirectory()).toBe(true);
  });
});
