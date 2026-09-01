import { expect, test, type Page } from '@playwright/test';

const recordedAt = '2026-08-31T08:15:00.000Z';
const localFolder = 'F:\\采购素材\\E000\\0000162-休闲百搭斜挎包';
const recordedPddUrl = 'https://mobile.yangkeduo.com/goods.html?goods_id=744279810472&_oak_rcto=YWLIj0YF-r4bXgRGk8JiJHm2_C_KbSK_qAUMFq7NvhrNwgoYROT3MC0P&_oc_trace_mark=199&_oc_adinfo=eyJwYWdlX3NuIjoxMDAyOCwic2NlbmVfaWQiOjR9&_oak_gallery_token=28ec92fac59d1bf8ceac88b8f5421ab4&_oak_gallery=https%3A%2F%2Fimg.pddpic.com%2Fmms-material-img%2F2025-05-08%2Ff977a8d8-fbe6-48d5-81c6-b52927f6cb5e.jpeg&_oc_refer_ad=1&page_from=205&thumb_url=https%3A%2F%2Fimg.pddpic.com%2Fmms-material-img%2F2025-05-08%2Ff977a8d8-fbe6-48d5-81c6-b52927f6cb5e.jpeg%3FimageMogr2%2Fthumbnail%2F400x%257CimageView2%2F2%2Fw%2F400%2Fq%2F80&refer_page_name=opt&refer_page_id=10028_1788168285865_8ngcf07f2o&refer_page_sn=10028&uin=TNHGCRQT22VZQNT6RCHZOO22D4_GEXDA';
const baseProcurement = {
  versionNo: 1, purchasePrice: '28.5000', retailPrice: '342.0000', courierFee: '2.0000', currency: 'CNY',
  grossWeightGrams: '620.000', lengthCm: '30.000', widthCm: '15.000', heightCm: '10.000',
  netWeightGrams: '550.000', productHeightCm: '30.000', productDepthCm: '15.000', productWidthCm: '39.000',
  createdAt: recordedAt
};
const localProduct = {
  sku: '0000162', productName: '休闲百搭斜挎包', variants: ['黑色', '米白色'], createdAt: recordedAt, updatedAt: recordedAt,
  procurement: { ...baseProcurement, id: 'pv-local', providerUrl: recordedPddUrl },
  entryOrigin: { methodKey: 'LOCAL_IMAGE_IMPORT:PDD', label: '本地图片导入-PDD', platform: 'PDD', sourceType: 'LOCAL_IMPORT', sourceId: 'local-import-162', recordedAt },
  localMediaFolder: localFolder
};
const urlProduct = {
  sku: '0000163', productName: '通勤托特包', variants: ['棕色'], createdAt: recordedAt, updatedAt: recordedAt,
  procurement: { ...baseProcurement, id: 'pv-url', downloadWorkflowCode: 'E006', providerUrl: 'https://mobile.yangkeduo.com/goods.html?goods_id=163' },
  entryOrigin: { methodKey: 'URL_DOWNLOAD:E006', label: 'PDD下载E006', platform: 'PDD', workflowCode: 'E006', sourceType: 'URL_DOWNLOAD', sourceId: 'pv-url', recordedAt }
};
const futureProduct = {
  sku: '0000164', productName: '未来来源产品', variants: ['默认变体'], createdAt: recordedAt, updatedAt: recordedAt,
  procurement: { ...baseProcurement, id: 'pv-future', providerUrl: 'https://example.com/future/164' },
  entryOrigin: { methodKey: 'OTHER:FUTURE', label: '未来系统导入', sourceType: 'OTHER', sourceId: 'future-164', recordedAt }
};
const products = [localProduct, urlProduct, futureProduct];

