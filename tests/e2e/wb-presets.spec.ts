import { expect, test, type Page } from '@playwright/test';

const pricingTemplateId = '7c9d6f4a-8f5c-4c3e-9a80-000000000001';
const shippingTemplateId = '6d8c5d9a-6ea7-4f28-9ba0-000000000003';
const categoryKey = 'adult_casual_sneakers';

const category = {
  categoryKey,
  nameRu: 'Кроссовки',
  nameZh: '休闲运动鞋',
  subjectId: 105,
  active: true,
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
  publishedVersion: {
    id: 'category-version-4', versionNo: 4, nameRu: 'Кроссовки', nameZh: '休闲运动鞋',
    schemaHash: 'sha256:e2e', confirmedBy: 'QA', confirmedAt: '2026-07-18T00:00:00.000Z', publishedAt: '2026-07-18T00:00:00.000Z'
  },
  projection: { status: 'SYNCED', sourceVersionId: 'category-version-4', definitionHash: 'sha256:e2e', syncedAt: '2026-07-18T00:00:00.000Z' }
};

const resolvedDependencies = {
  pricing: { id: pricingTemplateId, name: 'WB平台默认定价V1', versionId: 'pricing-v2', versionNo: 2, snapshotVersionId: 'pricing-v2', snapshotVersionNo: 2, status: 'PUBLISHED' },
  shipping: { id: shippingTemplateId, name: 'CELWBV5.23', versionId: 'shipping-v1', versionNo: 1, snapshotVersionId: 'shipping-v1', snapshotVersionNo: 1, status: 'PUBLISHED' },
  category: { id: categoryKey, name: '休闲运动鞋', versionId: 'category-version-4', versionNo: 4, snapshotVersionId: 'category-version-4', snapshotVersionNo: 4, status: 'PUBLISHED' }
};

const basePresetInput = {
  name: 'WB 鞋类默认上品 V1',
  description: '适用于鞋类日常上品',
  autoPublishEnabled: false,
  autoPublishMode: 'CREATE_ONLY' as const,
  pricingTemplateId,
  shippingTemplateId,
  shippingServiceCode: 'CEL_WB_ECONOMY',
  packaging: { grossWeightGrams: 750, lengthCm: 30, widthCm: 20, heightCm: 12 },
  categoryKey,
  discountPercent: 50,
  clubDiscount: null,
  tnved: '6404110000',
  brand: '',
  sharedCharacteristics: [],
  variantCharacteristics: [],
  titleTranslation: { workflowId: 'W2lSSXE3NUaLW1tD', language: '俄文', maxLength: 60 },
  descriptionSource: 'E003' as const,
  sizes: [{ sizeId: '11111111-1111-4111-8111-111111111111', techSize: '38', wbSize: '38', insoleLengthCm: 24.5, stock: 10 }]
};

function preset(input: Partial<typeof basePresetInput> & { id?: string; name?: string; isDefault?: boolean; rowVersion?: number; autoPublishActivatedAt?: string; activeBoundJobCount?: number } = {}) {
  return {
    ...basePresetInput,
    ...input,
    id: input.id || 'preset-default',
    rowVersion: input.rowVersion || 1,
    isDefault: input.isDefault ?? true,
    readiness: 'READY',
    issues: [],
    resolvedDependencies,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z'
  };
}

async function mockReadyConfig(page: Page) {
  await page.route('**/api/v1/config', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.config.version = 'v003';
    body.config.wbPublishing = { enabled: true, rootDirectory: 'D:\\MerchRoute-WB' };
    body.wbPublishingReadiness = {
      status: 'READY', complete: true, enabled: true, rootDirectory: 'D:\\MerchRoute-WB',
      derivedDirectoryPattern: 'D:\\MerchRoute-WB\\inbox\\<SKU>\\variants',
      local: { path: 'D:\\MerchRoute-WB', exists: true, readable: true, writable: true, checkedAt: '2026-07-18T00:00:00.000Z' },
      n8nSync: { status: 'synced', remoteRootDirectory: 'D:\\MerchRoute-WB' }
    };
    await route.fulfill({ response, json: body });
  });
}

