import { expect, test } from '@playwright/test';
import dayjs from 'dayjs';

const BLACK_COLOR_KEY = '1'.repeat(64);
const WHITE_COLOR_KEY = '2'.repeat(64);

const categorySummary = {
  categoryKey: 'adult_casual_sneakers', nameRu: 'Кроссовки', nameZh: '休闲运动鞋', subjectId: 105, active: true,
  createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z',
  publishedVersion: { id: 'cat-v1', versionNo: 2, nameRu: 'Кроссовки', nameZh: '休闲运动鞋', schemaHash: 'sha256:test', confirmedBy: 'QA', confirmedAt: '2026-07-15T00:00:00.000Z', publishedAt: '2026-07-15T00:00:00.000Z' },
  projection: { status: 'SYNCED', sourceVersionId: 'cat-v1', definitionHash: 'sha256:test', syncedAt: '2026-07-15T00:00:00.000Z' }
};

const readyCatalog = {
  status: 'READY', subjectCount: 4321, parentCount: 26, colorCount: 939,
  dictionaryCounts: { countries: 236, seasons: 4, kinds: 5, colors: 939 },
  lastSuccessfulAt: '2026-07-13T02:04:00.000Z',
  nextScheduledAt: '2026-07-20T02:00:00.000Z'
};

const mediaAssets = [
  { assetId: 'img-01', relativePath: 'variants/红色/images/submission-a/01.png', kind: 'IMAGE', mimeType: 'image/png', sizeBytes: 1024, sha256: 'a', modifiedAt: '2026-07-15T00:00:00.000Z', productVariantId: '11111111-1111-4111-8111-111111111111', productVariantName: '红色', sourceStageId: 'E005', sourceSubmissionId: 'submission-a' },
  { assetId: 'img-02', relativePath: 'variants/02.png', kind: 'IMAGE', mimeType: 'image/png', sizeBytes: 2048, sha256: 'b', modifiedAt: '2026-07-15T00:00:00.000Z' },
  { assetId: 'video-01', relativePath: 'variants/红色/videos/submission-b/main.mp4', kind: 'VIDEO', mimeType: 'video/mp4', sizeBytes: 4096, sha256: 'c', modifiedAt: '2026-07-15T00:00:00.000Z', productVariantId: '11111111-1111-4111-8111-111111111111', productVariantName: '红色', sourceStageId: 'E004', sourceSubmissionId: 'submission-b' }
];

const baseListing = {
  sku: '0000010', productName: 'E2E WB 产品', status: 'DRAFT', draftVersion: 1, revision: 1,
  categoryKey: 'adult_casual_sneakers', categoryVersionId: 'cat-v1', brand: '', titleRu: 'Женские кроссовки', descriptionRu: 'Первый абзац\\n\\nВторой абзац',
  packaging: {}, priceCny: 100, discountPercent: 10, clubDiscount: null, compliance: { tnved: '6404110000', kizMarked: true },
  sharedCharacteristics: [{ id: 204557, value: ['Женский'] }],
  purchaseMeasurements: {
    procurementVersionId: '77777777-7777-4777-8777-777777777777',
    procurementVersionNo: 7,
    capturedAt: '2026-07-15T00:00:00.000Z',
    productHeightCm: 30,
    productDepthCm: null,
    productWidthCm: 39,
    netWeightGrams: 550
  },
  variants: [
    { variantId: 'variant-black', variantCode: '0000010-BLACK', vendorCode: '0000010-BLACK', characteristics: [{ id: 14177449, value: ['Черный'] }], sizes: [] },
    { variantId: 'variant-white', variantCode: '0000010-WHITE', vendorCode: '0000010-WHITE', characteristics: [{ id: 14177449, value: ['Белый'] }], sizes: [] }
  ],
  mediaAssets,
  variantMedia: [
    { variantId: 'variant-black', imageAssetIds: [] },
    { variantId: 'variant-white', imageAssetIds: [] }
  ]
};

function manualPublication(patch: Record<string, unknown> = {}) {
  return {
    id: 'publication-main', sku: '0000010', generatedVersionId: 'generated-main', revision: 1,
    storeId: 'store-main', storeAlias: 'main', storeDisplayName: 'WB 主店铺', status: 'SUCCEEDED', source: 'MANUAL',
    taskId: 'main__0000010__r1', planHash: `sha256:${'a'.repeat(64)}`,
    presetId: 'preset-main', presetName: '主店稳定上品预设', presetRowVersion: 3,
    operationMode: 'CREATE_ONLY', draftVersion: 1, sourcePresetExists: true,
    configSnapshot: { draftVersion: 1, planStoreIds: ['store-main'] }, nmIds: [], productUrls: [], productLinks: [],
    result: {}, rowVersion: 1, createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:01:00.000Z',
    ...patch
  };
}

function wbStore(patch: Record<string, unknown> = {}) {
  return {
    id: 'store-main',
    storeAlias: 'main',
    displayName: 'WB 主店铺',
    enabled: true,
    autoPublishEnabled: true,
    autoPublishMode: 'CREATE_ONLY',
    defaultPresetId: 'preset-main',
    warehouseId: '1701558',
    warehouseName: 'CEL_深圳_Activated',
    accountCurrency: 'CNY',
    maxDailyStyles: 100,
    credential: { state: 'ACTIVE', configured: true, fingerprint: 'wb_•••1234' },
    seller: { id: 'seller-main', name: '主账号' },
    permissions: ['content', 'prices', 'marketplace'],
    preflight: { status: 'PASSED', checkedAt: '2026-08-10T00:00:00.000Z' },
    network: { status: 'READY' },
    readiness: { ready: true, blockers: [] },
    activeTaskCount: 0,
    queuedTaskCount: 0,
    configVersion: 1,
    rowVersion: 1,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    ...patch
  };
}

async function mockWbStoreSettingsApis(page: import('@playwright/test').Page, items: ReturnType<typeof wbStore>[]) {
  let storeRequestCount = 0;
  await page.route(/\/api\/v1\/wb\/settings$/, async (route) => route.fulfill({ json: { settings: {
    enabled: true,
    rootDirectory: 'D:\\MerchRoute-WB',
    timezone: 'Asia/Shanghai',
    globalConcurrency: 2,
    perStoreConcurrency: 1,
    rowVersion: 1,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z'
  } } }));
  await page.route(/\/api\/v1\/wb\/stores$/, async (route) => {
    storeRequestCount += 1;
    await route.fulfill({ json: { items, total: items.length } });
  });
  await page.route(/\/api\/v1\/wb\/presets$/, async (route) => route.fulfill({ json: { items: [
    { id: 'preset-main', name: '主店稳定上品预设', readiness: 'READY' },
    { id: 'preset-second', name: '超长名称的第二店铺俄语定价与分类预设', readiness: 'READY' }
  ] } }));
  return { storeRequestCount: () => storeRequestCount };
}