test.describe('采购商品查询', () => {
  test.beforeEach(async ({ context, page }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:4183' });
    await mockQueryDependencies(page);
  });

  test('展示固定列、动态筛选、链接与逐项复制，并把宽表限制在表格内部', async ({ page }) => {
    const requests: URL[] = [];
    await page.route(/\/api\/v1\/purchases\?.*/, async (route) => {
      requests.push(new URL(route.request().url()));
      await route.fulfill({ json: purchaseListResponse() });
    });
    await page.goto('/purchases/query');

    await expect(page.getByRole('heading', { name: '采购商品查询' })).toBeVisible();
    await expect(page.locator('.purchase-product-query-page .filter-bar')).toBeVisible();
    await expect(page.locator('.purchase-product-query-page .purchase-table-card')).toBeVisible();
    await expect(page.locator('.purchase-table-card thead th')).toHaveText([
      'SKU', '产品与采购摘要', '录入方式', '导入平台', '产品URL', '本地媒体文件夹', '录入日期', '操作'
    ]);

    const localRow = page.locator('.purchase-table-card tbody tr').filter({ hasText: localProduct.sku });
    await expect(localRow).toContainText('休闲百搭斜挎包');
    await expect(localRow).toContainText('本地图片导入-PDD');
    await expect(localRow).toContainText('产品：高 30 × 深 15 × 宽 39 cm · 净重 550 g');
    const productLink = localRow.getByRole('link');
    await expect(productLink).toHaveAttribute('href', localProduct.procurement.providerUrl);
    await expect(productLink).toHaveAttribute('target', '_blank');

    await localRow.getByRole('button', { name: `复制SKU：${localProduct.sku}` }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(localProduct.sku);
    await localRow.getByRole('button', { name: `复制本地媒体文件夹：${localFolder}` }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(localFolder);
    await expect(page.locator('.purchase-table-card tbody')).toContainText('尚未生成');

    const searchInput = page.getByRole('textbox', { name: 'SKU、产品名或产品URL' });
    await expect(searchInput).toHaveAttribute('placeholder', '搜索 SKU、产品名或产品URL');
    await searchInput.fill('0000162');
    await expect.poll(() => requests.some((url) => url.searchParams.get('query') === '0000162')).toBe(true);
    await searchInput.fill(recordedPddUrl);
    await expect.poll(() => requests.some((url) => url.searchParams.get('query') === recordedPddUrl)).toBe(true);
    await expect(localRow).toContainText(localProduct.sku);
    await page.getByRole('combobox', { name: '录入方式' }).click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '本地图片导入-PDD' }).click();
    await expect.poll(() => requests.some((url) => url.searchParams.get('entryMethodKey') === 'LOCAL_IMAGE_IMPORT:PDD')).toBe(true);
    await page.locator('.purchase-product-query-page .filter-bar .ant-select').first().click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '昨天' }).click();
    await expect.poll(() => requests.some((url) => url.searchParams.has('createdFrom') && url.searchParams.has('createdTo'))).toBe(true);
    expect(requests.every((url) => url.searchParams.get('sort') === 'RECORDED_DESC')).toBe(true);

    await page.setViewportSize({ width: 320, height: 720 });
    await page.reload();
    await expect(page.getByRole('heading', { name: '采购商品查询' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.locator('.purchase-table-card .ant-table-content').evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  });

  test('按来源复用详情和编辑入口，未来来源禁用编辑', async ({ page }) => {
    const patched: string[] = [];
    await page.route(/\/api\/v1\/purchases\?.*/, (route) => route.fulfill({ json: purchaseListResponse() }));
    await page.route('**/api/v1/local-import/imports/local-import-162', (route) => route.fulfill({ json: { import: localImportRecord() } }));
    await page.route('**/api/v1/local-import/imports/local-import-162/purchase', async (route) => {
      patched.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      await route.fulfill({ json: { import: localImportRecord() } });
    });
    await page.route('**/api/v1/purchases/0000163', async (route) => {
      if (route.request().method() === 'PATCH') {
        patched.push(`PATCH ${new URL(route.request().url()).pathname}`);
        await route.fulfill({ json: { purchase: purchaseDetail(urlProduct) } });
      } else {
        await route.fulfill({ json: { purchase: purchaseDetail(urlProduct) } });
      }
    });
    await page.goto('/purchases/query');

    const localRow = page.locator('.purchase-table-card tbody tr').filter({ hasText: localProduct.sku });
    await localRow.getByRole('button', { name: '详情' }).click();
    await expect(page.getByText('当前采购信息', { exact: true })).toBeVisible();
    await expect(page.getByText('本地图片导入-PDD', { exact: true }).last()).toBeVisible();
    await expect(page.getByRole('button', { name: '重试媒体复制' })).toHaveCount(0);
    await page.locator('.ant-drawer:visible .ant-drawer-close').click();

    await localRow.getByRole('button', { name: '编辑' }).click();
    await expect(page.getByText(`编辑采购信息 · ${localProduct.sku}`)).toBeVisible();
    await page.locator('.ant-drawer:visible').getByLabel('产品名称').fill('休闲百搭斜挎包-已编辑');
    await page.locator('.ant-drawer:visible').getByRole('button', { name: '保存采购信息' }).click();
    await expect.poll(() => patched).toContain(`PATCH /api/v1/local-import/imports/local-import-162/purchase`);

    const urlRow = page.locator('.purchase-table-card tbody tr').filter({ hasText: urlProduct.sku });
    await urlRow.getByRole('button', { name: '详情' }).click();
    await expect(page.getByText('录入来源', { exact: true })).toBeVisible();
    await expect(page.getByText('PDD下载E006', { exact: true }).last()).toBeVisible();
    await page.locator('.ant-drawer:visible .ant-drawer-close').click();
    await urlRow.getByRole('button', { name: '编辑' }).click();
    await expect(page.getByText(`编辑采购产品 · ${urlProduct.sku}`)).toBeVisible();
    await page.locator('.ant-drawer:visible').getByRole('button', { name: '保存采购信息' }).click();
    await expect.poll(() => patched).toContain(`PATCH /api/v1/purchases/${urlProduct.sku}`);

    const futureRow = page.locator('.purchase-table-card tbody tr').filter({ hasText: futureProduct.sku });
    await expect(futureRow.getByRole('button', { name: '编辑' })).toBeDisabled();
    await futureRow.getByRole('button', { name: '编辑' }).locator('..').hover();
    await expect(page.getByRole('tooltip')).toContainText('该录入方式暂未注册编辑入口');
  });
});

async function mockQueryDependencies(page: Page) {
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: { config: { stages: [] }, readiness: { complete: true, paths: [] } } }));
  await page.route('**/api/v1/download-workflows?*', (route) => route.fulfill({ json: { items: [{
    code: 'E006', displayName: 'PDD下载E006', webhookUrl: 'http://127.0.0.1:5678/webhook/e006',
    parentOutputDir: 'F:\\采购素材', timeoutMs: 900000, enabled: true, isDefault: true, recoveryMode: 'MANUAL', createdAt: recordedAt, updatedAt: recordedAt
  }] } }));
}