async function mockPresetDependencies(page: Page) {
  await page.route(/\/api\/v1\/pricing\/templates$/, async (route) => route.fulfill({ json: { items: [{
    id: pricingTemplateId, name: 'WB平台默认定价V1', platformCode: 'WB', platformName: 'Wildberries', active: true,
    createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
    publishedVersion: { id: 'pricing-v2', versionNo: 2, publishedAt: '2026-07-18T00:00:00.000Z' }
  }] } }));
  await page.route(/\/api\/v1\/shipping\/templates$/, async (route) => route.fulfill({ json: { items: [{
    id: shippingTemplateId, name: 'CELWBV5.23', platformCode: 'WB', platformName: 'Wildberries', carrierCode: 'CEL', carrierName: 'CEL物流',
    carrierActive: true, active: true, createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
    publishedVersion: { id: 'shipping-v1', versionNo: 1, publishedAt: '2026-07-18T00:00:00.000Z' }
  }] } }));
  await page.route(new RegExp(`/api/v1/shipping/templates/${shippingTemplateId}$`), async (route) => route.fulfill({ json: { template: {
    id: shippingTemplateId, name: 'CELWBV5.23', platformCode: 'WB', platformName: 'Wildberries', carrierCode: 'CEL', carrierName: 'CEL物流', carrierActive: true, active: true,
    createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z', versions: [{
      id: 'shipping-v1', versionNo: 1, status: 'PUBLISHED', createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z', publishedAt: '2026-07-18T00:00:00.000Z',
      definition: { services: [{ code: 'CEL_WB_ECONOMY', name: 'CEL Wb-Economy', rules: [{ destinationCountryCodes: [] }] }] }
    }]
  } } }));
  await page.route(/\/api\/v1\/wb\/categories$/, async (route) => route.fulfill({ json: { items: [category] } }));
  await page.route(new RegExp(`/api/v1/wb/categories/${categoryKey}$`), async (route) => route.fulfill({ json: { category: {
    ...category,
    versions: [{
      id: 'category-version-4', versionNo: 4, status: 'PUBLISHED', subjectId: 105, schemaHash: 'sha256:e2e', liveSchema: {},
      formConfig: { sizeMode: 'sized', fields: [
        { fieldId: 'gender', characteristicId: 204557, labelRu: 'Пол', labelZh: '性别', scope: 'shared', control: 'select', required: true, order: 10, directory: 'kinds' },
        { fieldId: 'material', characteristicId: 14177450, labelRu: 'Материал', labelZh: '材质', scope: 'shared', control: 'text', required: false, order: 20 },
        { fieldId: 'product-height', characteristicId: 90630, labelRu: 'Высота предмета', labelZh: '物体高度', scope: 'shared', control: 'number', required: false, order: 21 },
        { fieldId: 'product-depth', characteristicId: 90652, labelRu: 'Глубина предмета', labelZh: '物体深度', scope: 'shared', control: 'number', required: false, order: 22 },
        { fieldId: 'product-width', characteristicId: 90673, labelRu: 'Ширина предмета', labelZh: '物体宽度', scope: 'shared', control: 'number', required: false, order: 23 },
        { fieldId: 'net-weight', characteristicId: 89008, labelRu: 'Вес товара без упаковки (г)', labelZh: '无包装重量', scope: 'shared', control: 'number', required: false, order: 24 },
        { fieldId: 'tnved', characteristicId: 15004139, labelRu: 'Код ТН ВЭД', labelZh: '海关编码', scope: 'shared', control: 'select', required: false, order: 30 },
        { fieldId: 'color', characteristicId: 14177449, labelRu: 'Цвет', labelZh: '颜色', scope: 'variant', control: 'select', required: true, order: 40, directory: 'colors' }
      ], media: { minImages: 1, maxImages: 30, videoAllowed: true, defaultVideoUploadMode: 'COMPRESSED_COPY' }, compliance: { tnvedCharacteristicId: 15004139, tnvedRequired: false } },
      managedCharacteristicIds: [204557, 14177450, 90630, 90652, 90673, 89008, 15004139, 14177449], confirmedBy: 'QA', confirmedAt: '2026-07-18T00:00:00.000Z',
      createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z', publishedAt: '2026-07-18T00:00:00.000Z'
    }]
  } } }));
  await page.route(/\/api\/v1\/wb\/catalog\/directories\/tnved\?.*/, async (route) => route.fulfill({ json: [{ tnved: '6404110000', isKiz: true }] }));
  await page.route(/\/api\/v1\/wb\/catalog\/dictionaries\/(kinds|colors)\?.*/, async (route) => {
    const directory = new URL(route.request().url()).pathname.split('/').pop();
    const items = directory === 'kinds'
      ? [{ itemKey: 'female', nameRu: 'Женский', nameZh: '女性', fullNameRu: 'Женский', fullNameZh: '女性' }]
      : [{ itemKey: 'black', nameRu: 'Черный', nameZh: '黑色', fullNameRu: 'Черный', fullNameZh: '黑色', parentNameRu: 'Основные цвета', parentNameZh: '基础颜色' }];
    await route.fulfill({ json: { directory, items, catalog: { status: 'READY' } } });
  });
}