async function mockWbApis(page: import('@playwright/test').Page) {
  await page.route(/\/api\/v1\/wb\/automation\/status$/, async (route) => route.fulfill({ json: { enabled: false, counts: {}, worker: { running: false } } }));
  await page.route(/\/api\/v1\/wb\/automation\/jobs(?:\?.*)?$/, async (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route(/\/api\/v1\/wb\/catalog\/status$/, async (route) => route.fulfill({ json: { catalog: readyCatalog } }));
  await page.route(/\/api\/v1\/wb\/catalog\/colors\?.*/, async (route) => route.fulfill({ json: { items: [
    { colorKey: BLACK_COLOR_KEY, nameRu: 'Черный', nameZh: '黑色', parentNameRu: 'черный', parentNameZh: '黑色' },
    { colorKey: WHITE_COLOR_KEY, nameRu: 'Белый', nameZh: '白色', parentNameRu: 'белый', parentNameZh: '白色' }
  ], catalog: readyCatalog } }));
  await page.route(/\/api\/v1\/wb\/catalog\/dictionaries\/.+\?.*/, async (route) => {
    const directory = new URL(route.request().url()).pathname.split('/').pop();
    const values: Record<string, any[]> = {
      countries: [{ itemKey: '15000170', wbId: 15000170, nameRu: 'Китай', nameZh: '中国', fullNameRu: 'Китайская Народная Республика', fullNameZh: '' }],
      seasons: [{ itemKey: 'summer', nameRu: 'лето', nameZh: '夏季', fullNameRu: '', fullNameZh: '' }],
      kinds: [{ itemKey: 'female', nameRu: 'Женский', nameZh: '女性', fullNameRu: '', fullNameZh: '' }],
      colors: [
        { itemKey: BLACK_COLOR_KEY, nameRu: 'Черный', nameZh: '黑色', fullNameRu: '', fullNameZh: '', parentNameRu: 'черный', parentNameZh: '黑色' },
        { itemKey: WHITE_COLOR_KEY, nameRu: 'Белый', nameZh: '白色', fullNameRu: '', fullNameZh: '', parentNameRu: 'белый', parentNameZh: '白色' }
      ]
    };
    await route.fulfill({ json: { directory, items: values[directory || ''] || [], catalog: readyCatalog } });
  });
  await page.route(/\/api\/v1\/wb\/categories\/adult_casual_sneakers$/, async (route) => route.fulfill({ json: { category: { ...categorySummary, versions: [{ id: 'cat-v1', versionNo: 2, status: 'PUBLISHED', liveSchema: {}, formConfig: { fields: [
    { fieldId: 'gender', characteristicId: 204557, labelRu: 'Пол', labelZh: '性别', scope: 'shared', control: 'select', required: true, order: 10, directory: 'kinds' },
    { fieldId: 'material', characteristicId: 14177450, labelRu: 'Материал', labelZh: '材质', scope: 'shared', control: 'text', required: false, order: 15 },
    { fieldId: 'country', characteristicId: 14177451, labelRu: 'Страна производства', labelZh: '原产国', scope: 'shared', control: 'select', required: false, order: 16, directory: 'countries' },
    { fieldId: 'season', characteristicId: 14177452, labelRu: 'Сезон', labelZh: '季节', scope: 'shared', control: 'multi-select', required: false, order: 17, directory: 'seasons' },
    { fieldId: 'product-height', characteristicId: 90630, labelRu: 'Высота предмета', labelZh: '物体高度', scope: 'shared', control: 'number', required: false, order: 18 },
    { fieldId: 'product-depth', characteristicId: 90652, labelRu: 'Глубина предмета', labelZh: '物体深度', scope: 'shared', control: 'number', required: false, order: 19 },
    { fieldId: 'product-width', characteristicId: 90673, labelRu: 'Ширина предмета', labelZh: '物体宽度', scope: 'shared', control: 'number', required: false, order: 20 },
    { fieldId: 'net-weight', characteristicId: 89008, labelRu: 'Вес товара без упаковки (г)', labelZh: '无包装重量', scope: 'shared', control: 'number', required: false, order: 21 },
    { fieldId: 'color', characteristicId: 14177449, labelRu: 'Цвет', labelZh: '颜色', scope: 'variant', control: 'select', required: true, order: 20, directory: 'colors' }
  ], media: { minImages: 1, maxImages: 30, videoAllowed: true, defaultVideoUploadMode: 'COMPRESSED_COPY' } }, managedCharacteristicIds: [204557, 14177450, 14177451, 14177452, 90630, 90652, 90673, 89008, 14177449], schemaHash: 'sha256:test', confirmedBy: 'QA', confirmedAt: '2026-07-15T00:00:00.000Z', createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z', publishedAt: '2026-07-15T00:00:00.000Z' }] } } }));
  await page.route(/\/api\/v1\/wb\/categories$/, async (route) => route.fulfill({ json: { items: [categorySummary] } }));
  await page.route(/\/api\/v1\/wb\/listings\/0000010\/media\/.+/, async (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') }));
  await page.route(/\/api\/v1\/wb\/listings\/0000010\/status$/, async (route) => route.fulfill({ json: { listing: baseListing, productVariants: [] } }));
  await page.route(/\/api\/v1\/purchases\/0000010$/, async (route) => route.fulfill({ json: { purchase: {
    sku: '0000010',
    productName: 'E2E WB 产品',
    variants: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    procurementVersions: [{
      id: '77777777-7777-4777-8777-777777777777',
      versionNo: 7,
      purchasePrice: '20',
      courierFee: '0',
      currency: 'CNY',
      productHeightCm: '30.000',
      productDepthCm: null,
      productWidthCm: '39.000',
      netWeightGrams: '550.000',
      providerUrl: 'https://example.com/0000010',
      createdAt: '2026-07-15T00:00:00.000Z'
    }],
    downloadJobs: []
  } } }));
  await page.route(/\/api\/v1\/wb\/listings\/0000010$/, async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      await route.fulfill({ json: { listing: { ...baseListing, ...body, draftVersion: 2, descriptionRu: String(body.descriptionRu).replace(/\r?\n+/g, '\\n\\n'), mediaAssets } } });
    } else await route.fulfill({ json: { listing: baseListing } });
  });
  await page.route(/\/api\/v1\/wb\/publications(?:\?.*)?$/, async (route) => route.fulfill({ json: { items: [manualPublication()], total: 1 } }));
  await page.route(/\/api\/v1\/wb\/listings\?.*/, async (route) => route.fulfill({ json: { items: [baseListing], total: 1, page: 1, pageSize: 100 } }));
}

async function currentReasonTypography(reason: import('@playwright/test').Locator) {
  return reason.evaluate((element) => {
    const layout = getComputedStyle(element);
    const text = getComputedStyle(element.querySelector('span')!);
    return {
      display: layout.display,
      flexDirection: layout.flexDirection,
      gap: layout.gap,
      fontSize: text.fontSize,
      whiteSpace: text.whiteSpace,
      textOverflow: text.textOverflow
    };
  });
}

async function currentPresetTypography(preset: import('@playwright/test').Locator) {
  return preset.evaluate((element) => {
    const layout = getComputedStyle(element);
    const name = getComputedStyle(element.querySelector('strong')!);
    const detail = getComputedStyle(element.querySelector('.ant-typography')!);
    return {
      display: layout.display,
      flexDirection: layout.flexDirection,
      gap: layout.gap,
      nameFontSize: name.fontSize,
      nameFontWeight: name.fontWeight,
      detailFontSize: detail.fontSize,
      whiteSpace: detail.whiteSpace,
      textOverflow: detail.textOverflow
    };
  });
}

test.describe('WB 可视化上品管理', () => {
  test('顶部标题块在桌面端压缩至历史导航高度，并在窄屏自然增高', async ({ page }) => {
    await mockWbApis(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/listing/wb');
    await page.evaluate(() => document.fonts.ready.then(() => true));

    const pageTitle = page.locator('.wb-page-title');
    const description = pageTitle.locator('.wb-page-title-description');
    await expect(pageTitle).toHaveCSS('min-height', '124px');
    await expect(pageTitle).toHaveCSS('padding-top', '8px');
    await expect(pageTitle).toHaveCSS('padding-bottom', '8px');
    await expect(description).toHaveCSS('margin-bottom', '0px');
    await expect(pageTitle.locator('.wb-page-seal')).toBeVisible();
    await expect(pageTitle.getByRole('button', { name: '打开WB上品设置' })).toBeVisible();

    const desktopMetrics = await pageTitle.evaluate((element) => {
      const container = element.getBoundingClientRect();
      const children = Array.from(element.children).map((child) => child.getBoundingClientRect());
      return {
        height: container.height,
        childrenInside: children.every((child) => child.top >= container.top && child.bottom <= container.bottom)
      };
    });
    expect(desktopMetrics.height).toBeGreaterThanOrEqual(123);
    expect(desktopMetrics.height).toBeLessThanOrEqual(126);
    expect(desktopMetrics.childrenInside).toBe(true);

    for (const width of [1024, 800, 760, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(async () => pageTitle.evaluate((element) => {
        const container = element.getBoundingClientRect();
        const children = Array.from(element.children).map((child) => child.getBoundingClientRect());
        return {
          childrenInside: children.every((child) => child.top >= container.top && child.bottom <= container.bottom),
          pageOverflow: document.documentElement.scrollWidth > window.innerWidth
        };
      })).toEqual({ childrenInside: true, pageOverflow: false });
      if (width <= 760) {
        await expect.poll(async () => pageTitle.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(124);
      }
    }
  });

  test('自动上品区域展示统计、可读错误和审计时间线，并支持重新检查与取消', async ({ page }) => {
    await mockWbApis(page);
    const job = {
      sku: '0000021', state: 'NEEDS_ATTENTION', presetId: 'preset-auto', presetName: 'WB 自动上品预设',
      presetRowVersion: 7, presetBoundAt: '2026-07-19T02:00:00.000Z',
      presetDefinitionHash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      sourcePresetExists: false,
      expectedVendorCodes: ['0000021-01', '0000021-02'], attemptCount: 2, nextAttemptAt: '2026-07-19T02:05:00.000Z',
      lastErrorCode: 'MEDIA_VIDEO_AMBIGUOUS', lastErrorMessage: '白色变体存在多个有效视频，请人工选择。',
      createdAt: '2026-07-19T02:00:00.000Z', updatedAt: '2026-07-19T02:03:00.000Z',
      canRecheck: true, canCancel: true, hasListing: true,
      events: [
        { id: 'event-1', eventType: 'MEDIA_DELIVERED', toState: 'WAITING_STABLE', message: 'E004/E005 媒体投递完成', createdAt: '2026-07-19T02:00:00.000Z' },
        { id: 'event-2', eventType: 'READINESS_FAILED', fromState: 'CHECKING', toState: 'NEEDS_ATTENTION', message: '检测到多个视频', details: { variantCode: '0000021-02', videos: 2 }, createdAt: '2026-07-19T02:03:00.000Z' }
      ]
    };
    const successfulJob = {
      sku: '0000138', state: 'SUCCEEDED', presetId: 'preset-auto', presetName: 'WB 自动上品预设',
      productLinks: [
        { nmId: '1279538487', url: 'https://www.wildberries.ru/catalog/1279538487/detail.aspx', variantCode: '0000138-01' },
        { nmId: '1279538488', url: 'https://www.wildberries.ru/catalog/1279538488/detail.aspx', variantCode: '0000138-02' }
      ],
      productUrls: [
        'https://www.wildberries.ru/catalog/1279538487/detail.aspx',
        'https://www.wildberries.ru/catalog/1279538488/detail.aspx',
        'javascript:alert(1)',
        'https://www.wildberries.ru/catalog/1279538488/detail.aspx'
      ],
      createdAt: '2026-07-19T02:10:00.000Z', updatedAt: '2026-07-19T02:16:00.000Z',
      canRecheck: false, canCancel: false, hasListing: true
    };
    const linkPendingJob = {
      sku: '0000023', state: 'SUCCEEDED', presetId: 'preset-auto', presetName: 'WB 自动上品预设',
      productUrls: [], createdAt: '2026-07-19T02:20:00.000Z', updatedAt: '2026-07-19T02:26:00.000Z',
      canRecheck: false, canCancel: false, hasListing: true
    };
    let recheckRequests = 0;
    let cancelRequests = 0;
    await page.unroute(/\/api\/v1\/wb\/automation\/status$/);
    await page.unroute(/\/api\/v1\/wb\/automation\/jobs(?:\?.*)?$/);
    await page.route(/\/api\/v1\/wb\/automation\/status$/, async (route) => route.fulfill({ json: {
      enabled: true,
      acceptingNewJobs: true,
      continuingBoundJobs: 3,
      activePreset: { id: 'preset-auto', name: 'WB 自动上品预设', activatedAt: '2026-07-19T02:00:00.000Z' },
      counts: { WAITING_MEDIA: 1, CHECKING: 2, NEEDS_ATTENTION: 1, SUCCEEDED: 7 },
      worker: { running: true, lastReconciledAt: '2026-07-19T02:03:00.000Z' }
    } }));
    await page.route(/\/api\/v1\/wb\/automation\/jobs\?.*$/, async (route) => route.fulfill({ json: { items: [job, successfulJob, linkPendingJob], total: 3 } }));
    await page.route(/\/api\/v1\/wb\/automation\/jobs\/0000021(?:\/(recheck|cancel))?$/, async (route) => {
      if (route.request().method() === 'POST' && route.request().url().endsWith('/recheck')) recheckRequests += 1;
      if (route.request().method() === 'POST' && route.request().url().endsWith('/cancel')) cancelRequests += 1;
      await route.fulfill({ json: { job } });
    });

    await page.goto('/listing/wb');
    const panel = page.locator('.wb-automation-console');
    await expect(panel.getByText('自动上品任务', { exact: true })).toBeVisible();
    await expect(panel.getByText('正在接收新任务', { exact: true })).toBeVisible();
    await expect(panel.getByText('需人工处理', { exact: true })).toBeVisible();
    await expect(panel.getByText('白色变体存在多个有效视频，请人工选择。', { exact: true })).toBeVisible();
    const attentionRow = panel.getByRole('row').filter({ hasText: '0000021' });
    const successfulRow = panel.getByRole('row').filter({ hasText: '0000138' });
    const linkPendingRow = panel.getByRole('row').filter({ hasText: '0000023' });
    await expect(attentionRow.getByText('—', { exact: true })).toBeVisible();
    const firstProductLink = successfulRow.getByRole('link', { name: '打开 SKU 0000138 的 WB 商品 0000138-01' });
    const secondProductLink = successfulRow.getByRole('link', { name: '打开 SKU 0000138 的 WB 商品 0000138-02' });
    await expect(firstProductLink).toHaveText('0000138-01');
    await expect(secondProductLink).toHaveText('0000138-02');
    await expect(firstProductLink).toHaveAttribute('href', 'https://www.wildberries.ru/catalog/1279538487/detail.aspx');
    await expect(firstProductLink).toHaveAttribute('target', '_blank');
    await expect(secondProductLink).toHaveAttribute('href', 'https://www.wildberries.ru/catalog/1279538488/detail.aspx');
    await expect(successfulRow.getByRole('link')).toHaveCount(2);
    await expect(linkPendingRow.getByText('链接未同步', { exact: true })).toBeVisible();
    await attentionRow.getByRole('button', { name: '查看详情' }).click();

    const drawer = page.locator('.wb-automation-drawer');
    await expect(drawer.getByText('0000021-01', { exact: true })).toBeVisible();
    await expect(drawer.getByText('WB 自动上品预设 · R7', { exact: true })).toBeVisible();
    await expect(drawer.getByText('来源已删除', { exact: true })).toBeVisible();
    await expect(drawer.getByText(/sha256:0123456789abcdef/)).toBeVisible();
    await expect(drawer.getByText('检测到多个视频', { exact: true })).toBeVisible();
    await drawer.getByRole('button', { name: '重新检查' }).click();
    await expect(page.getByText('SKU 0000021 已加入重新检查队列', { exact: true })).toBeVisible();
    expect(recheckRequests).toBe(1);

    await drawer.getByRole('button', { name: '取消自动任务' }).click();
    const confirm = page.getByRole('dialog', { name: '取消 SKU 0000021 的自动上品？' });
    await expect(confirm).toContainText('已经提交到 WB 的任务不能撤回');
    await confirm.getByRole('button', { name: '停止自动推进' }).click();
    await expect(page.getByText('SKU 0000021 的自动推进已取消', { exact: true })).toBeVisible();
    expect(cancelRequests).toBe(1);
  });

  test('自动上品当前说明和绑定预设复用手动资料的字体排版', async ({ page }) => {
    await mockWbApis(page);
    await page.unroute(/\/api\/v1\/wb\/automation\/jobs(?:\?.*)?$/);
    await page.route(/\/api\/v1\/wb\/automation\/jobs(?:\?.*)?$/, async (route) => route.fulfill({ json: { items: [{
      sku: '0000021', storeId: 'store-main', state: 'SUCCEEDED', runNo: 1, baseRevision: 0, targetRevision: 1,
      operationMode: 'CREATE_ONLY', presetId: 'preset-main', presetName: '主店稳定上品预设', presetRowVersion: 3,
      createdAt: '2026-07-19T02:00:00.000Z', updatedAt: '2026-07-19T02:03:00.000Z',
      canRecheck: false, canCancel: false, hasListing: true
    }], total: 1 } }));

    await page.goto('/listing/wb');
    const autoReason = page.locator('.wb-automation-table .wb-current-reason').first();
    await expect(autoReason).toBeVisible();
    await expect(autoReason.locator('span')).toHaveText('该店铺上品已完成');
    await expect(autoReason.locator('small')).toHaveText('公共媒体已在成功上品后清理');
    const autoTypography = await currentReasonTypography(autoReason);
    const autoPresetTypography = await currentPresetTypography(page.locator('.wb-automation-table .wb-current-preset').first());

    await page.getByRole('tab', { name: '手动上品资料' }).click();
    const manualReason = page.locator('.wb-manual-table .wb-current-reason').first();
    await expect(manualReason).toBeVisible();
    const manualTypography = await currentReasonTypography(manualReason);
    const manualPresetTypography = await currentPresetTypography(page.locator('.wb-manual-table .wb-current-preset').first());

    expect(autoTypography).toEqual(manualTypography);
    expect(autoTypography).toEqual({ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '11px', whiteSpace: 'nowrap', textOverflow: 'ellipsis' });
    expect(autoPresetTypography).toEqual(manualPresetTypography);
    expect(autoPresetTypography).toEqual({ display: 'flex', flexDirection: 'column', gap: '2px', nameFontSize: '14px', nameFontWeight: '700', detailFontSize: '9px', whiteSpace: 'nowrap', textOverflow: 'ellipsis' });
  });

  test('双轨导航保存当前视图，自动与手动搜索互不串用', async ({ page }) => {
    await mockWbApis(page);
    const autoQueries: string[] = [];
    const manualQueries: string[] = [];
    const manualSources: string[] = [];
    await page.unroute(/\/api\/v1\/wb\/automation\/jobs(?:\?.*)?$/);
    await page.unroute(/\/api\/v1\/wb\/listings\?.*/);
    await page.route(/\/api\/v1\/wb\/automation\/jobs(?:\?.*)?$/, async (route) => {
      autoQueries.push(new URL(route.request().url()).searchParams.get('query') || '');
      await route.fulfill({ json: { items: [], total: 0 } });
    });
    await page.route(/\/api\/v1\/wb\/listings\?.*/, async (route) => {
      const params = new URL(route.request().url()).searchParams;
      manualQueries.push(params.get('query') || '');
      manualSources.push(params.get('source') || '');
      await route.fulfill({ json: { items: [baseListing], total: 1, page: 1, pageSize: 100 } });
    });

    await page.goto('/listing/wb?view=unknown');
    await expect(page.getByRole('tab', { name: '自动上品任务' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.wb-automation-console')).toBeVisible();
    await expect(page.locator('.wb-manual-console')).toHaveCount(0);

    await page.getByRole('tab', { name: '自动上品任务' }).focus();
    await page.getByRole('tab', { name: '自动上品任务' }).press('ArrowRight');
    await expect(page).toHaveURL(/\/listing\/wb\?view=manual$/);
    const manualSearch = page.getByRole('searchbox', { name: '搜索手动上品资料' });
    const autoRequestsBeforeManualSearch = autoQueries.length;
    await manualSearch.fill('0000010');
    await expect.poll(() => manualQueries.at(-1)).toBe('0000010');
    expect(manualSources.every((source) => source === 'MANUAL')).toBe(true);
    expect(autoQueries).toHaveLength(autoRequestsBeforeManualSearch);

    await page.getByRole('tab', { name: '自动上品任务' }).click();
    const autoSearch = page.getByRole('searchbox', { name: '搜索自动任务 SKU' });
    const manualRequestsBeforeAutoSearch = manualQueries.length;
    await autoSearch.fill('0000021');
    await autoSearch.press('Enter');
    await expect.poll(() => autoQueries.at(-1)).toBe('0000021');
    expect(manualQueries).toHaveLength(manualRequestsBeforeAutoSearch);

    await page.getByRole('tab', { name: '手动上品资料' }).click();
    await expect(page.getByRole('searchbox', { name: '搜索手动上品资料' })).toHaveValue('0000010');
    await page.goBack();
    await expect(page.getByRole('tab', { name: '自动上品任务' })).toHaveAttribute('aria-selected', 'true');

    await page.getByRole('tab', { name: '类目模板' }).click();
    await page.reload();
    await expect(page.getByRole('tab', { name: '类目模板' })).toHaveAttribute('aria-selected', 'true');

    await page.setViewportSize({ width: 320, height: 720 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('自动与手动上品共享上海时区更新日期筛选并支持自定义时间段和重置', async ({ page }) => {
    await mockWbApis(page);
    const autoRequests: URLSearchParams[] = [];
    const manualRequests: URLSearchParams[] = [];
    await page.unroute(/\/api\/v1\/wb\/automation\/jobs(?:\?.*)?$/);
    await page.unroute(/\/api\/v1\/wb\/listings\?.*/);
    await page.route(/\/api\/v1\/wb\/automation\/jobs(?:\?.*)?$/, async (route) => {
      autoRequests.push(new URL(route.request().url()).searchParams);
      await route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 20 } });
    });
    await page.route(/\/api\/v1\/wb\/listings\?.*/, async (route) => {
      manualRequests.push(new URL(route.request().url()).searchParams);
      await route.fulfill({ json: { items: [baseListing], total: 1, page: 1, pageSize: 100 } });
    });

    await page.goto('/listing/wb?view=auto');
    const autoFilter = page.locator('.wb-automation-filter');
    const autoDateSelectRoot = autoFilter.locator('.wb-updated-date-preset');
    await expect(autoDateSelectRoot).toContainText('全部更新日期');
    const todayRequest = page.waitForRequest((request) => request.url().includes('/api/v1/wb/automation/jobs?') && new URL(request.url()).searchParams.has('updatedFrom'));
    await autoDateSelectRoot.click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '当天' }).click();
    const todayParams = new URL((await todayRequest).url()).searchParams;
    expect(Date.parse(todayParams.get('updatedTo')!) - Date.parse(todayParams.get('updatedFrom')!)).toBe(24 * 60 * 60 * 1000);

    const manualRequest = page.waitForRequest((request) => request.url().includes('/api/v1/wb/listings?') && new URL(request.url()).searchParams.get('updatedFrom') === todayParams.get('updatedFrom'));
    await page.getByRole('tab', { name: '手动上品资料' }).click();
    await manualRequest;
    const manualFilter = page.locator('.wb-manual-filter');
    const manualDateSelectRoot = manualFilter.locator('.wb-updated-date-preset');
    await expect(manualDateSelectRoot).toContainText('当天');

    await manualDateSelectRoot.click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '时间段查询' }).click();
    const startDate = manualFilter.getByPlaceholder('开始日期');
    const endDate = manualFilter.getByPlaceholder('结束日期');
    await expect(startDate).toBeVisible();
    await startDate.fill('2026-07-30');
    await endDate.fill('2026-08-02');
    const customRequest = page.waitForRequest((request) => {
      if (!request.url().includes('/api/v1/wb/listings?')) return false;
      const params = new URL(request.url()).searchParams;
      return params.get('updatedFrom') === '2026-07-29T16:00:00.000Z' && params.get('updatedTo') === '2026-08-02T16:00:00.000Z';
    });
    await endDate.press('Enter');
    await customRequest;

    await manualFilter.locator('.ant-btn').filter({ hasText: /重\s*置/ }).click();
    await expect(manualDateSelectRoot).toContainText('全部更新日期');
    await expect(manualFilter.getByRole('searchbox', { name: '搜索手动上品资料' })).toHaveValue('');
    const manualResetRequest = page.waitForRequest((request) => {
      if (!request.url().includes('/api/v1/wb/listings?')) return false;
      const params = new URL(request.url()).searchParams;
      return params.get('query') === 'reset-date' && !params.has('updatedFrom');
    });
    await manualFilter.getByRole('searchbox', { name: '搜索手动上品资料' }).fill('reset-date');
    await manualResetRequest;
    await page.getByRole('tab', { name: '自动上品任务' }).click();
    await expect(autoFilter.locator('.wb-updated-date-preset')).toContainText('全部更新日期');
    const autoResetRequest = page.waitForRequest((request) => {
      if (!request.url().includes('/api/v1/wb/automation/jobs?')) return false;
      const params = new URL(request.url()).searchParams;
      return params.get('query') === 'reset-auto' && !params.has('updatedFrom');
    });
    await autoFilter.getByRole('searchbox', { name: '搜索自动任务 SKU' }).fill('reset-auto');
    await autoFilter.getByRole('searchbox', { name: '搜索自动任务 SKU' }).press('Enter');
    await autoResetRequest;

    await page.setViewportSize({ width: 320, height: 720 });
    await expect(autoFilter.getByRole('combobox', { name: '更新日期' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('手动上品资料列表自动刷新活动任务状态，无需打开工作台', async ({ page }) => {
    await mockWbApis(page);
    await page.unroute(/\/api\/v1\/wb\/listings\?.*/);
    await page.unroute(/\/api\/v1\/wb\/publications(?:\?.*)?$/);
    let requests = 0;
    await page.route(/\/api\/v1\/wb\/listings\?.*/, async (route) => {
      await route.fulfill({ json: { items: [{
        ...baseListing,
        sku: '0000140',
        status: 'GENERATED',
        generatedVersionId: 'base-generated'
      }], total: 1, page: 1, pageSize: 100 } });
    });
    await page.route(/\/api\/v1\/wb\/listings\/0000140\/status$/, async (route) => route.fulfill({ json: {
      listing: { ...baseListing, sku: '0000140', status: 'GENERATED', generatedVersionId: 'base-generated' }, productVariants: []
    } }));
    await page.route(/\/api\/v1\/wb\/publications(?:\?.*)?$/, async (route) => {
      requests += 1;
      const status = requests === 1 ? 'QUEUED' : 'SUCCEEDED';
      const planHash = `sha256:${'1'.repeat(64)}`;
      const createPublication = (storeId: string, storeAlias: string, storeName: string, revision: number, nmId: string, presetName: string, presetRowVersion: number) => ({
        id: `publication-${storeId}`, sku: '0000140', generatedVersionId: `generated-${storeId}`,
        revision, storeId, storeAlias, storeDisplayName: storeName, status, source: 'MANUAL',
        taskId: `${storeAlias}__0000140__r${revision}`, planHash, configSnapshot: { draftVersion: 1, planStoreIds: ['store-1', 'store-2'] },
        presetName, presetRowVersion, sourcePresetExists: true, operationMode: 'COMPATIBLE_UPSERT', draftVersion: 1,
        nmIds: status === 'SUCCEEDED' ? [nmId] : [],
        productUrls: status === 'SUCCEEDED' ? [
          `https://www.wildberries.ru/catalog/${nmId}/detail.aspx`,
          ...(storeId === 'store-1' ? ['javascript:alert(1)'] : [])
        ] : [],
        productLinks: status === 'SUCCEEDED' ? [{ nmId, url: `https://www.wildberries.ru/catalog/${nmId}/detail.aspx`, variantCode: '0000140-01' }] : [],
        result: {}, rowVersion: requests, createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:01:00.000Z'
      });
      await route.fulfill({ json: { items: [
        createPublication('store-1', 'default', 'TEK+01', 2, '1279538487', 'WB 女包 49%', 12),
        createPublication('store-2', '250167882', 'TEK+02', 3, '1279538488', 'WB 女包 45%', 8)
      ], total: 2 } });
    });

    await page.goto('/listing/wb?view=manual');
    const table = page.locator('.wb-manual-table');
    await expect(table.getByRole('columnheader')).toHaveText([
      '店铺', 'SKU', '轮次 / 方式', '手动状态', '绑定预设', '当前说明', '更新时间', '操作', 'WB 商品链接'
    ]);
    await expect(table.getByText('已排队', { exact: true })).toHaveCount(2);
    await expect(table.getByText('已完成', { exact: true })).toHaveCount(2, { timeout: 7_000 });
    const firstRow = table.getByRole('row').filter({ hasText: 'TEK+01' });
    const secondRow = table.getByRole('row').filter({ hasText: 'TEK+02' });
    await expect(firstRow).toContainText('WB 女包 49%');
    await expect(secondRow).toContainText('WB 女包 45%');
    await expect(firstRow).toContainText('发布 R2');
    await expect(secondRow).toContainText('发布 R3');
    const firstLink = firstRow.getByRole('link', { name: '打开 SKU 0000140 的 WB 商品 0000140-01' });
    await expect(firstLink).toHaveAttribute('href', 'https://www.wildberries.ru/catalog/1279538487/detail.aspx');
    await expect(firstLink).toHaveAttribute('target', '_blank');
    await expect(secondRow.getByRole('link', { name: '打开 SKU 0000140 的 WB 商品 0000140-01' })).toHaveAttribute('href', 'https://www.wildberries.ru/catalog/1279538488/detail.aspx');
    await expect(table.locator('a[href^="javascript:"]')).toHaveCount(0);
    await expect(table.locator('th.ant-table-cell-fix-right-first')).toContainText('操作');
    await expect(table.locator('th.ant-table-cell-fix-right').last()).toContainText('WB 商品链接');
    expect(requests).toBeGreaterThanOrEqual(2);
    await page.setViewportSize({ width: 320, height: 720 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(table.getByRole('columnheader', { name: '操作' })).toHaveCSS('position', 'static');
    const scroller = table.locator('.ant-table-content');
    expect(await scroller.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await scroller.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    await firstRow.getByRole('button', { name: '打开工作台' }).click();
    await expect(page.locator('.wb-listing-drawer')).toBeVisible();
  });

  test('手动任务运行中的 WB 回读说明显示为进度而不是失败', async ({ page }) => {
    await mockWbApis(page);
    const runningListing = { ...baseListing, status: 'RUNNING', lastError: '卡片异步同步中', n8nTaskId: '0000010__r5' };
    await page.unroute(/\/api\/v1\/wb\/listings\/0000010\/status$/);
    await page.unroute(/\/api\/v1\/wb\/listings\/0000010$/);
    await page.unroute(/\/api\/v1\/wb\/listings\?.*/);
    await page.route(/\/api\/v1\/wb\/listings\/0000010\/status$/, async (route) => route.fulfill({ json: { listing: runningListing, productVariants: [] } }));
    await page.route(/\/api\/v1\/wb\/listings\/0000010$/, async (route) => route.fulfill({ json: { listing: runningListing } }));
    await page.route(/\/api\/v1\/wb\/listings\?.*/, async (route) => route.fulfill({ json: { items: [runningListing], total: 1, page: 1, pageSize: 100 } }));

    await page.goto('/listing/wb?view=manual');
    await page.getByRole('button', { name: '打开工作台' }).click();
    const drawer = page.locator('.wb-listing-drawer');
    await expect(drawer.getByText('当前上品进度', { exact: true })).toBeVisible();
    await expect(drawer.getByText('卡片异步同步中', { exact: true })).toBeVisible();
    await expect(drawer.getByText('最近一次任务失败', { exact: true })).toHaveCount(0);
  });

  test('公共素材工作台不恢复全局预设字段，并保留历史资料兼容读取', async ({ page }) => {
    await mockWbApis(page);
    const legacyListing = {
      ...baseListing,
      packaging: { grossWeightGrams: 650.5, lengthCm: 30, widthCm: 20, heightCm: 12 },
      priceCny: 395.86,
      brand: 'Legacy brand',
      initialization: {
        presetId: 'preset-default', presetName: 'WB 默认上品预设', presetRowVersion: 3,
        appliedAt: '2026-08-06T02:00:00.000Z', issues: [],
        grossWeightResolution: {
          source: 'PROCUREMENT', effectiveGrossWeightGrams: 650.5, procurementGrossWeightGrams: 650.5,
          presetGrossWeightGrams: 750, procurementVersionId: '77777777-7777-4777-8777-777777777777',
          procurementVersionNo: 7, procurementCapturedAt: '2026-08-06T02:00:00.000Z'
        }
      }
    };
    await page.unroute(/\/api\/v1\/wb\/listings\/0000010\/status$/);
    await page.route(/\/api\/v1\/wb\/listings\/0000010\/status$/, async (route) => route.fulfill({ json: { listing: legacyListing, productVariants: [] } }));

    await page.goto('/listing/wb?view=manual');
    await page.getByRole('button', { name: '打开工作台' }).click();
    const drawer = page.locator('.wb-listing-drawer');
    await expect(drawer.getByText('公共素材任务', { exact: true })).toBeVisible();
    await expect(drawer).toContainText('价格、折扣、类目、标题、详情、包装、特征和尺码由所选店铺的默认预设生成');
    await expect(drawer.getByRole('spinbutton', { name: '毛重 (g)' })).toHaveCount(0);
    await expect(drawer.getByPlaceholder('留空时不向 WB 发送品牌特征')).toBeHidden();
    await expect(drawer.locator('.ant-form-item').filter({ hasText: '上架价 CNY' })).toBeHidden();
    await expect(drawer.getByText('采购 V7', { exact: true })).toBeHidden();
    await expect(drawer.getByRole('button', { name: '保存草稿' })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: '保存媒体顺序' })).toBeDisabled();
  });

  test('已完成逐店任务锁定当前行店铺并经人工确认启动重新上品', async ({ page }) => {
    await mockWbApis(page);
    await mockWbStoreSettingsApis(page, [wbStore({ autoPublishMode: 'COMPATIBLE_UPSERT' })]);
    let startRequests = 0;
    await page.unroute(/\/api\/v1\/wb\/listings\?.*/);
    await page.route(/\/api\/v1\/wb\/listings\?.*/, async (route) => route.fulfill({ json: {
      items: [{ ...baseListing, status: 'SUCCEEDED', revision: 4 }], total: 1, page: 1, pageSize: 100
    } }));
    await page.route(/\/api\/v1\/wb\/automation\/jobs\/0000010\/start-compatible$/, async (route) => {
      startRequests += 1;
      expect(route.request().method()).toBe('POST');
      expect(route.request().postDataJSON()).toEqual({ storeId: 'store-main' });
      await route.fulfill({ json: { job: {
        sku: '0000010', state: 'WAITING_STABLE', runId: 'compatible-run-5', runNo: 5,
        operationMode: 'COMPATIBLE_UPSERT', triggerType: 'MANUAL', baseRevision: 4, targetRevision: 5,
        createdAt: '2026-07-20T10:00:00.000Z', updatedAt: '2026-07-20T10:00:00.000Z'
      } } });
    });

    await page.goto('/listing/wb?view=manual');
    const row = page.locator('.wb-manual-console').getByRole('row').filter({ hasText: '0000010' });
    await expect(row.getByRole('button', { name: '重新上品' })).toBeEnabled();
    await row.getByRole('button', { name: '重新上品' }).click();
    const confirm = page.getByRole('dialog', { name: '重新上品 SKU 0000010 到 WB 主店铺？' });
    await expect(confirm).toContainText('本次只锁定当前行店铺 WB 主店铺 · main');
    await expect(confirm.getByRole('combobox')).toHaveCount(0);
    await confirm.getByRole('button', { name: '确认重新上品' }).click();
    await expect(page.getByText('SKU 0000010 已启动第 5 轮兼容重新上品', { exact: true })).toBeVisible();
    expect(startRequests).toBe(1);
  });

  test('自动完成资料经人工保存后从自动任务切换到手动资料', async ({ page }) => {
    await mockWbApis(page);
    const sku = '0000022';
    const job = {
      sku, state: 'SUCCEEDED', runId: '22222222-2222-4222-8222-222222222222', runNo: 2,
      operationMode: 'COMPATIBLE_UPSERT', triggerType: 'MEDIA_DELIVERY', baseRevision: 1, targetRevision: 2,
      presetName: 'WB 自动预设', sourcePresetExists: true, expectedVendorCodes: [`${sku}-01`],
      createdAt: '2026-07-20T10:00:00.000Z', updatedAt: '2026-07-20T10:10:00.000Z',
      canRecheck: false, canCancel: false, hasListing: true, events: []
    };
    let listing = {
      ...baseListing,
      sku,
      status: 'SUCCEEDED' as const,
      autoPublishLocked: false,
      latestOperationSource: 'AUTOMATION' as const,
      latestOperationRef: `automation:${job.runId}`
    };
    let manualOwned = false;
    let savedBody: any;
    await page.unroute(/\/api\/v1\/wb\/automation\/jobs(?:\?.*)?$/);
    await page.unroute(/\/api\/v1\/wb\/listings\?.*/);
    await page.route(/\/api\/v1\/wb\/automation\/jobs(?:\?.*)?$/, async (route) => route.fulfill({ json: {
      items: manualOwned ? [] : [job], total: manualOwned ? 0 : 1, page: 1, pageSize: 20
    } }));
    await page.route(new RegExp(`/api/v1/wb/automation/jobs/${sku}$`), async (route) => route.fulfill({ json: job }));
    await page.route(new RegExp(`/api/v1/wb/listings/${sku}/status$`), async (route) => route.fulfill({ json: { listing, productVariants: [] } }));
    await page.route(new RegExp(`/api/v1/wb/listings/${sku}$`), async (route) => {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON();
        savedBody = body;
        manualOwned = true;
        listing = {
          ...listing,
          ...body,
          status: 'STALE',
          draftVersion: listing.draftVersion + 1,
          latestOperationSource: 'MANUAL',
          latestOperationRef: `manual:save:${listing.draftVersion + 1}`
        };
      }
      await route.fulfill({ json: { listing } });
    });
    await page.route(/\/api\/v1\/wb\/listings\?.*/, async (route) => {
      const source = new URL(route.request().url()).searchParams.get('source');
      expect(source).toBe('MANUAL');
      await route.fulfill({ json: { items: manualOwned ? [listing] : [], total: manualOwned ? 1 : 0, page: 1, pageSize: 100 } });
    });

    await page.goto('/listing/wb?view=auto');
    const autoRow = page.locator('.wb-automation-console').getByRole('row').filter({ hasText: sku });
    await autoRow.getByRole('button', { name: '查看详情' }).click();
    await page.locator('.wb-automation-drawer').getByRole('button', { name: '打开上品资料' }).click();
    const editor = page.locator('.wb-listing-drawer');
    await expect(editor).toBeVisible();
    await expect(editor.getByPlaceholder('留空时不向 WB 发送品牌特征')).toBeHidden();
    const firstImage = editor.locator('.wb-media-tile').filter({ hasText: '01.png' });
    await firstImage.getByRole('checkbox', { name: '用于当前变体' }).check();
    await editor.getByRole('button', { name: '保存媒体顺序' }).click();
    await expect(page.getByText('公共媒体分配与顺序已保存', { exact: true })).toBeVisible();
    await expect.poll(() => manualOwned).toBe(true);
    expect(savedBody).toEqual({
      draftVersion: 1,
      variantMedia: [
        { variantId: 'variant-black', imageAssetIds: ['img-01'] },
        { variantId: 'variant-white', imageAssetIds: [] }
      ]
    });
    await editor.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('.wb-automation-console').getByText(sku, { exact: true })).toHaveCount(0);

    await page.getByRole('tab', { name: '手动上品资料' }).click();
    await expect(page.locator('.wb-manual-console').getByText(sku, { exact: true })).toHaveCount(0);
    await expect(page.getByText('暂无已发布的手动上品任务', { exact: true })).toBeVisible();
  });

  test('空类目库可以搜索 WB subject 并创建首个模板草稿', async ({ page }) => {
    let createdBody: any;
    const subjectSchema = [
      { charcID: 204557, subjectID: 105, name: 'Пол', required: true, maxCount: 1, charcType: 1, isVariable: false, existNamedField: false },
      { charcID: 14177449, subjectID: 105, name: 'Цвет', required: false, maxCount: 5, charcType: 1, isVariable: true, existNamedField: false },
      { charcID: 15004139, subjectID: 105, name: 'Код ТН ВЭД', required: false, maxCount: 1, charcType: 1, isVariable: false, existNamedField: false },
      { charcID: 14177446, subjectID: 105, name: 'Бренд', required: false, maxCount: 1, charcType: 1, existNamedField: true }
    ];
    const subjectSchemaZh = [
      { charcID: 14177449, subjectID: 105, name: '颜色' },
      { charcID: 14177446, subjectID: 105, name: '品牌' },
      { charcID: 204557, subjectID: 105, name: '性别' },
      { charcID: 15004139, subjectID: 105, name: '海关编码' }
    ];
    const createdCategory = {
      categoryKey: 'adult_casual_sneakers', nameRu: 'Кроссовки', nameZh: '休闲运动鞋', subjectId: 105, active: true,
      createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z',
      draftVersion: { id: 'cat-draft-1', versionNo: 1, updatedAt: '2026-07-15T00:00:00.000Z' },
      projection: { status: 'NOT_SYNCED' },
      versions: [{ id: 'cat-draft-1', versionNo: 1, status: 'DRAFT', liveSchema: [], formConfig: { fields: [], media: { minImages: 1, maxImages: 30, videoAllowed: true, defaultVideoUploadMode: 'COMPRESSED_COPY' } }, managedCharacteristicIds: [], schemaHash: 'sha256:test', createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z' }]
    };
    await page.route(/\/api\/v1\/wb\/listings\?.*/, async (route) => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/wb\/catalog\/status$/, async (route) => route.fulfill({ json: { catalog: readyCatalog } }));
    await page.route(/\/api\/v1\/wb\/catalog\/subjects\?.*/, async (route) => route.fulfill({ json: { items: [{ subjectId: 105, parentId: 1, subjectName: 'Кроссовки', subjectNameRu: 'Кроссовки', subjectNameZh: '运动鞋', parentName: 'Обувь', parentNameRu: 'Обувь', parentNameZh: '鞋类', active: true }], catalog: { status: 'READY', subjectCount: 4321, lastSuccessfulAt: readyCatalog.lastSuccessfulAt, isStale: false } } }));
    await page.route(/\/api\/v1\/wb\/catalog\/subjects\/105\/schema\?locale=(ru|zh)$/, async (route) => route.fulfill({ json: new URL(route.request().url()).searchParams.get('locale') === 'zh' ? subjectSchemaZh : subjectSchema }));
    await page.route(/\/api\/v1\/wb\/categories\/adult_casual_sneakers$/, async (route) => route.fulfill({ json: { category: createdCategory } }));
    await page.route(/\/api\/v1\/wb\/categories$/, async (route) => {
      if (route.request().method() === 'POST') {
        createdBody = route.request().postDataJSON();
        await route.fulfill({ json: { category: createdCategory } });
      } else {
        await route.fulfill({ json: { items: createdBody ? [createdCategory] : [] } });
      }
    });

    await page.goto('/listing/wb');
    await page.getByRole('tab', { name: '类目模板' }).click();
    await page.getByRole('button', { name: '新建类目模板' }).click();
    const modal = page.getByRole('dialog', { name: '新建 WB 类目模板' });
    await modal.getByLabel('category key').fill('adult_casual_sneakers');
    await modal.getByRole('combobox', { name: '搜索 WB subject' }).fill('Крос');
    await page.getByText('运动鞋 / Кроссовки · 鞋类 / Обувь · subjectID 105', { exact: true }).click();
    await expect(modal.getByLabel('WB subject ID')).toHaveValue('105');
    await expect(modal.getByLabel('俄文类目名称')).toHaveValue('Кроссовки');
    await expect(modal.getByLabel('中文类目名称')).toHaveValue('运动鞋');
    await modal.getByRole('button', { name: '创建草稿' }).click();
    await expect(page.getByText('类目 adult_casual_sneakers 已创建，已自动生成 3 个属性字段')).toBeVisible();
    expect(createdBody).toMatchObject({ categoryKey: 'adult_casual_sneakers', subjectId: 105, nameRu: 'Кроссовки', nameZh: '运动鞋' });
    expect(createdBody.formConfig).toMatchObject({
      fields: [
        expect.objectContaining({ characteristicId: 204557, labelRu: 'Пол', labelZh: '性别', scope: 'shared', control: 'select', required: true }),
        expect.objectContaining({ characteristicId: 14177449, labelRu: 'Цвет', labelZh: '颜色', scope: 'variant', control: 'multi-select' }),
        expect.objectContaining({ characteristicId: 15004139, labelRu: 'Код ТН ВЭД', labelZh: '海关编码', scope: 'shared', control: 'select' })
      ],
      media: { minImages: 1, maxImages: 30, videoAllowed: true, defaultVideoUploadMode: 'COMPRESSED_COPY' },
      compliance: { tnvedCharacteristicId: 15004139, tnvedRequired: false }
    });
    expect(createdBody.liveSchema).toEqual(subjectSchema);
  });

  test('展示目录同步状态，并复用正在运行的立即同步任务', async ({ page }) => {
    let syncRequests = 0;
    const runningCatalog = {
      status: 'SYNCING', subjectCount: 4321, parentCount: 26,
      lastSuccessfulAt: '2026-07-13T02:04:00.000Z',
      nextScheduledAt: '2026-07-20T02:00:00.000Z',
      currentRun: { runId: 'catalog-run-live', trigger: 'MANUAL', status: 'RUNNING', startedAt: '2026-07-15T01:00:00.000Z', processedParents: 8, totalParents: 26, processedSubjects: 1200 }
    };
    await page.route(/\/api\/v1\/wb\/catalog\/status$/, async (route) => route.fulfill({ json: { catalog: runningCatalog } }));
    await page.route(/\/api\/v1\/wb\/catalog\/sync$/, async (route) => {
      syncRequests += 1;
      await route.fulfill({ status: 202, json: { runId: 'catalog-run-live', status: 'RUNNING', accepted: false } });
    });
    await page.route(/\/api\/v1\/wb\/categories$/, async (route) => route.fulfill({ json: { items: [] } }));
    await page.route(/\/api\/v1\/wb\/listings\?.*/, async (route) => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));

    await page.goto('/listing/wb');
    await page.getByRole('tab', { name: '类目模板' }).click();
    const status = page.locator('.wb-catalog-status');
    await expect(status.getByText('同步中', { exact: true })).toBeVisible();
    await expect(status.getByText('4321', { exact: true })).toBeVisible();
    await expect(status.getByText(/父类目 8\/26，已读取 1200 个 subject/)).toBeVisible();
    await expect(status.getByText(dayjs(runningCatalog.nextScheduledAt).format('YYYY-MM-DD HH:mm'), { exact: true })).toBeVisible();
    await status.getByRole('button', { name: '立即同步' }).click();
    await expect(page.getByText('同步任务 catalog-run-live 已在运行')).toBeVisible();
    expect(syncRequests).toBe(1);
  });

  test('搜索框区分桥接未配置与本地真实零结果，并按 250ms 防抖', async ({ page }) => {
    let searchRequests = 0;
    let statusMode: 'FAILED' | 'READY' = 'FAILED';
    await page.route(/\/api\/v1\/wb\/catalog\/status$/, async (route) => route.fulfill({ json: { catalog: statusMode === 'FAILED' ? {
      status: 'FAILED', subjectCount: 0, parentCount: 0, nextScheduledAt: '2026-07-20T02:00:00.000Z',
      lastErrorCode: 'BRIDGE_NOT_CONFIGURED', lastError: '未配置 WB_AUTOMATION_BASE_URL 或 WB_AUTOMATION_KEY'
    } : readyCatalog } }));
    await page.route(/\/api\/v1\/wb\/catalog\/subjects\?.*/, async (route) => {
      searchRequests += 1;
      if (statusMode === 'FAILED') {
        await route.fulfill({ status: 409, json: { error: { code: 'CATALOG_NOT_INITIALIZED', message: 'WB 本地目录尚未初始化' } } });
      } else {
        await route.fulfill({ json: { items: [], catalog: { status: 'READY', subjectCount: 4321, lastSuccessfulAt: readyCatalog.lastSuccessfulAt, isStale: false } } });
      }
    });
    await page.route(/\/api\/v1\/wb\/categories$/, async (route) => route.fulfill({ json: { items: [] } }));
    await page.route(/\/api\/v1\/wb\/listings\?.*/, async (route) => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));

    await page.goto('/listing/wb');
    await page.getByRole('tab', { name: '类目模板' }).click();
    await expect(page.getByText(/n8n WB 桥接未配置/).first()).toBeVisible();
    await page.getByRole('button', { name: '新建类目模板' }).click();
    const search = page.getByRole('dialog', { name: '新建 WB 类目模板' }).getByRole('combobox', { name: '搜索 WB subject' });
    await search.pressSequentially('рюкзак', { delay: 20 });
    await expect(page.getByText('n8n WB 桥接未配置', { exact: true }).last()).toBeVisible();
    expect(searchRequests).toBe(1);

    statusMode = 'READY';
    searchRequests = 0;
    await search.fill('Кроссовки');
    await expect(page.getByText('本地目录中没有匹配结果', { exact: true })).toBeVisible();
    expect(searchRequests).toBe(1);
  });

  test('类目模板编辑页显示选填字段、支持一键置顶，并提供编辑同步删除三项操作', async ({ page }) => {
    let deleted = false;
    let savedDraftBody: Record<string, any> | undefined;
    await mockWbApis(page);
    await page.unroute(/\/api\/v1\/wb\/categories$/);
    await page.route(/\/api\/v1\/wb\/categories$/, async (route) => route.fulfill({ json: { items: deleted ? [] : [categorySummary] } }));
    await page.unroute(/\/api\/v1\/wb\/categories\/adult_casual_sneakers$/);
    await page.route('**/api/v1/wb/categories/adult_casual_sneakers/draft', async (route) => {
      savedDraftBody = route.request().postDataJSON();
      await route.fulfill({ json: { category: categorySummary } });
    });
    await page.route(/\/api\/v1\/wb\/categories\/adult_casual_sneakers$/, async (route) => {
      if (route.request().method() === 'DELETE') {
        deleted = true;
        await route.fulfill({ json: { deletedCategoryKey: 'adult_casual_sneakers', deletedCategory: categorySummary, projection: { categoryKey: 'adult_casual_sneakers', deleted: true } } });
        return;
      }
      await route.fulfill({ json: { category: { ...categorySummary, versions: [{ id: 'cat-v1', versionNo: 2, status: 'PUBLISHED', liveSchema: [
        { charcID: 204557, subjectID: 105, name: 'Пол', required: true, maxCount: 1, charcType: 1, isVariable: false },
        { charcID: 14177449, subjectID: 105, name: 'Цвет', required: false, maxCount: 1, charcType: 1, isVariable: true }
      ], formConfig: { fields: [
        { fieldId: 'gender', characteristicId: 204557, labelRu: 'Пол', labelZh: '性别', scope: 'shared', control: 'select', required: true, order: 10 },
        { fieldId: 'color', characteristicId: 14177449, labelRu: 'Цвет', labelZh: '颜色', scope: 'variant', control: 'select', required: false, order: 20 }
      ], media: savedDraftBody?.formConfig?.media || { minImages: 1, maxImages: 30, videoAllowed: true } }, managedCharacteristicIds: [204557, 14177449], schemaHash: 'sha256:test', confirmedBy: 'QA', confirmedAt: '2026-07-15T00:00:00.000Z', createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z', publishedAt: '2026-07-15T00:00:00.000Z' }] } } });
    });

    await page.goto('/listing/wb');
    await page.getByRole('tab', { name: '类目模板' }).click();
    const row = page.getByRole('row').filter({ hasText: 'adult_casual_sneakers' });
    await expect(row.getByRole('button', { name: /编\s*辑/ })).toBeVisible();
    await expect(row.getByRole('button', { name: '同步' })).toBeVisible();
    await expect(row.getByRole('button', { name: '删除' })).toBeVisible();

    await row.getByRole('button', { name: /编\s*辑/ }).click();
    const drawer = page.locator('.wb-category-drawer');
    await expect(drawer.getByText('选填字段', { exact: true })).toBeVisible();
    const videoMode = drawer.locator('.ant-form-item').filter({ hasText: '默认视频上传方式' }).first();
    const videoAllowed = drawer.getByRole('switch', { name: '允许视频' });
    await expect(videoMode.locator('.ant-select-selection-item')).toHaveText('使用压缩副本');
    await videoAllowed.click();
    await expect(videoMode.locator('.ant-select')).toHaveClass(/ant-select-disabled/);
    await expect(videoMode.locator('.ant-select-selection-item')).toHaveText('使用压缩副本');
    await videoAllowed.click();
    await videoMode.locator('.ant-select-selector').click();
    await page.locator('.ant-select-item-option').filter({ hasText: '使用原视频' }).last().click();
    await drawer.getByRole('button', { name: '保存草稿' }).click();
    await expect.poll(() => savedDraftBody?.formConfig?.media?.defaultVideoUploadMode).toBe('ORIGINAL');
    expect(savedDraftBody?.formConfig?.media).toMatchObject({ videoAllowed: true, defaultVideoUploadMode: 'ORIGINAL' });
    await expect(videoMode.locator('.ant-select-selection-item')).toHaveText('使用原视频');
    await drawer.getByRole('button', { name: '置顶 颜色' }).click();
    await expect(drawer.locator('.wb-field-row').first().getByLabel('中文字段名 1')).toHaveValue('颜色');
    await drawer.getByRole('button', { name: 'Close' }).click();

    await row.getByRole('button', { name: '删除' }).click();
    const confirm = page.getByRole('dialog', { name: /删除类目模板/ });
    await confirm.getByRole('button', { name: '同步删除' }).click();
    await expect(page.getByText(/已从 MerchRoute 和 n8n 删除/)).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'adult_casual_sneakers' })).toHaveCount(0);
  });

  test('按变体复用同一图片和视频，并独立排序图片', async ({ page }) => {
    let savedBody: any;
    await mockWbApis(page);
    await page.unroute(/\/api\/v1\/wb\/listings\/0000010$/);
    await page.route(/\/api\/v1\/wb\/listings\/0000010$/, async (route) => {
      if (route.request().method() === 'PUT') {
        savedBody = route.request().postDataJSON();
        await route.fulfill({ json: { listing: { ...baseListing, ...savedBody, draftVersion: 2, mediaAssets } } });
      } else await route.fulfill({ json: { listing: baseListing } });
    });
    await page.goto('/listing/wb?view=manual');
    await expect(page.getByRole('heading', { name: 'WB上品', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: '自动上品任务' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '手动上品资料' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '类目模板' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'OZON上品' })).toHaveCount(0);
    await page.getByRole('button', { name: '打开工作台' }).click();

    const drawer = page.locator('.wb-listing-drawer');
    await expect(drawer.getByText('发布准备轨', { exact: true })).toBeVisible();
    await expect(drawer.getByText('公共素材任务', { exact: true })).toBeVisible();
    await expect(drawer.locator('.ant-form-item').filter({ hasText: '上架价 CNY' })).toBeHidden();
    await expect(drawer.getByRole('button', { name: '保存草稿' })).toHaveCount(0);
    await expect(drawer.getByText('红色', { exact: true })).toBeVisible();
    await expect(drawer.getByText('未识别变体', { exact: true })).toBeVisible();
    await expect(drawer.getByText('清单缺失或损坏', { exact: true })).toBeVisible();
    const firstImage = drawer.locator('.wb-media-tile').filter({ hasText: '01.png' });
    const secondImage = drawer.locator('.wb-media-tile').filter({ hasText: '02.png' });
    const video = drawer.locator('.wb-media-tile').filter({ hasText: 'main.mp4' });
    await firstImage.getByRole('button', { name: '应用到变体…' }).click();
    const assignmentDialog = page.getByRole('dialog', { name: /分配媒体：01\.png/ });
    const blackAssignment = assignmentDialog.getByRole('checkbox', { name: '0000010-BLACK' });
    const whiteAssignment = assignmentDialog.getByRole('checkbox', { name: '0000010-WHITE' });
    await assignmentDialog.getByText('0000010-BLACK', { exact: true }).click();
    await expect(blackAssignment).toBeChecked();
    await assignmentDialog.getByText('0000010-WHITE', { exact: true }).click();
    await expect(whiteAssignment).toBeChecked();
    await assignmentDialog.getByRole('button', { name: '保存分配' }).click();
    await secondImage.getByRole('button', { name: '应用到全部变体' }).click();
    await video.getByRole('button', { name: '应用到全部变体' }).click();
    await drawer.getByRole('button', { name: '下移 variants/红色/images/submission-a/01.png' }).click();

    await drawer.getByRole('tab', { name: /0000010-WHITE/ }).click();
    await expect(firstImage.locator('.ant-checkbox')).toHaveClass(/ant-checkbox-checked/);
    await expect(video.locator('.ant-checkbox')).toHaveClass(/ant-checkbox-checked/);
    await drawer.getByRole('button', { name: '保存媒体顺序' }).click();
    await expect(page.getByText('公共媒体分配与顺序已保存', { exact: true })).toBeVisible();

    expect(savedBody).toEqual({
      draftVersion: 1,
      variantMedia: [
        { variantId: 'variant-black', imageAssetIds: ['img-02', 'img-01'], videoAssetId: 'video-01' },
        { variantId: 'variant-white', imageAssetIds: ['img-01', 'img-02'], videoAssetId: 'video-01' }
      ]
    });
  });

  test('扫描 variants 目录只刷新媒体，不清空未保存的媒体分配', async ({ page }) => {
    let savedBody: any;
    const scannedAssets = [
      ...mediaAssets,
      { assetId: 'img-03', relativePath: 'variants/03.png', kind: 'IMAGE', mimeType: 'image/png', sizeBytes: 3072, sha256: 'd', modifiedAt: '2026-07-16T00:00:00.000Z' }
    ];
    await mockWbApis(page);
    await page.route(/\/api\/v1\/wb\/listings\/0000010\/media\/scan$/, async (route) => route.fulfill({ json: {
      listing: {
        ...baseListing,
        draftVersion: 2,
        brand: '',
        titleRu: '',
        descriptionRu: '',
        packaging: {},
        sharedCharacteristics: [],
        variants: baseListing.variants.map((variant) => ({ ...variant, characteristics: [], sizes: [] })),
        mediaAssets: scannedAssets
      },
      mediaAssets: scannedAssets,
      productVariants: []
    } }));
    await page.unroute(/\/api\/v1\/wb\/listings\/0000010$/);
    await page.route(/\/api\/v1\/wb\/listings\/0000010$/, async (route) => {
      if (route.request().method() === 'PUT') {
        savedBody = route.request().postDataJSON();
        await route.fulfill({ json: { listing: { ...baseListing, ...savedBody, draftVersion: 3, mediaAssets: scannedAssets } } });
      } else await route.fulfill({ json: { listing: baseListing } });
    });

    await page.goto('/listing/wb?view=manual');
    await page.getByRole('button', { name: '打开工作台' }).click();
    const drawer = page.locator('.wb-listing-drawer');
    const firstImage = drawer.locator('.wb-media-tile').filter({ hasText: '01.png' });
    await firstImage.getByRole('checkbox', { name: '用于当前变体' }).check();
    await expect(firstImage.locator('.ant-checkbox')).toHaveClass(/ant-checkbox-checked/);

    await drawer.getByRole('button', { name: '扫描 variants 目录' }).click();
    await expect(page.getByText('已扫描到 4 个媒体文件')).toBeVisible();
    await expect(firstImage.locator('.ant-checkbox')).toHaveClass(/ant-checkbox-checked/);
    await expect(drawer.getByText('有未保存修改', { exact: true })).toBeVisible();
    await expect(drawer.locator('.wb-media-tile')).toHaveCount(4);

    await drawer.getByRole('button', { name: '保存媒体顺序' }).click();
    await expect(page.getByText('公共媒体分配与顺序已保存', { exact: true })).toBeVisible();
    expect(savedBody).toEqual({
      draftVersion: 2,
      variantMedia: [
        { variantId: 'variant-black', imageAssetIds: ['img-01'] },
        { variantId: 'variant-white', imageAssetIds: [] }
      ]
    });
  });

  test('按产品变体颜色自动建议最新图片和视频，但不自动保存', async ({ page }) => {
    let saveRequests = 0;
    const blackVariantId = '11111111-1111-4111-8111-111111111111';
    const whiteVariantId = '22222222-2222-4222-8222-222222222222';
    const productVariants = [
      { variantId: blackVariantId, sku: '0000010', name: '黑色', active: true, wbColor: { colorKey: BLACK_COLOR_KEY, nameRu: 'Черный', nameZh: '黑色' }, createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z' },
      { variantId: whiteVariantId, sku: '0000010', name: '白色', active: true, wbColor: { colorKey: WHITE_COLOR_KEY, nameRu: 'Белый', nameZh: '白色' }, createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z' }
    ];
    const suggestedAssets = [
      { assetId: 'black-old-image', relativePath: 'variants/黑色/images/old/01.png', kind: 'IMAGE', mimeType: 'image/png', sizeBytes: 512, sha256: 'old', modifiedAt: '2026-07-17T00:00:00.000Z', validationStatus: 'VALID', productVariantId: blackVariantId, productVariantName: '黑色', productVariantColor: productVariants[0].wbColor, sourceStageId: 'E005', sourceSubmissionId: 'old', deliveredAt: '2026-07-17T00:00:00.000Z' },
      { assetId: 'black-image', relativePath: 'variants/黑色/images/latest/01.png', kind: 'IMAGE', mimeType: 'image/png', sizeBytes: 1024, sha256: 'new', modifiedAt: '2026-07-18T00:00:00.000Z', validationStatus: 'VALID', productVariantId: blackVariantId, productVariantName: '黑色', productVariantColor: productVariants[0].wbColor, sourceStageId: 'E005', sourceSubmissionId: 'latest', deliveredAt: '2026-07-18T00:00:00.000Z' },
      { assetId: 'black-video', relativePath: 'variants/黑色/videos/latest/main.mp4', kind: 'VIDEO', mimeType: 'video/mp4', sizeBytes: 4096, sha256: 'video', modifiedAt: '2026-07-18T00:00:00.000Z', validationStatus: 'VALID', productVariantId: blackVariantId, productVariantName: '黑色', productVariantColor: productVariants[0].wbColor, sourceStageId: 'E004', sourceSubmissionId: 'latest-video', deliveredAt: '2026-07-18T00:01:00.000Z' }
    ];
    const listing = { ...baseListing, mediaAssets: suggestedAssets, variantMedia: baseListing.variantMedia.map((item) => ({ ...item, imageAssetIds: [] })) };
    await mockWbApis(page);
    await page.unroute(/\/api\/v1\/wb\/listings\/0000010\/status$/);
    await page.route(/\/api\/v1\/wb\/listings\/0000010\/status$/, async (route) => route.fulfill({ json: { listing, productVariants } }));
    await page.unroute(/\/api\/v1\/wb\/listings\/0000010$/);
    await page.route(/\/api\/v1\/wb\/listings\/0000010$/, async (route) => {
      if (route.request().method() === 'PUT') saveRequests += 1;
      await route.fulfill({ json: { listing } });
    });

    await page.goto('/listing/wb?view=manual');
    await page.getByRole('button', { name: '打开工作台' }).click();
    const drawer = page.locator('.wb-listing-drawer');
    const suggestionTitle = drawer.getByText('已生成媒体自动匹配建议，尚未保存', { exact: true });
    await expect(suggestionTitle).toBeVisible();
    const suggestionAlert = suggestionTitle.locator('xpath=ancestor::*[contains(@class,"ant-alert")][1]');
    await expect(suggestionAlert).toContainText(/匹配 \d+ 个变体，新增 1 张图片、1 个视频/);
    await expect(drawer.getByText('有未保存修改', { exact: true })).toBeVisible();
    await expect(drawer.getByText('关联产品变体（用于媒体建议）', { exact: true })).toHaveCount(0);
    await expect(drawer.getByRole('tab', { name: '0000010-BLACK 1 图' })).toBeVisible();
    const imageTiles = drawer.locator('.wb-media-tile').filter({ hasText: '01.png' }).filter({ hasText: 'E005' });
    const latestImage = imageTiles.last();
    const latestVideo = drawer.locator('.wb-media-tile').filter({ hasText: 'main.mp4' });
    await expect(imageTiles.first().locator('.ant-checkbox')).not.toHaveClass(/ant-checkbox-checked/);
    await expect(latestImage.locator('.ant-checkbox')).toHaveClass(/ant-checkbox-checked/);
    await expect(latestVideo.locator('.ant-checkbox')).toHaveClass(/ant-checkbox-checked/);
    await page.waitForTimeout(200);
    expect(saveRequests).toBe(0);
  });

  test('提交结果待确认时显示轮询警告并禁止重复操作', async ({ page }) => {
    await mockWbApis(page);
    await page.unroute(/\/api\/v1\/wb\/listings\/0000010\/status$/);
    await page.route(/\/api\/v1\/wb\/listings\/0000010\/status$/, async (route) => route.fulfill({ json: {
      listing: { ...baseListing, status: 'SUBMITTING', n8nTaskId: '0000010__r1', submittedAt: new Date().toISOString() },
      productVariants: [],
      pollError: '任务刚提交，正在等待 n8n 完成台账登记'
    } }));

    await page.goto('/listing/wb?view=manual');
    await page.getByRole('button', { name: '打开工作台' }).click();
    const drawer = page.locator('.wb-listing-drawer');
    await expect(drawer.getByText('WB 任务状态暂时无法确认', { exact: true })).toBeVisible();
    await expect(drawer.getByText('任务刚提交，正在等待 n8n 完成台账登记', { exact: true })).toBeVisible();
    await expect(drawer.getByRole('button', { name: '保存媒体顺序' })).toBeDisabled();
    await expect(drawer.getByRole('button', { name: '选择店铺并提交' })).toBeDisabled();
    await expect(drawer.getByRole('button', { name: '生成 product.json' })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: '提交到 WB' })).toHaveCount(0);
  });

  test('编辑店铺保存成功后使用最新店铺配置自动执行一次连接检查', async ({ page }) => {
    await mockWbApis(page);
    const storeItems = [wbStore()];
    await mockWbStoreSettingsApis(page, storeItems);
    let updateBody: Record<string, unknown> | undefined;
    let preflightCalls = 0;
    const mutationOrder: string[] = [];
    await page.route(/\/api\/v1\/wb\/stores\/store-main$/, async (route) => {
      mutationOrder.push(route.request().method());
      updateBody = route.request().postDataJSON() as Record<string, unknown>;
      storeItems[0] = wbStore({
        ...updateBody,
        displayName: String(updateBody.displayName),
        rowVersion: 2,
        configVersion: 2,
        preflight: { status: 'STALE', checkedAt: '2026-08-10T00:00:00.000Z' },
        readiness: { ready: false, blockers: ['店铺连接检查尚未通过'] }
      });
      await route.fulfill({ json: { store: storeItems[0] } });
    });
    await page.route(/\/api\/v1\/wb\/stores\/store-main\/preflight$/, async (route) => {
      mutationOrder.push(route.request().method());
      preflightCalls += 1;
      storeItems[0] = wbStore({
        ...storeItems[0],
        preflight: { status: 'PENDING' },
        readiness: { ready: false, blockers: ['等待店铺连接检查完成'] }
      });
      await route.fulfill({ json: { accepted: true, store: storeItems[0] } });
    });

    await page.goto('/listing/wb');
    await page.locator('.wb-page-title').getByRole('button', { name: '打开WB上品设置' }).click();
    const settingsDrawer = page.getByRole('dialog', { name: 'WB上品设置' });
    await settingsDrawer.locator('.wb-store-card-item').filter({ hasText: 'WB 主店铺' }).getByRole('button', { name: '编辑' }).click();
    const editor = page.getByRole('dialog', { name: '编辑店铺 · WB 主店铺' });
    await editor.getByLabel('店铺显示名称').fill('WB 主店铺（已更新）');
    await editor.getByRole('button', { name: '保存店铺' }).click();

    await expect.poll(() => updateBody).toMatchObject({ displayName: 'WB 主店铺（已更新）', rowVersion: 1 });
    await expect.poll(() => mutationOrder).toEqual(['PATCH', 'POST']);
    expect(preflightCalls).toBe(1);
    await page.waitForTimeout(250);
    expect(preflightCalls).toBe(1);
    await expect(editor).not.toBeVisible();
    await expect(page.getByText('店铺设置已保存', { exact: true })).toBeVisible();
    await expect(page.getByText('WB 主店铺（已更新） 的连接检查已受理', { exact: true })).toBeVisible();
  });

  test('编辑店铺保存失败时保留编辑器且不执行连接检查', async ({ page }) => {
    await mockWbApis(page);
    await mockWbStoreSettingsApis(page, [wbStore()]);
    let preflightCalls = 0;
    await page.route(/\/api\/v1\/wb\/stores\/store-main$/, (route) => route.fulfill({
      status: 409,
      json: { error: { code: 'VERSION_CONFLICT', message: 'WB 店铺已被其他操作更新' } }
    }));
    await page.route(/\/api\/v1\/wb\/stores\/store-main\/preflight$/, (route) => {
      preflightCalls += 1;
      return route.fulfill({ json: { accepted: true, store: wbStore() } });
    });

    await page.goto('/listing/wb');
    await page.locator('.wb-page-title').getByRole('button', { name: '打开WB上品设置' }).click();
    const settingsDrawer = page.getByRole('dialog', { name: 'WB上品设置' });
    await settingsDrawer.locator('.wb-store-card-item').filter({ hasText: 'WB 主店铺' }).getByRole('button', { name: '编辑' }).click();
    const editor = page.getByRole('dialog', { name: '编辑店铺 · WB 主店铺' });
    await editor.getByRole('button', { name: '保存店铺' }).click();

    await expect(page.getByText('VERSION_CONFLICT: WB 店铺已被其他操作更新', { exact: true })).toBeVisible();
    await expect(editor).toBeVisible();
    expect(preflightCalls).toBe(0);
  });

  test('自动连接检查失败时保留已保存配置并显示独立警告', async ({ page }) => {
    await mockWbApis(page);
    const storeItems = [wbStore()];
    await mockWbStoreSettingsApis(page, storeItems);
    let preflightCalls = 0;
    await page.route(/\/api\/v1\/wb\/stores\/store-main$/, async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      storeItems[0] = wbStore({ ...body, rowVersion: 2, configVersion: 2 });
      await route.fulfill({ json: { store: storeItems[0] } });
    });
    await page.route(/\/api\/v1\/wb\/stores\/store-main\/preflight$/, (route) => {
      preflightCalls += 1;
      return route.fulfill({
        status: 503,
        json: { error: { code: 'WB_PREFLIGHT_UNAVAILABLE', message: '连接检查服务暂不可用' } }
      });
    });

    await page.goto('/listing/wb');
    await page.locator('.wb-page-title').getByRole('button', { name: '打开WB上品设置' }).click();
    const settingsDrawer = page.getByRole('dialog', { name: 'WB上品设置' });
    await settingsDrawer.locator('.wb-store-card-item').filter({ hasText: 'WB 主店铺' }).getByRole('button', { name: '编辑' }).click();
    const editor = page.getByRole('dialog', { name: '编辑店铺 · WB 主店铺' });
    await editor.getByLabel('店铺显示名称').fill('WB 保存成功店铺');
    await editor.getByRole('button', { name: '保存店铺' }).click();

    await expect.poll(() => preflightCalls).toBe(1);
    await expect(editor).not.toBeVisible();
    await expect(page.getByText('店铺设置已保存', { exact: true })).toBeVisible();
    await expect(page.getByText('店铺设置已保存，但自动连接检查失败：WB_PREFLIGHT_UNAVAILABLE: 连接检查服务暂不可用', { exact: true })).toBeVisible();
    await expect(settingsDrawer.getByText('WB 保存成功店铺', { exact: true })).toBeVisible();
  });

  test('编辑无 Token 店铺后继续引导录入 Token 且不执行连接检查', async ({ page }) => {
    await mockWbApis(page);
    const storeItems = [wbStore({
      displayName: 'WB 未配置店铺',
      credential: { state: 'MISSING', configured: false },
      seller: {},
      permissions: [],
      preflight: { status: 'NOT_RUN' },
      readiness: { ready: false, blockers: ['尚未配置 Token'] }
    })];
    await mockWbStoreSettingsApis(page, storeItems);
    let preflightCalls = 0;
    await page.route(/\/api\/v1\/wb\/stores\/store-main$/, async (route) => {
      storeItems[0] = wbStore({ ...storeItems[0], ...route.request().postDataJSON(), rowVersion: 2, configVersion: 2 });
      await route.fulfill({ json: { store: storeItems[0] } });
    });
    await page.route(/\/api\/v1\/wb\/stores\/store-main\/preflight$/, (route) => {
      preflightCalls += 1;
      return route.fulfill({ json: { accepted: true, store: storeItems[0] } });
    });

    await page.goto('/listing/wb');
    await page.locator('.wb-page-title').getByRole('button', { name: '打开WB上品设置' }).click();
    const settingsDrawer = page.getByRole('dialog', { name: 'WB上品设置' });
    await settingsDrawer.locator('.wb-store-card-item').filter({ hasText: 'WB 未配置店铺' }).getByRole('button', { name: '编辑' }).click();
    await page.getByRole('dialog', { name: '编辑店铺 · WB 未配置店铺' }).getByRole('button', { name: '保存店铺' }).click();

    await expect(page.getByRole('dialog', { name: '设置 Token · WB 未配置店铺' })).toBeVisible();
    expect(preflightCalls).toBe(0);
  });

  test('新建店铺后继续引导录入 Token 且不自动执行连接检查', async ({ page }) => {
    await mockWbApis(page);
    await mockWbStoreSettingsApis(page, []);
    let createCalls = 0;
    let preflightCalls = 0;
    const createdStore = wbStore({
      id: 'store-created',
      storeAlias: 'new-store',
      displayName: 'WB 新店铺',
      enabled: false,
      autoPublishEnabled: false,
      credential: { state: 'MISSING', configured: false },
      seller: {},
      permissions: [],
      preflight: { status: 'NOT_RUN' },
      readiness: { ready: false, blockers: ['店铺未启用', '尚未配置 Token'] }
    });
    await page.route(/\/api\/v1\/wb\/stores$/, (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      createCalls += 1;
      return route.fulfill({ json: { store: createdStore } });
    });
    await page.route(/\/api\/v1\/wb\/stores\/store-created\/preflight$/, (route) => {
      preflightCalls += 1;
      return route.fulfill({ json: { accepted: true, store: createdStore } });
    });

    await page.goto('/listing/wb');
    await page.locator('.wb-page-title').getByRole('button', { name: '打开WB上品设置' }).click();
    const settingsDrawer = page.getByRole('dialog', { name: 'WB上品设置' });
    await settingsDrawer.getByRole('button', { name: '新建店铺' }).click();
    const editor = page.getByRole('dialog', { name: '新建 WB 店铺' });
    await editor.getByLabel('店铺别名').fill('new-store');
    await editor.getByLabel('店铺显示名称').fill('WB 新店铺');
    await editor.getByRole('button', { name: '创建店铺' }).click();

    await expect.poll(() => createCalls).toBe(1);
    await expect(page.getByRole('dialog', { name: '设置 Token · WB 新店铺' })).toBeVisible();
    expect(preflightCalls).toBe(0);
  });

  test('WB 店铺卡片一店一行，异常自动展开且轮询不丢失用户展开状态', async ({ page }) => {
    await mockWbApis(page);
    const longWarehouse = 'CEL_超长名称_莫斯科中央仓_Activated_2026';
    const storesApi = await mockWbStoreSettingsApis(page, [
      wbStore(),
      wbStore({
        id: 'store-second',
        storeAlias: 'second-store-with-long-alias',
        displayName: 'WB 第二店铺·超长显示名称用于验证省略布局',
        defaultPresetId: 'preset-second',
        warehouseId: '1802669',
        warehouseName: longWarehouse,
        seller: { id: 'seller-second', name: '第二店铺账号' },
        permissions: ['content'],
        preflight: { status: 'PENDING', errorMessage: '正在重新确认价格与仓库权限' },
        network: { status: 'WAITING' },
        readiness: { ready: false, blockers: ['等待店铺连接检查完成', '默认预设待确认'] },
        activeTaskCount: 1,
        queuedTaskCount: 3
      })
    ]);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/listing/wb');
    await page.locator('.wb-page-title').getByRole('button', { name: '打开WB上品设置' }).click();

    const drawer = page.locator('.wb-store-settings-drawer');
    await expect(drawer.getByText('WB上品设置', { exact: true })).toBeVisible();
    const storeList = drawer.getByRole('list', { name: 'WB 店铺列表' });
    const cards = storeList.getByRole('listitem');
    await expect(cards).toHaveCount(2);

    const mainStore = cards.filter({ hasText: 'WB 主店铺' });
    const secondStore = cards.filter({ hasText: 'WB 第二店铺' });
    const mainToggle = mainStore.getByRole('button', { name: '展开详情', exact: true });
    const secondToggle = secondStore.getByRole('button', { name: '收起详情', exact: true });
    await expect(mainToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(secondToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(secondStore.locator('.wb-store-card-details')).toBeVisible();

    for (const action of ['编辑', '替换 Token', '连接检查', '停用', '归档']) {
      await expect(mainStore.getByRole('button', { name: new RegExp(`${action}$`) })).toBeVisible();
    }
    await expect(secondStore.locator('.wb-store-card-title h3')).toHaveAttribute('title', 'WB 第二店铺·超长显示名称用于验证省略布局');
    await expect(secondStore.locator('.wb-store-card-quickfacts strong').first()).toHaveAttribute('title', longWarehouse);

    const cardRects = await cards.evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width };
    }));
    expect(Math.abs(cardRects[0].left - cardRects[1].left)).toBeLessThanOrEqual(1);
    expect(Math.abs(cardRects[0].width - cardRects[1].width)).toBeLessThanOrEqual(1);
    expect(cardRects[1].top).toBeGreaterThan(cardRects[0].bottom);
    expect(cardRects[0].width).toBeGreaterThan(1_000);

    await mainToggle.click();
    await expect(mainStore.getByRole('button', { name: '收起详情', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(secondToggle).toHaveAttribute('aria-expanded', 'true');
    const requestCountBeforePoll = storesApi.storeRequestCount();
    await expect.poll(storesApi.storeRequestCount, { timeout: 5_000 }).toBeGreaterThan(requestCountBeforePoll);
    await expect(mainStore.getByRole('button', { name: '收起详情', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(secondStore.getByRole('button', { name: '收起详情', exact: true })).toHaveAttribute('aria-expanded', 'true');

    await drawer.locator('.ant-drawer-close').click();
    await expect(drawer).not.toBeVisible();
    await page.locator('.wb-page-title').getByRole('button', { name: '打开WB上品设置' }).click();
    await expect(mainStore.getByRole('button', { name: '展开详情', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(secondStore.getByRole('button', { name: '收起详情', exact: true })).toHaveAttribute('aria-expanded', 'true');

    await page.setViewportSize({ width: 320, height: 720 });
    await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const mobileActionButtons = mainStore.locator('.wb-store-actions .ant-btn');
    await expect(mobileActionButtons).toHaveCount(5);
    await expect.poll(async () => mobileActionButtons.evaluateAll((buttons) => Math.min(...buttons.map((button) => button.getBoundingClientRect().height)))).toBeGreaterThanOrEqual(44);
  });

  test('WB标题内打开当前上品设置 Drawer，未保存公共设置需确认放弃', async ({ page }) => {
    let configReady = true;
    await mockWbApis(page);
    await mockWbStoreSettingsApis(page, [wbStore()]);
    await page.route('**/api/v1/config', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.config.version = 'v003';
      body.config.wbPublishing = configReady ? { enabled: true, rootDirectory: 'D:\\MerchRoute-WB' } : { enabled: false, rootDirectory: '' };
      body.wbPublishingReadiness = configReady
        ? { status: 'READY', complete: true, enabled: true, rootDirectory: 'D:\\MerchRoute-WB', derivedDirectoryPattern: 'D:\\MerchRoute-WB\\inbox\\<SKU>\\variants', local: { path: 'D:\\MerchRoute-WB', exists: true, readable: true, writable: true, checkedAt: '2026-07-15T00:00:00.000Z' }, n8nSync: { status: 'synced', remoteRootDirectory: 'D:\\MerchRoute-WB' } }
        : { status: 'DISABLED', complete: false, enabled: false, rootDirectory: '', derivedDirectoryPattern: '<根目录>\\inbox\\<SKU>\\variants', n8nSync: { status: 'disabled' } };
      await route.fulfill({ response, json: body });
    });
    await page.goto('/listing/wb');
    const pageTitle = page.locator('.wb-page-title');
    const settingsButton = pageTitle.getByRole('button', { name: '打开WB上品设置' });
    await expect(pageTitle.locator('.wb-page-seal + .wb-page-settings-trigger')).toBeVisible();
    await expect(settingsButton).toBeVisible();
    await expect(page.locator('.wb-settings-card')).toHaveCount(0);

    await settingsButton.click();
    const drawer = page.locator('.wb-store-settings-drawer');
    await expect(drawer.getByText('WB上品设置', { exact: true })).toBeVisible();
    await drawer.getByRole('tab', { name: '公共目录与集成' }).click();
    await expect(drawer.getByLabel('WB 自动上品根目录')).toHaveValue('D:\\MerchRoute-WB');

    await drawer.getByLabel('WB 自动上品根目录').fill('D:\\Changed-WB');
    await drawer.locator('.ant-drawer-close').click();
    let discardConfirm = page.locator('.ant-modal-confirm').filter({ hasText: '放弃未保存的 WB 公共设置？' });
    await expect(discardConfirm).toBeVisible();
    await discardConfirm.getByRole('button', { name: '继续编辑' }).click();
    await expect(discardConfirm).not.toBeVisible();
    await expect(drawer).toBeVisible();
    await expect(drawer.getByLabel('WB 自动上品根目录')).toHaveValue('D:\\Changed-WB');

    await drawer.locator('.ant-drawer-close').click();
    discardConfirm = page.locator('.ant-modal-confirm').filter({ hasText: '放弃未保存的 WB 公共设置？' });
    await discardConfirm.getByRole('button', { name: '放弃修改' }).click();
    await expect(drawer).not.toBeVisible();
    await settingsButton.click();
    await drawer.getByRole('tab', { name: '公共目录与集成' }).click();
    await expect(drawer.getByLabel('WB 自动上品根目录')).toHaveValue('D:\\MerchRoute-WB');
    await drawer.locator('.ant-drawer-close').click();
    await expect(drawer).not.toBeVisible();

    await page.goto('/settings');
    await expect(page.locator('.wb-store-settings-drawer')).toHaveCount(0);

    configReady = false;
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/listing/wb?view=manual');
    await expect(page.locator('.wb-page-title').getByRole('button', { name: '打开WB上品设置' })).toBeVisible();
    const readinessAlert = page.locator('.ant-alert').filter({ hasText: 'WB 产品资料目录尚未就绪' });
    await expect(readinessAlert).toBeVisible();
    await readinessAlert.getByRole('button', { name: '打开WB上品设置' }).click();
    await expect(page.locator('.wb-store-settings-drawer')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