function purchaseListResponse() {
  return {
    items: products, total: products.length, page: 1, pageSize: 50,
    facets: { entryMethods: [
      { value: 'LOCAL_IMAGE_IMPORT:PDD', label: '本地图片导入-PDD', platform: 'PDD', sourceType: 'LOCAL_IMPORT', count: 1 },
      { value: 'URL_DOWNLOAD:E006', label: 'PDD下载E006', platform: 'PDD', workflowCode: 'E006', sourceType: 'URL_DOWNLOAD', count: 1 },
      { value: 'OTHER:FUTURE', label: '未来系统导入', sourceType: 'OTHER', count: 1 }
    ] }
  };
}

function localImportRecord() {
  return {
    id: 'local-import-162', idempotencyKey: 'query-local-162', sku: localProduct.sku, status: 'IMPORTED',
    sourcePlatform: 'PDD', importWorkflowLabel: '本地导入-PDD', previewHash: 'a'.repeat(64), retryCount: 0,
    targetFolder: localFolder, createdAt: recordedAt, updatedAt: recordedAt, completedAt: recordedAt,
    purchase: { sku: localProduct.sku, productName: localProduct.productName, variants: localProduct.variants, createdAt: recordedAt, updatedAt: recordedAt, procurement: localProduct.procurement },
    sources: [{
      id: 'source-162', platform: 'PDD', relativePath: 'PDD/0000162', normalizedPathKey: 'pdd/0000162', isPrimary: true,
      externalSku: 'pdd-162', informationFileRelativePath: 'productInformation-sku.json', informationFileSha256: 'b'.repeat(64),
      providerUrl: localProduct.procurement.providerUrl, targetSubdirectory: '黑色', copyManifest: { files: [] }
    }]
  };
}

function purchaseDetail(product: typeof urlProduct) {
  return {
    sku: product.sku, productName: product.productName, variants: product.variants, createdAt: product.createdAt, updatedAt: product.updatedAt,
    procurementVersions: [product.procurement], downloadJobs: []
  };
}