async function confirmPresetDeletion(page: Page) {
  const dialog = page.getByRole('dialog', { name: /删除预设/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).not.toHaveClass(/ant-zoom-appear/);
  await dialog.getByRole('button', { name: '删除预设' }).click();
}

async function chooseSelect(page: Page, drawer: ReturnType<Page['locator']>, label: string, option: string) {
  const item = drawer.locator('.ant-form-item').filter({ hasText: label }).first();
  await item.locator('.ant-select-selector').click();
  await page.locator('.ant-select-item-option').filter({ hasText: option }).last().click();
}

test.describe('WB 上品预设模板与默认初始化', () => {
  test('预设列表只展示商品蓝图并引导按店铺绑定', async ({ page }) => {
    await mockReadyConfig(page);
    const items = [
      preset({ id: 'preset-default', name: '默认自动预设', isDefault: true, autoPublishEnabled: true, autoPublishMode: 'COMPATIBLE_UPSERT', autoPublishActivatedAt: '2026-07-19T02:00:00.000Z' }),
      preset({ id: 'preset-waiting', name: '候选自动预设', isDefault: false, autoPublishEnabled: true, activeBoundJobCount: 2 }),
      preset({ id: 'preset-off', name: '人工预设', isDefault: false, autoPublishEnabled: false })
    ];
    await page.route(/\/api\/v1\/wb\/presets$/, async (route) => route.fulfill({ json: { items } }));
    await page.route(/\/api\/v1\/wb\/listings\?.*/, async (route) => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));

    await page.goto('/listing/wb');
    await page.getByRole('tab', { name: '上品预设模板' }).click();
    for (const name of ['默认自动预设', '候选自动预设', '人工预设']) {
      const row = page.getByRole('row').filter({ hasText: name });
      await expect(row.getByText('按店铺绑定', { exact: true })).toBeVisible();
      await expect(row.getByText('前往 WB上品设置管理', { exact: true })).toBeVisible();
      await expect(row.getByRole('button', { name: '设为默认' })).toHaveCount(0);
    }
    const boundRow = page.getByRole('row').filter({ hasText: '候选自动预设' });
    await expect(boundRow.getByText('2', { exact: true })).toBeVisible();
    await expect(boundRow.getByText('切换后继续执行', { exact: true })).toBeVisible();
    await expect(page.getByText('兼容自动上品', { exact: true })).toHaveCount(0);
    await expect(page.getByText('自动上品关闭', { exact: true })).toHaveCount(0);
  });

  test('没有全局默认预设时仍可创建公共素材任务', async ({ page }) => {
    await mockReadyConfig(page);
    await page.route(/\/api\/v1\/wb\/presets$/, async (route) => route.fulfill({ json: { items: [] } }));
    await page.route(/\/api\/v1\/wb\/listings\?.*/, async (route) => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/purchases\?.*/, async (route) => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));

    await page.goto('/listing/wb?view=manual');
    const createButton = page.getByRole('button', { name: '新建上品资料' });
    await expect(createButton).toBeEnabled();
    await createButton.click();
    const dialog = page.getByRole('dialog', { name: '选择 MerchRoute 产品' });
    await expect(dialog.getByText('不会套用任何全局预设', { exact: true })).toBeVisible();
    await expect(dialog.getByText(/价格、折扣、类目、标题、详情、包装、特征和尺码在选择店铺后按该店默认预设生成/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: '创建公共素材任务' })).toBeDisabled();
  });

  test('预设按已发布类目渲染中俄 characteristic 默认值，两个区块可独立折叠', async ({ page }) => {
    await mockReadyConfig(page);
    await mockPresetDependencies(page);
    let createdBody: Record<string, any> | undefined;
    await page.route(/\/api\/v1\/wb\/listings\?.*/, async (route) => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/wb\/presets$/, async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { items: [] } });
      createdBody = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: { preset: preset({ ...createdBody, id: 'preset-characteristics', rowVersion: 1 }) } });
    });

    await page.goto('/listing/wb');
    await page.getByRole('tab', { name: '上品预设模板' }).click();
    await page.getByRole('button', { name: '新建上品预设' }).click();
    const drawer = page.locator('.wb-preset-drawer');
    await expect(drawer.getByText('采购管理最新采购版本的毛重优先用于定价和包装；仅当采购毛重为空、0 或非正数时，使用下方兜底毛重。包装长、宽、高始终使用本预设。', { exact: true })).toBeVisible();
    await expect(drawer.getByRole('spinbutton', { name: '兜底毛重 (g)' })).toHaveValue('500');
    await expect(drawer.getByText('采购毛重为空、0 或非正数时才使用此值。', { exact: true })).toBeVisible();
    await expect(drawer.locator('.ant-form-item').filter({ hasText: '上传视频' })).toHaveCount(0);
    await drawer.getByLabel('预设名称').fill('WB characteristic 预设');
    await chooseSelect(page, drawer, '默认定价模板', 'WB平台默认定价V1');
    await chooseSelect(page, drawer, '默认运费模板', 'CELWBV5.23');
    await chooseSelect(page, drawer, '服务渠道', 'CEL Wb-Economy');
    await chooseSelect(page, drawer, 'WB 类目模板', '休闲运动鞋');
    await expect(drawer.getByLabel('TNVED（非必填，可留空）')).toHaveValue('');

    const characteristicCard = drawer.locator('.wb-preset-collapsible').filter({ hasText: 'WB 类目字段' });
    const sizeCard = drawer.locator('.wb-preset-collapsible').filter({ hasText: '尺码与默认库存' });
    await expect(characteristicCard.getByText('所有变体共享', { exact: true })).toBeVisible();
    await expect(characteristicCard.getByText('每个变体的默认值', { exact: true })).toBeVisible();
    await expect(characteristicCard.getByText('采购管理自动取值', { exact: true })).toBeVisible();
    await expect(characteristicCard.getByText('该字段按 SKU 从采购管理最新采购版本获取，不保存预设默认值。', { exact: true })).toBeVisible();
    await expect(characteristicCard.getByText('物体高度', { exact: true })).toBeVisible();
    await expect(characteristicCard.getByText('无包装重量', { exact: true })).toBeVisible();
    await expect(characteristicCard.getByText('海关编码', { exact: true })).toHaveCount(0);
    const characteristicBox = await characteristicCard.boundingBox();
    const sizeBox = await sizeCard.boundingBox();
    expect(characteristicBox).not.toBeNull();
    expect(sizeBox).not.toBeNull();
    expect(characteristicBox!.y).toBeLessThan(sizeBox!.y);

    await characteristicCard.locator('button[aria-expanded="true"]').click();
    await expect(characteristicCard.getByText('所有变体共享', { exact: true })).toHaveCount(0);
    await expect(sizeCard.getByRole('textbox', { name: '预设 techSize 1' })).toBeVisible();
    await characteristicCard.locator('button[aria-expanded="false"]').click();
    await sizeCard.locator('button[aria-expanded="true"]').click();
    await expect(sizeCard.getByRole('textbox', { name: '预设 techSize 1' })).toHaveCount(0);
    await expect(characteristicCard.getByRole('combobox', { name: '性别 characteristic 204557' })).toBeVisible();
    await sizeCard.locator('button[aria-expanded="false"]').click();

    await chooseSelect(page, characteristicCard, '性别', '女性 / Женский');
    await characteristicCard.getByLabel('材质 characteristic 14177450').fill('текстиль');
    await chooseSelect(page, characteristicCard, '颜色', '黑色 / Черный');
    await sizeCard.getByRole('textbox', { name: '预设 techSize 1' }).fill('38');
    await drawer.getByRole('button', { name: '创建预设' }).click();
    await expect(page.getByText('预设“WB characteristic 预设”已创建')).toBeVisible();
    expect(createdBody).toMatchObject({
      tnved: '',
      sharedCharacteristics: [
        { id: 204557, value: ['Женский'] },
        { id: 14177450, value: ['текстиль'] }
      ],
      variantCharacteristics: [{ id: 14177449, value: ['Черный'] }]
    });
    expect(createdBody).not.toHaveProperty('videoUploadMode');
    expect(createdBody?.sharedCharacteristics).not.toContainEqual(expect.objectContaining({ id: 15004139 }));
    for (const characteristicId of [90630, 90652, 90673, 89008]) {
      expect(createdBody?.sharedCharacteristics).not.toContainEqual(expect.objectContaining({ id: characteristicId }));
      expect(createdBody?.variantCharacteristics).not.toContainEqual(expect.objectContaining({ id: characteristicId }));
    }
  });

  test('编辑预设只保存商品蓝图，不写入全局默认状态', async ({ page }) => {
    await mockReadyConfig(page);
    await mockPresetDependencies(page);
    let items = [preset({ id: 'preset-candidate', name: '候选预设', isDefault: false, rowVersion: 7 })];
    const writeRequests: Array<{ method: string; pathname: string; body: Record<string, unknown> }> = [];

    await page.route(/\/api\/v1\/wb\/listings\?.*/, async (route) => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/wb\/presets(?:\/[^?]+)?(?:\?.*)?$/, async (route) => {
      const url = new URL(route.request().url());
      const parts = url.pathname.split('/').filter(Boolean);
      const id = parts[4];
      const method = route.request().method();
      if (!id && method === 'GET') return route.fulfill({ json: { items } });
      const current = items.find((item) => item.id === id);
      if (!current) return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: '预设不存在' } } });
      if (method === 'GET') return route.fulfill({ json: { preset: current } });
      if (method === 'PUT') {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        writeRequests.push({ method, pathname: url.pathname, body });
        const saved = preset({ ...current, ...body, id, rowVersion: current.rowVersion + 1, isDefault: false });
        items = [saved];
        return route.fulfill({ json: { preset: saved } });
      }
      return route.abort();
    });

    await page.goto('/listing/wb');
    await page.getByRole('tab', { name: '上品预设模板' }).click();

    const candidateRow = page.getByRole('row').filter({ hasText: '候选预设' });
    await candidateRow.getByRole('button', { name: '编辑' }).click();
    const drawer = page.locator('.wb-preset-drawer');
    await expect(drawer.getByText('预设按店铺绑定', { exact: true })).toBeVisible();
    await expect(drawer.getByRole('switch', { name: '设为默认' })).toHaveCount(0);
    await expect(drawer.getByRole('switch', { name: '自动上品' })).toHaveCount(0);
    await drawer.getByLabel('使用说明').fill('  确认同时保存说明  ');
    const saveButton = drawer.getByRole('button', { name: '保存修改' });
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(page.getByText('预设“候选预设”已保存')).toBeVisible();
    await expect(drawer).toBeHidden();

    expect(writeRequests).toHaveLength(1);
    expect(writeRequests[0]).toMatchObject({
      method: 'PUT',
      pathname: '/api/v1/wb/presets/preset-candidate',
      body: { description: '确认同时保存说明', rowVersion: 7 }
    });
    expect(writeRequests[0]?.body).not.toHaveProperty('isDefault');
    expect(items[0]).toMatchObject({ isDefault: false, rowVersion: 8, description: '确认同时保存说明' });
    await expect(page.getByRole('row').filter({ hasText: '候选预设' }).getByText('按店铺绑定', { exact: true })).toBeVisible();
  });

  test('上品预设完成创建、编辑、复制和删除，尺码输入不丢焦点', async ({ page }) => {
    await mockReadyConfig(page);
    await mockPresetDependencies(page);
    let sequence = 0;
    let items: ReturnType<typeof preset>[] = [];
    let createdSizeId = '';
    let updateBody: Record<string, unknown> | undefined;
    const deleteRowVersions: string[] = [];

    await page.route(/\/api\/v1\/wb\/listings\?.*/, async (route) => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/wb\/presets(?:\/[^?]+)?(?:\?.*)?$/, async (route) => {
      const url = new URL(route.request().url());
      const parts = url.pathname.split('/').filter(Boolean);
      const id = parts[4];
      const action = parts[5];
      const method = route.request().method();
      if (!id && method === 'GET') return route.fulfill({ json: { items } });
      if (!id && method === 'POST') {
        const body = route.request().postDataJSON();
        createdSizeId = body.sizes[0].sizeId;
        const created = preset({ ...body, id: `preset-${++sequence}`, rowVersion: 1, isDefault: false });
        items.push(created);
        return route.fulfill({ status: 201, json: { preset: created } });
      }
      const current = items.find((item) => item.id === id);
      if (!current) return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: '预设不存在' } } });
      if (!action && method === 'GET') return route.fulfill({ json: { preset: current } });
      if (!action && method === 'PUT') {
        updateBody = route.request().postDataJSON();
        const saved = preset({ ...current, ...updateBody, id, rowVersion: current.rowVersion + 1, isDefault: false });
        items = items.map((item) => item.id === id ? saved : item);
        return route.fulfill({ json: { preset: saved } });
      }
      if (!action && method === 'DELETE') {
        deleteRowVersions.push(String(url.searchParams.get('rowVersion')));
        items = items.filter((item) => item.id !== id);
        return route.fulfill({ json: { deleted: { id, name: current.name } } });
      }
      if (action === 'clone' && method === 'POST') {
        const body = route.request().postDataJSON();
        const cloned = preset({ ...current, id: `preset-${++sequence}`, name: body.name, autoPublishEnabled: false, rowVersion: 1, isDefault: false });
        items.push(cloned);
        return route.fulfill({ status: 201, json: { preset: cloned } });
      }
      return route.abort();
    });

    await page.goto('/listing/wb');
    await page.getByRole('tab', { name: '上品预设模板' }).click();
    await page.getByRole('button', { name: '新建上品预设' }).click();
    const drawer = page.locator('.wb-preset-drawer');
    await drawer.getByLabel('预设名称').fill(basePresetInput.name);
    await chooseSelect(page, drawer, '默认定价模板', 'WB平台默认定价V1');
    await chooseSelect(page, drawer, '默认运费模板', 'CELWBV5.23');
    await chooseSelect(page, drawer, '服务渠道', 'CEL Wb-Economy');
    await chooseSelect(page, drawer, 'WB 类目模板', '休闲运动鞋');
    await drawer.getByLabel('TNVED（非必填，可留空）').fill('6404110000');
    await expect(drawer.getByText('预设按店铺绑定', { exact: true })).toBeVisible();
    await expect(drawer.getByRole('switch', { name: '自动上品' })).toHaveCount(0);
    await expect(drawer.getByRole('switch', { name: '设为默认' })).toHaveCount(0);
    const techSize = drawer.getByRole('textbox', { name: '预设 techSize 1' });
    await expect(techSize).toHaveAttribute('aria-invalid', 'true');
    await techSize.pressSequentially('38');
    await expect(techSize).toHaveValue('38');
    await expect(techSize).toBeFocused();
    await drawer.getByLabel('预设 wbSize 1').fill('38');
    await drawer.getByRole('button', { name: '创建预设' }).click();
    await expect(page.getByText(`预设“${basePresetInput.name}”已创建`)).toBeVisible();
    expect(items[0]).toMatchObject({ autoPublishEnabled: false, autoPublishMode: 'CREATE_ONLY', isDefault: false });

    const originalRow = page.getByRole('row').filter({ hasText: basePresetInput.name }).first();
    await expect(originalRow.getByText('按店铺绑定', { exact: true })).toBeVisible();
    await expect(originalRow.getByRole('button', { name: '设为默认' })).toHaveCount(0);
    await expect(originalRow.getByText('上架价 CNY', { exact: true })).toBeVisible();
    await expect(originalRow.getByText(/视频 (原视频|压缩副本)/)).toHaveCount(0);
    await originalRow.getByRole('button', { name: '编辑' }).click();
    const editDrawer = page.locator('.wb-preset-drawer');
    await expect(editDrawer.locator('.ant-form-item').filter({ hasText: '上传视频' })).toHaveCount(0);
    const editedSize = editDrawer.getByRole('textbox', { name: '预设 techSize 1' });
    await editedSize.fill('');
    await editedSize.pressSequentially('42');
    await expect(editedSize).toHaveValue('42');
    await expect(editedSize).toBeFocused();
    await editDrawer.getByRole('button', { name: '保存修改' }).click();
    await expect(page.getByText(`预设“${basePresetInput.name}”已保存`)).toBeVisible();
    expect(updateBody).toMatchObject({ rowVersion: 1, sizes: [expect.objectContaining({ sizeId: createdSizeId, techSize: '42' })] });
    expect(updateBody).not.toHaveProperty('videoUploadMode');

    const savedRow = page.getByRole('row').filter({ hasText: basePresetInput.name }).first();
    await savedRow.getByRole('button', { name: '复制' }).click();
    await expect(page.getByText(`已复制为“${basePresetInput.name} 副本”`)).toBeVisible();
    await page.locator('.wb-preset-drawer').getByRole('button', { name: 'Close' }).click();
    const cloneRow = page.getByRole('row').filter({ hasText: `${basePresetInput.name} 副本` });
    await expect(cloneRow).toBeVisible();
    await expect(cloneRow.getByText('按店铺绑定', { exact: true })).toBeVisible();
    await expect(cloneRow.getByRole('button', { name: '设为默认' })).toHaveCount(0);

    const refreshedOriginal = page.getByRole('row').filter({ hasText: basePresetInput.name }).filter({ hasNotText: '副本' });
    await refreshedOriginal.getByRole('button', { name: '删除' }).click();
    await confirmPresetDeletion(page);
    await expect(page.getByText(`已删除“${basePresetInput.name}”`)).toBeVisible();
    expect(deleteRowVersions).toEqual(['2']);
    await expect(page.getByRole('row').filter({ hasText: basePresetInput.name }).filter({ hasNotText: '副本' })).toHaveCount(0);

    const remainingClone = page.getByRole('row').filter({ hasText: `${basePresetInput.name} 副本` });
    await remainingClone.getByRole('button', { name: '删除' }).click();
    await confirmPresetDeletion(page);
    await expect(page.getByText(`已删除“${basePresetInput.name} 副本”`)).toBeVisible();
    expect(deleteRowVersions).toEqual(['2', '1']);
    await page.getByRole('tab', { name: '手动上品资料' }).click();
    const createMaterialButton = page.getByRole('button', { name: '新建上品资料' });
    await expect(createMaterialButton).toBeEnabled();
    await createMaterialButton.click();
    await expect(page.getByRole('dialog', { name: '选择 MerchRoute 产品' }).getByText('不会套用任何全局预设', { exact: true })).toBeVisible();
  });

  test('新建手动资料只创建公共素材任务，不再套用全局预设', async ({ page }) => {
    await mockReadyConfig(page);
    await mockPresetDependencies(page);
    const defaultPreset = preset();
    const listing = {
      sku: '0000001', productName: 'E2E 预设初始化产品', status: 'DRAFT', draftVersion: 1, revision: 1,
      categoryKey: '', brand: '', titleRu: '', descriptionRu: '', packaging: {}, priceCny: 0, discountPercent: 0, clubDiscount: null,
      compliance: { tnved: '', kizMarked: false }, sharedCharacteristics: [],
      variants: [{ variantId: 'variant-1', variantCode: '0000001-01', vendorCode: '0000001-01', characteristics: [], sizes: [] }],
      mediaAssets: [], variantMedia: [{ variantId: 'variant-1', imageAssetIds: [] }]
    };
    let createBody: unknown;
    await page.route(/\/api\/v1\/wb\/presets$/, async (route) => route.fulfill({ json: { items: [defaultPreset] } }));
    await page.route(/\/api\/v1\/wb\/listings\?.*/, async (route) => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/purchases\?.*/, async (route) => route.fulfill({ json: { items: [{ sku: '0000001', productName: listing.productName }], total: 1, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/wb\/listings$/, async (route) => {
      createBody = route.request().postDataJSON();
      await route.fulfill({ status: 201, json: { listing } });
    });
    await page.route(/\/api\/v1\/wb\/listings\/0000001\/status$/, async (route) => route.fulfill({ json: { listing } }));
    await page.route(/\/api\/v1\/wb\/listings\/0000001\/publications$/, async (route) => route.fulfill({ json: { items: [] } }));

    await page.goto('/listing/wb?view=manual');
    await page.getByRole('button', { name: '新建上品资料' }).click();
    await page.getByRole('combobox', { name: '产品 SKU' }).click();
    await page.locator('.ant-select-item-option').filter({ hasText: '0000001' }).click();
    const createDialog = page.getByRole('dialog', { name: '选择 MerchRoute 产品' });
    await expect(createDialog.getByText('不会套用任何全局预设', { exact: true })).toBeVisible();
    await createDialog.getByRole('button', { name: '创建公共素材任务' }).click();
    await expect(page.getByText('SKU 0000001 的公共素材任务已创建', { exact: true })).toBeVisible();
    expect(createBody).toEqual({ sku: '0000001' });
    const drawer = page.locator('.wb-listing-drawer');
    await expect(drawer.getByText('公共素材任务', { exact: true })).toBeVisible();
    await expect(drawer.getByText(/价格、折扣、类目、标题、详情、包装、特征和尺码由所选店铺的默认预设生成/)).toBeVisible();
    await expect(drawer.getByText(`已应用预设“${defaultPreset.name}”`)).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: '重试缺失项' })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: '保存媒体顺序' })).toBeVisible();
  });

  test('不支持 TNVED 的类目允许留空保存且不查询 WB 目录', async ({ page }) => {
    await mockReadyConfig(page);
    await mockPresetDependencies(page);
    let createdBody: Record<string, any> | undefined;
    let tnvedRequests = 0;
    await page.route(new RegExp(`/api/v1/wb/categories/${categoryKey}$`), async (route) => route.fulfill({ json: { category: {
      ...category,
      versions: [{
        id: 'category-version-4', versionNo: 4, status: 'PUBLISHED', subjectId: 105, schemaHash: 'sha256:e2e', liveSchema: {},
        formConfig: { sizeMode: 'sized', fields: [
          { fieldId: 'gender', characteristicId: 204557, labelRu: 'Пол', labelZh: '性别', scope: 'shared', control: 'select', required: true, order: 10, directory: 'kinds' },
          { fieldId: 'color', characteristicId: 14177449, labelRu: 'Цвет', labelZh: '颜色', scope: 'variant', control: 'select', required: true, order: 20, directory: 'colors' }
        ], media: { minImages: 1, maxImages: 30, videoAllowed: true, defaultVideoUploadMode: 'COMPRESSED_COPY' }, compliance: { tnvedRequired: false } },
        managedCharacteristicIds: [204557, 14177449], confirmedBy: 'QA', confirmedAt: '2026-07-18T00:00:00.000Z',
        createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z', publishedAt: '2026-07-18T00:00:00.000Z'
      }]
    } } }));
    await page.route(/\/api\/v1\/wb\/catalog\/directories\/tnved\?.*/, async (route) => {
      tnvedRequests += 1;
      await route.fulfill({ json: [] });
    });
    await page.route(/\/api\/v1\/wb\/listings\?.*/, async (route) => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/wb\/presets$/, async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { items: [] } });
      createdBody = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: { preset: preset({ ...createdBody, id: 'preset-no-tnved', rowVersion: 1 }) } });
    });

    await page.goto('/listing/wb');
    await page.getByRole('tab', { name: '上品预设模板' }).click();
    await page.getByRole('button', { name: '新建上品预设' }).click();
    const drawer = page.locator('.wb-preset-drawer');
    await drawer.getByLabel('预设名称').fill('无需 TNVED 的类目预设');
    await chooseSelect(page, drawer, '默认定价模板', 'WB平台默认定价V1');
    await chooseSelect(page, drawer, '默认运费模板', 'CELWBV5.23');
    await chooseSelect(page, drawer, '服务渠道', 'CEL Wb-Economy');
    await chooseSelect(page, drawer, 'WB 类目模板', '休闲运动鞋');
    const tnved = drawer.getByLabel('TNVED');
    await expect(tnved).toBeDisabled();
    await expect(drawer.getByText('当前类目不使用 TNVED', { exact: true })).toBeVisible();
    await drawer.getByRole('textbox', { name: '预设 techSize 1' }).fill('38');
    await drawer.getByRole('button', { name: '创建预设' }).click();
    await expect(page.getByText('预设“无需 TNVED 的类目预设”已创建')).toBeVisible();
    expect(createdBody).toMatchObject({ tnved: '' });
    expect(tnvedRequests).toBe(0);
  });

  test('WB 标记 TNVED 必填时显示星号并阻止空值保存', async ({ page }) => {
    await mockReadyConfig(page);
    await mockPresetDependencies(page);
    let createRequests = 0;
    let tnvedRequests = 0;
    await page.unroute(new RegExp(`/api/v1/wb/categories/${categoryKey}$`));
    await page.route(new RegExp(`/api/v1/wb/categories/${categoryKey}$`), async (route) => route.fulfill({ json: { category: {
      ...category,
      versions: [{
        id: 'category-version-required', versionNo: 5, status: 'PUBLISHED', subjectId: 105, schemaHash: 'sha256:required', liveSchema: {},
        formConfig: { sizeMode: 'sized', fields: [
          { fieldId: 'gender', characteristicId: 204557, labelRu: 'Пол', labelZh: '性别', scope: 'shared', control: 'select', required: true, order: 10, directory: 'kinds' },
          { fieldId: 'tnved', characteristicId: 15004139, labelRu: 'Код ТН ВЭД', labelZh: '海关编码', scope: 'shared', control: 'select', required: true, order: 20 }
        ], media: { minImages: 1, maxImages: 30, videoAllowed: true, defaultVideoUploadMode: 'COMPRESSED_COPY' }, compliance: { tnvedCharacteristicId: 15004139, tnvedRequired: true } },
        managedCharacteristicIds: [204557, 15004139], confirmedBy: 'QA', confirmedAt: '2026-07-20T00:00:00.000Z',
        createdAt: '2026-07-20T00:00:00.000Z', updatedAt: '2026-07-20T00:00:00.000Z', publishedAt: '2026-07-20T00:00:00.000Z'
      }]
    } } }));
    await page.unroute(/\/api\/v1\/wb\/catalog\/directories\/tnved\?.*/);
    await page.route(/\/api\/v1\/wb\/catalog\/directories\/tnved\?.*/, async (route) => {
      tnvedRequests += 1;
      await route.fulfill({ json: [{ tnved: '6404110000', isKiz: true }] });
    });
    await page.route(/\/api\/v1\/wb\/listings\?.*/, async (route) => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/wb\/presets$/, async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { items: [] } });
      createRequests += 1;
      const body = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: { preset: preset({ ...body, id: 'preset-required', rowVersion: 1 }) } });
    });

    await page.goto('/listing/wb');
    await page.getByRole('tab', { name: '上品预设模板' }).click();
    await page.getByRole('button', { name: '新建上品预设' }).click();
    const drawer = page.locator('.wb-preset-drawer');
    await drawer.getByLabel('预设名称').fill('TNVED 必填测试');
    await chooseSelect(page, drawer, '默认定价模板', 'WB平台默认定价V1');
    await chooseSelect(page, drawer, '默认运费模板', 'CELWBV5.23');
    await chooseSelect(page, drawer, '服务渠道', 'CEL Wb-Economy');
    await chooseSelect(page, drawer, 'WB 类目模板', '休闲运动鞋');
    const tnved = drawer.getByLabel('TNVED');
    await expect(tnved).toBeEnabled();
    await expect(drawer.locator('.ant-form-item-required').filter({ hasText: 'TNVED' })).toBeVisible();
    await drawer.getByRole('textbox', { name: '预设 techSize 1' }).fill('38');
    await drawer.getByRole('button', { name: '创建预设' }).click();
    await expect(drawer.getByText('TNVED为必填项目', { exact: true })).toBeVisible();
    expect(createRequests).toBe(0);
    expect(tnvedRequests).toBe(0);

    await tnved.fill('6404110000');
    await expect.poll(() => tnvedRequests).toBe(1);
    await drawer.getByRole('button', { name: '创建预设' }).click();
    await expect(page.getByText('预设“TNVED 必填测试”已创建')).toBeVisible();
    expect(createRequests).toBe(1);
  });

  test('BROKEN 预设不阻止创建公共素材，无效 TNVED 仍 fail-closed', async ({ page }) => {
    await mockReadyConfig(page);
    await mockPresetDependencies(page);
    const broken = { ...preset(), readiness: 'BROKEN', issues: [{ code: 'CATEGORY_TEMPLATE_UNAVAILABLE', message: '类目模板已停用', severity: 'ERROR', retryable: false }] };
    await page.route(/\/api\/v1\/wb\/presets$/, async (route) => route.fulfill({ json: { items: [broken] } }));
    await page.route(/\/api\/v1\/wb\/presets\/preset-default$/, async (route) => route.fulfill({ json: { preset: broken } }));
    await page.route(/\/api\/v1\/wb\/listings\?.*/, async (route) => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));
    await page.goto('/listing/wb?view=manual');
    await expect(page.getByText('默认上品预设配置不可用', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '新建上品资料' })).toBeEnabled();

    await page.unroute(/\/api\/v1\/wb\/catalog\/directories\/tnved\?.*/);
    await page.route(/\/api\/v1\/wb\/catalog\/directories\/tnved\?.*/, async (route) => route.fulfill({ json: [] }));
    await page.getByRole('tab', { name: '上品预设模板' }).click();
    await page.getByRole('button', { name: '编辑' }).click();
    const drawer = page.locator('.wb-preset-drawer');
    const tnved = drawer.getByLabel('TNVED（非必填，可留空）');
    await tnved.fill('6404110001');
    await expect(drawer.getByText('WB TNVED 目录中未找到编码 6404110001', { exact: true })).toBeVisible();
    await expect(drawer.getByRole('button', { name: '保存修改' })).toBeEnabled();
    await drawer.getByRole('button', { name: '保存修改' }).click();
    await expect(page.getByText('WB TNVED 目录中未找到编码 6404110001', { exact: true }).last()).toBeVisible();
  });

  test('320px 下配置导航和预设表单不产生页面级横向溢出', async ({ page }) => {
    await mockReadyConfig(page);
    await mockPresetDependencies(page);
    await page.route(/\/api\/v1\/wb\/presets$/, async (route) => route.fulfill({ json: { items: [preset()] } }));
    await page.route(/\/api\/v1\/wb\/listings\?.*/, async (route) => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/listing/wb');
    await page.getByRole('tab', { name: '上品预设模板' }).click();
    await expect(page.getByText('一套预设，串起价格、物流与商品资料', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: '编辑' }).click();
    await expect(page.locator('.wb-preset-drawer')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
