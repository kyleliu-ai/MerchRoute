import { expect, test, type Page } from '@playwright/test';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';

test.use({ timezoneId: 'Asia/Shanghai' });
dayjs.extend(utc);
dayjs.extend(timezone);

const formatShanghaiTime = (value: string, template = 'YYYY-MM-DD HH:mm:ss') => dayjs(value).tz('Asia/Shanghai').format(template);

const settings = {
  rowVersion: 1,
  enabled: false,
  rootDirectory: '',
  defaultStoreAlias: 'default',
  taskApiWebhookUrl: '',
  adminApiWebhookUrl: '',
  preflightWebhookUrl: '',
  imageUploaderWorkflowId: '',
  storeGatewayWorkflowId: '',
  credentialReady: false,
  lastPreflightStatus: 'NOT_RUN',
  videoUploadReady: false,
  updatedAt: '2026-07-27T00:00:00.000Z'
};

const readiness = {
  ready: false,
  mediaReady: false,
  databaseReady: true,
  rootReady: false,
  workflowReady: false,
  credentialReady: false,
  videoUploadReady: false,
  issues: ['尚未配置默认店铺凭据'],
  mediaIssues: ['尚未配置 OZON 自动上品根目录'],
  settings
};

const catalogStatus = {
  status: 'READY',
  entryCount: 128,
  chineseMissingCount: 3,
  dictionaryCounts: { countries: 236, seasons: 5, kinds: 4, colors: 33 },
  lastSuccessfulAt: '2026-07-27T02:00:00.000Z',
  nextScheduledAt: '2026-08-03T02:00:00.000Z',
  isStale: false
};

const catalogEntry = {
  catalogEntryId: '15621048:91248',
  descriptionCategoryId: 15621048,
  typeId: 91248,
  categoryNameZh: '鞋靴',
  typeNameZh: '运动鞋',
  categoryNameRu: 'Обувь',
  typeNameRu: 'Кроссовки',
  pathZh: ['服饰鞋包', '鞋靴', '运动鞋'],
  pathRu: ['Одежда и обувь', 'Обувь', 'Кроссовки'],
  displayPathZh: '服饰鞋包 → 鞋靴 → 运动鞋',
  displayPathRu: 'Одежда и обувь → Обувь → Кроссовки',
  active: true,
  missingSyncCount: 0,
  updatedAt: '2026-07-27T02:00:00.000Z'
};

const ozonSystemTypeAttribute = {
  id: 8229,
  name: 'Тип',
  nameRu: 'Тип',
  nameZh: '类型',
  description: '',
  type: 'String',
  required: true,
  dictionaryId: 1960,
  maxCount: 1,
  groupId: 0,
  groupName: '',
  complexId: 0,
  isCollection: false
};

const ozonRussianSizeAttribute = {
  id: 4298,
  name: 'Российский размер',
  nameRu: 'Российский размер',
  nameZh: '俄罗斯尺码',
  description: '',
  type: 'String',
  required: true,
  dictionaryId: 361,
  maxCount: 1,
  groupId: 0,
  groupName: '',
  complexId: 0,
  isCollection: false
};

const ozonClothingBrandAttribute = {
  id: 31,
  name: 'Бренд в одежде и обуви',
  nameRu: 'Бренд в одежде и обуви',
  nameZh: '服装和鞋类品牌',
  description: '',
  type: 'Dictionary',
  required: true,
  dictionaryId: 28732849,
  maxCount: 1,
  groupId: 0,
  groupName: '',
  complexId: 0,
  isCollection: false
};

const ozonGenderAttribute = {
  id: 9163,
  name: 'Пол',
  nameRu: 'Пол',
  nameZh: '性别',
  description: '',
  type: 'Dictionary',
  required: true,
  dictionaryId: 320,
  maxCount: 1,
  groupId: 0,
  groupName: '',
  complexId: 0,
  isCollection: false
};

const ozonMergeCardAttribute = {
  id: 8292,
  name: 'Объединить на одной карточке',
  nameRu: 'Объединить на одной карточке',
  nameZh: '合并至一张卡片',
  description: '',
  type: 'String',
  required: true,
  dictionaryId: 0,
  maxCount: 1,
  groupId: 0,
  groupName: '',
  complexId: 0,
  isCollection: false
};

const ozonProductColorAttribute = {
  id: 10096,
  name: 'Цвет товара',
  nameRu: 'Цвет товара',
  nameZh: '商品颜色',
  description: '',
  type: 'Dictionary',
  required: true,
  dictionaryId: 1494,
  maxCount: 1,
  groupId: 0,
  groupName: '',
  complexId: 0,
  isCollection: false
};

const ozonSportsShoeSizeValues = [
  [23539, '36'], [23545, '37'], [23550, '38'], [23554, '39'], [23558, '40'], [23566, '41'],
  [23570, '42'], [23575, '43'], [23579, '44'], [23584, '45'], [23588, '46']
].map(([id, value]) => ({ id: Number(id), value: String(value), valueZh: String(value), valueRu: String(value) }));

const ozonPdfNameAttribute = {
  id: 8789,
  name: 'Название файла PDF',
  nameRu: 'Название файла PDF',
  nameZh: 'PDF文件名称',
  description: '',
  type: 'String',
  required: false,
  dictionaryId: 0,
  maxCount: 1,
  groupId: 0,
  groupName: '',
  complexId: 8788,
  isCollection: false
};

const ozonPdfDocumentAttribute = {
  id: 8790,
  name: 'Документ PDF',
  nameRu: 'Документ PDF',
  nameZh: 'PDF 文件',
  description: '',
  type: 'URL',
  required: false,
  dictionaryId: 0,
  maxCount: 1,
  groupId: 0,
  groupName: '',
  complexId: 8788,
  isCollection: false
};

const presetCategory = {
  categoryKey: 'ozon_17001_97001', nameZh: '双肩背包', nameRu: 'Рюкзаки', descriptionCategoryId: 17001, typeId: 97001,
  rowVersion: 1, createdAt: '2026-07-27T02:00:00.000Z', updatedAt: '2026-07-27T02:00:00.000Z', catalogActive: true,
  publishedVersion: { id: '55555555-5555-4555-8555-555555555555', categoryKey: 'ozon_17001_97001', versionNo: 2, status: 'PUBLISHED', schemaHash: `sha256:${'b'.repeat(64)}`, confirmedBy: '', createdAt: '2026-07-27T02:00:00.000Z', updatedAt: '2026-07-27T02:00:00.000Z', snapshot: {
    categoryKey: 'ozon_17001_97001', nameZh: '双肩背包', nameRu: 'Рюкзаки', descriptionCategoryId: 17001, typeId: 97001,
    attributes: [
      ozonSystemTypeAttribute,
      { id: 10, name: 'Материал', nameRu: 'Материал', nameZh: '材质', description: '', type: 'String', required: true, dictionaryId: 0, maxCount: 1, groupId: 0, groupName: '', complexId: 0, isCollection: false },
      ozonRussianSizeAttribute,
      { id: 4389, name: 'Страна-изготовитель', nameRu: 'Страна-изготовитель', nameZh: '原产国', description: '', type: 'Dictionary', required: false, dictionaryId: 1935, maxCount: 2, groupId: 0, groupName: '', complexId: 0, isCollection: true },
      { id: 4495, name: 'Сезон', nameRu: 'Сезон', nameZh: '季节', description: '', type: 'Dictionary', required: false, dictionaryId: 703, maxCount: 1, groupId: 0, groupName: '', complexId: 0, isCollection: false },
      { id: 9163, name: 'Пол', nameRu: 'Пол', nameZh: '性别', description: '', type: 'Dictionary', required: false, dictionaryId: 320, maxCount: 2, groupId: 0, groupName: '', complexId: 0, isCollection: true },
      { id: 10096, name: 'Цвет товара', nameRu: 'Цвет товара', nameZh: '商品颜色', description: '', type: 'Dictionary', required: false, dictionaryId: 1494, maxCount: 1, groupId: 0, groupName: '', complexId: 0, isCollection: true },
      { id: 21837, name: 'Ссылка на видео', nameRu: 'Ссылка на видео', nameZh: '产品介绍视频链接', description: '', type: 'String', required: false, dictionaryId: 0, maxCount: 1, groupId: 0, groupName: '', complexId: 100001, isCollection: false },
      { id: 21841, name: 'Название видео', nameRu: 'Название видео', nameZh: '产品介绍视频标题', description: '', type: 'String', required: false, dictionaryId: 0, maxCount: 1, groupId: 0, groupName: '', complexId: 100001, isCollection: false },
      { id: 21845, name: 'Видеообложка', nameRu: 'Видеообложка', nameZh: '视频封面系统字段', description: '', type: 'String', required: false, dictionaryId: 0, maxCount: 1, groupId: 0, groupName: '', complexId: 100002, isCollection: false },
      { id: 22273, name: 'Товары на видео', nameRu: 'Товары на видео', nameZh: '视频中的商品', description: '', type: 'String', required: false, dictionaryId: 0, maxCount: 1, groupId: 0, groupName: '', complexId: 100001, isCollection: false }
    ],
    dictionarySnapshot: {
      '4298': [
        { id: 35, value: '35', valueZh: '35', valueRu: '35' },
        { id: 36, value: '36', valueZh: '36', valueRu: '36' },
        { id: 37, value: '37', valueZh: '37', valueRu: '37' }
      ]
    },
    sizing: { sizeMode: 'sized', sizeAttributeKey: '4298:0' },
    confirmedBy: ''
  } }
};

const sportsShoePresetCategory = {
  categoryKey: 'ozon_15621048_91248', nameZh: '运动鞋', nameRu: 'Кроссовки', descriptionCategoryId: 15621048, typeId: 91248,
  rowVersion: 5, createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z', catalogActive: true,
  publishedVersion: { id: '55555555-5555-4555-8555-555555555557', categoryKey: 'ozon_15621048_91248', versionNo: 5, status: 'PUBLISHED', schemaHash: `sha256:${'d'.repeat(64)}`, confirmedBy: '', createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z', snapshot: {
    categoryKey: 'ozon_15621048_91248', nameZh: '运动鞋', nameRu: 'Кроссовки', descriptionCategoryId: 15621048, typeId: 91248,
    attributes: [
      ozonSystemTypeAttribute,
      ozonClothingBrandAttribute,
      ozonGenderAttribute,
      ozonMergeCardAttribute,
      ozonProductColorAttribute,
      { id: 10, name: 'Материал', nameRu: 'Материал', nameZh: '材质', description: '', type: 'String', required: true, dictionaryId: 0, maxCount: 1, groupId: 0, groupName: '', complexId: 0, isCollection: false },
      ozonRussianSizeAttribute,
      ozonPdfNameAttribute,
      ozonPdfDocumentAttribute
    ],
    dictionarySnapshot: {
      '31': [{ id: 126745801, value: 'Нет бренда', valueZh: '无品牌', valueRu: 'Нет бренда' }],
      '9163': [{ id: 22880, value: 'Мужской', valueZh: '男士', valueRu: 'Мужской' }],
      '4298': ozonSportsShoeSizeValues
    },
    sizing: { sizeMode: 'sized', sizeAttributeKey: '4298:0' },
    confirmedBy: ''
  } }
};

const sizelessPresetCategory = {
  categoryKey: 'ozon_18001_98001', nameZh: '无尺码配件', nameRu: 'Аксессуары', descriptionCategoryId: 18001, typeId: 98001,
  rowVersion: 2, createdAt: '2026-07-27T02:00:00.000Z', updatedAt: '2026-07-27T02:00:00.000Z', catalogActive: true,
  publishedVersion: { id: '66666666-6666-4666-8666-666666666666', categoryKey: 'ozon_18001_98001', versionNo: 3, status: 'PUBLISHED', schemaHash: `sha256:${'c'.repeat(64)}`, confirmedBy: '', createdAt: '2026-07-27T02:00:00.000Z', updatedAt: '2026-07-27T02:00:00.000Z', snapshot: {
    categoryKey: 'ozon_18001_98001', nameZh: '无尺码配件', nameRu: 'Аксессуары', descriptionCategoryId: 18001, typeId: 98001,
    attributes: [
      ozonSystemTypeAttribute,
      { id: 10, name: 'Материал', nameRu: 'Материал', nameZh: '材质', description: '', type: 'String', required: true, dictionaryId: 0, maxCount: 1, groupId: 0, groupName: '', complexId: 0, isCollection: false }
    ],
    dictionarySnapshot: {},
    sizing: { sizeMode: 'sizeless' },
    confirmedBy: ''
  } }
};

const productOzonSku = '5260188556';
const secondProductOzonSku = '5260179772';
const productUrl = `https://www.ozon.ru/product/${productOzonSku}/`;
const secondProductUrl = `https://www.ozon.ru/product/${secondProductOzonSku}/`;
const successfulJob = {
  id: '4b8d9580-dd7a-4888-9358-f86e71087936', sku: '0000051', offerId: '0000051-01', offerIds: ['0000051-01', '0000051-02'], storeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', storeAlias: 'default', state: 'SUCCEEDED', source: 'AUTO',
  ozonProductId: '5686268830', ozonProductUrl: productUrl, ozonProductLinks: [
    { offerId: '0000051-02', ozonProductId: '5686268831', ozonSku: secondProductOzonSku, url: secondProductUrl },
    { offerId: '0000051-01', ozonProductId: '5686268830', ozonSku: productOzonSku, url: productUrl }
  ], stageStates: { import: 'SUCCEEDED', moderation: 'SUCCEEDED', images: 'SUCCEEDED', video: 'SUCCEEDED', productVideo: 'VERIFIED', videoCover: 'VERIFIED', price: 'SUCCEEDED', stock: 'SUCCEEDED' },
  retryCount: 0, rowVersion: 3, createdAt: '2026-07-27T10:00:00.000Z', updatedAt: '2026-07-27T11:00:00.000Z',
  events: [{
    id: '66666666-6666-4666-8666-666666666666',
    jobId: '4b8d9580-dd7a-4888-9358-f86e71087936',
    eventType: 'OZON_VIDEO_VERIFIED',
    message: '产品视频与封面已读回',
    payload: {
      videoVerificationByOffer: [
        { offerId: '0000051-01', mode: 'INTRO_AND_COVER', sourceAssetId: 'video-shared', sameSource: true, coverStatus: 'VERIFIED', introductionStatus: 'VERIFIED' },
        { offerId: '0000051-02', mode: 'INTRO_AND_COVER', sourceAssetId: 'video-shared', sameSource: true, coverStatus: 'VERIFIED', introductionStatus: 'VERIFIED' }
      ]
    },
    createdAt: '2026-07-27T11:00:00.000Z'
  }]
};
const publishedListing = {
  sku: '0000051', productName: '复古斜挎包', status: 'PUBLISHED', rowVersion: 3, revision: 3,
  data: { categoryKey: 'ozon_17001_97001', offers: [{ variantCode: '01', offerId: '0000051-01' }, { variantCode: '02', offerId: '0000051-02' }] },
  ozonProductLinks: [
    { offerId: '0000051-02', ozonProductId: '5686268831', ozonSku: secondProductOzonSku, url: secondProductUrl },
    { offerId: '0000051-01', ozonProductId: '5686268830', ozonSku: productOzonSku, url: productUrl }
  ],
  createdAt: '2026-07-27T09:00:00.000Z', updatedAt: '2026-07-27T11:00:00.000Z'
};

const readyReadiness = {
  ...readiness,
  ready: true,
  mediaReady: true,
  rootReady: true,
  workflowReady: true,
  credentialReady: true,
  issues: [],
  mediaIssues: [],
  settings: {
    ...settings,
    enabled: true,
    rootDirectory: 'G:\\01_MerchRoute\\OZON-Auto-Publish',
    credentialReady: true,
    taskApiWebhookUrl: 'http://127.0.0.1:5678/webhook/ozon-task'
  }
};

const editableListing = {
  ...publishedListing,
  sku: '0000049',
  productName: '手动提交测试商品',
  status: 'READY',
  rowVersion: 5,
  revision: 5,
  ozonProductLinks: [],
  data: {
    categoryKey: presetCategory.categoryKey,
    categoryVersionId: presetCategory.publishedVersion.id,
    fulfillmentMode: 'FBS',
    warehouseId: '10001',
    currency: 'CNY',
    vat: '0.2',
    titleRu: 'Рюкзак',
    descriptionRu: 'Описание',
    brand: '',
    dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 800, weightUnit: 'g' },
    sharedAttributes: [],
    offers: [],
    mediaAssets: [],
    mediaSourceRoot: 'G:\\01_MerchRoute\\OZON-Auto-Publish\\inbox\\0000049'
  },
  createdAt: '2026-07-27T09:00:00.000Z',
  updatedAt: '2026-07-27T19:43:57.000Z'
};

function withReadyPublicMaterial(listing: typeof editableListing, productVariantId = '12121212-1212-4212-8212-121212121212') {
  const imageAsset = {
    assetId: `image-${productVariantId}`,
    relativePath: 'variants/黑色/images/01.png',
    kind: 'image',
    mimeType: 'image/png',
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
    modifiedAt: '2026-08-14T01:00:00.000Z',
    validationStatus: 'VALID',
    productVariantId,
    productVariantName: '黑色'
  };
  const videoAsset = {
    ...imageAsset,
    assetId: `video-${productVariantId}`,
    relativePath: 'variants/黑色/videos/main.mp4',
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 2048,
    sha256: 'b'.repeat(64)
  };
  return {
    ...listing,
    data: {
      ...listing.data,
      descriptionRu: listing.data.descriptionRu || 'Описание товара.',
      offers: [{
        variantId: productVariantId,
        productVariantId,
        productVariantName: '黑色',
        descriptionRu: 'Описание черного варианта.',
        attributes: [],
        media: [
          { assetId: imageAsset.assetId, kind: 'image', sortOrder: 0, isPrimary: true },
          { assetId: videoAsset.assetId, kind: 'video', sortOrder: 1, isPrimary: false }
        ]
      }],
      mediaAssets: [imageAsset, videoAsset]
    }
  };
}

async function routeNoPublicationTaskSummaries(page: Page) {
  await page.route(/\/api\/v1\/ozon\/publication-task-summaries(?:\?.*)?$/, (route) => route.fulfill({
    json: { items: [], total: 0 }
  }));
}

async function openExistingPublicMaterial(
  page: Page,
  listing: { sku: string; productName: string; revision: number } & Record<string, unknown>,
  navigate = true,
  availableListings: Array<{ sku: string; productName: string } & Record<string, unknown>> = [listing]
) {
  await page.route(/\/api\/v1\/purchases\?.*/, (route) => route.fulfill({ json: {
    items: availableListings.map((item) => ({
      sku: item.sku,
      productName: item.productName,
      variants: [],
      createdAt: String(item.createdAt || '2026-08-14T01:00:00.000Z'),
      updatedAt: String(item.updatedAt || '2026-08-14T01:00:00.000Z'),
      procurement: {}
    })),
    total: availableListings.length,
    page: 1,
    pageSize: 100
  } }));
  await page.route(/\/api\/v1\/ozon\/listings(?:\?.*)?$/, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.fulfill({ json: {
      listing,
      generatedVersionId: `e2e-material-${listing.sku}`,
      materialRevision: listing.revision,
      materialHash: `sha256:${'a'.repeat(64)}`,
      contentPolicyVersion: 'merchroute-ozon-content-v3'
    } });
  });
  if (navigate) await page.goto('/listing/ozon?view=manual');
  await page.getByRole('button', { name: /新建公共素材/ }).first().click();
  const createDialog = page.getByRole('dialog', { name: '选择 MerchRoute 产品' });
  await createDialog.getByRole('combobox', { name: '产品 SKU' }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: listing.sku }).click();
  await createDialog.getByRole('button', { name: '创建公共素材任务' }).click();
}

const compatiblePreset = {
  id: '99999999-9999-4999-8999-999999999999',
  name: '兼容追加预设',
  isDefault: true,
  autoPublishMode: 'COMPATIBLE_UPSERT',
  defaultStock: 1
};

const sizingPricingTemplateId = '77777777-7777-4777-8777-777777777777';
const sizingShippingTemplateId = '88888888-8888-4888-8888-888888888888';
const sizingPreset = {
  id: '77777777-7777-4777-8777-777777777778',
  name: 'OZON-运动鞋预设',
  description: '逐尺码默认库存验收',
  categoryKey: sportsShoePresetCategory.categoryKey,
  pricingTemplateId: sizingPricingTemplateId,
  shippingTemplateId: sizingShippingTemplateId,
  shippingServiceCode: 'CEL_RFBS_ECONOMY',
  destinationCountryCode: 'RU',
  vat: '0.2',
  defaultStock: 1,
  dimensions: { length: 32, width: 22, height: 12, dimensionUnit: 'cm', weight: 800, weightUnit: 'g' },
  sharedAttributes: [
    { attributeId: 10, complexId: 0, values: [{ value: '网布' }] },
    { attributeId: 9163, complexId: 0, values: [{ dictionaryValueId: 22880 }] }
  ],
  variantAttributes: [],
  titleTranslation: { workflowId: 'HDh0ZNLK2ps5qasR', language: '俄文', maxLength: 200 },
  descriptionSource: 'E003',
  sizeAttributeKey: '4298:0',
  sizes: ozonSportsShoeSizeValues.map((size, index) => ({
    sizeId: `77777777-7777-4777-8777-${String(index + 1).padStart(12, '0')}`,
    value: `dict:${size.id}`,
    stock: 1
  })),
  mediaPolicy: 'REPLACE_ALL',
  rowVersion: 4,
  createdAt: '2026-08-24T01:00:00.000Z',
  updatedAt: '2026-08-24T01:00:00.000Z'
};

async function routeOzonSizingPresetEditor(page: Page, categories: unknown[], onSave: (body: any) => void) {
  await page.route(/\/api\/v1\/ozon\/categories$/, (route) => route.fulfill({ json: { items: categories } }));
  await page.route(/\/api\/v1\/ozon\/presets(?:\/.*)?$/, (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: { items: [sizingPreset] } });
    const body = request.postDataJSON();
    onSave(body);
    return route.fulfill({ json: { preset: { ...sizingPreset, ...body, rowVersion: sizingPreset.rowVersion + 1 } } });
  });
  await page.route(/\/api\/v1\/pricing\/templates$/, (route) => route.fulfill({ json: { items: [{
    id: sizingPricingTemplateId, name: 'OZON平台默认定价', platformCode: 'OZON', platformName: 'OZON', active: true,
    publishedVersion: { id: '77777777-7777-4777-8777-777777777770', versionNo: 2, publishedAt: '2026-08-24T00:00:00.000Z' }
  }] } }));
  await page.route(/\/api\/v1\/shipping\/templates$/, (route) => route.fulfill({ json: { items: [{
    id: sizingShippingTemplateId, name: 'CEL OZON-rFBS', platformCode: 'OZON', scenarioCode: 'OZON_RFBS', templateType: 'OZON_RFBS', active: true, carrierCode: 'CEL', carrierName: 'CEL物流', carrierActive: true,
    publishedVersion: { id: '88888888-8888-4888-8888-888888888880', versionNo: 2, publishedAt: '2026-08-24T00:00:00.000Z' }
  }] } }));
  await page.route(new RegExp(`/api/v1/shipping/templates/${sizingShippingTemplateId}$`), (route) => route.fulfill({ json: { template: {
    id: sizingShippingTemplateId, name: 'CEL OZON-rFBS', platformCode: 'OZON', scenarioCode: 'OZON_RFBS', templateType: 'OZON_RFBS', active: true, carrierCode: 'CEL', carrierName: 'CEL物流', carrierActive: true,
    versions: [{ id: '88888888-8888-4888-8888-888888888880', versionNo: 2, status: 'PUBLISHED', definition: { currency: 'CNY', schemaVersion: '1', salePriceCurrencyCode: 'RUB', services: [
      { code: 'CEL_RFBS_ECONOMY', name: 'CEL Economy', channel: '陆运经济', sortOrder: 10, rules: [] }
    ] }, createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z', publishedAt: '2026-08-24T00:00:00.000Z' }]
  } } }));
}

const waitingAutoJob = {
  id: '17b43575-b742-448e-8fe5-dd704483c813',
  sku: '0000049',
  offerIds: [],
  storeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  storeAlias: 'default',
  state: 'WAITING_MEDIA',
  source: 'AUTO',
  ozonProductLinks: [],
  stageStates: { import: 'PENDING', moderation: 'PENDING', images: 'PENDING', video: 'PENDING', price: 'PENDING', stock: 'PENDING' },
  retryCount: 0,
  rowVersion: 1,
  createdAt: '2026-07-27T18:00:00.000Z',
  updatedAt: '2026-07-27T19:43:57.000Z',
  events: []
};

const readyAutomationStatus = {
  readiness: readyReadiness,
  counts: { WAITING_MEDIA: 1 },
  managementEnabled: true,
  acceptingNewJobs: true,
  continuingBoundJobs: 0,
  eligibleAutoStoreCount: 2,
  blockedAutoStoreCount: 0,
  worker: { running: true }
};

const multiStoreSettings = {
  enabled: true,
  rootDirectory: 'G:\\01_MerchRoute\\OZON-Auto-Publish',
  timezone: 'Asia/Shanghai',
  globalConcurrency: 2,
  perStoreConcurrency: 1,
  taskApiWebhookUrl: 'http://127.0.0.1:5678/webhook/ozon-task',
  adminApiWebhookUrl: 'http://127.0.0.1:5678/webhook/ozon-admin',
  preflightWebhookUrl: 'http://127.0.0.1:5678/webhook/ozon-preflight',
  imageUploaderWorkflowId: 'ozon-image-uploader',
  storeGatewayWorkflowId: 'ozon-store-gateway',
  imageUploadConcurrency: 4,
  videoUploadConcurrency: 1,
  videoPrewarmEnabled: true,
  videoUploadReady: true,
  publicationReadbackEnabled: false,
  videoUploadCheckedAt: '2026-08-11T01:00:00.000Z',
  videoUploadMessage: 'ready',
  preflightTtlHours: 24,
  preflightDueHours: 18,
  defaultStoreAlias: 'default',
  credentialReady: true,
  seller: { id: 'legacy-seller', name: '迁移前默认店铺', accountCurrency: 'RUB' },
  preflight: { status: 'READY', checkedAt: '2026-08-11T01:00:00.000Z', message: 'ready' },
  rowVersion: 3,
  createdAt: '2026-08-11T00:00:00.000Z',
  updatedAt: '2026-08-11T01:00:00.000Z'
};

function ozonStore(id: string, displayName: string, storeAlias: string) {
  return {
    id,
    storeAlias,
    displayName,
    enabled: true,
    autoPublishEnabled: true,
    autoPublishMode: 'CREATE_ONLY',
    defaultPresetId: compatiblePreset.id,
    warehouseId: `warehouse-${storeAlias}`,
    warehouseName: `${displayName}仓库`,
    fulfillmentMode: 'FBS',
    accountCurrency: 'RUB',
    maxDailyStyles: 100,
    credential: {
      state: 'ACTIVE', bindingMode: 'VAULT', configured: true,
      activeVersionId: `credential-${storeAlias}`, fingerprint: `fingerprint-${storeAlias}`, version: 1,
      updatedAt: '2026-08-11T01:00:00.000Z'
    },
    seller: { id: `seller-${storeAlias}`, name: `${displayName} Seller` },
    permissions: ['product.info', 'product.import'],
    limits: { daily: 1000 },
    warehouses: [{ id: `warehouse-${storeAlias}`, name: `${displayName}仓库`, fulfillmentModes: ['FBS'], status: 'ACTIVE' }],
    preflight: {
      status: 'PASSED', currencyVerified: true, currencyVerification: 'VERIFIED',
      checkedAt: '2026-08-11T01:00:00.000Z', expiresAt: '2026-08-12T01:00:00.000Z', dueAt: '2026-08-11T19:00:00.000Z'
    },
    network: { status: 'READY' },
    readiness: { ready: true, score: 100, blockers: [] },
    taskLoad: { running: 0, queued: 0 },
    configVersion: 2,
    rowVersion: 4,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T01:00:00.000Z'
  };
}

const readyStoreA = ozonStore('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'OZON 主店', 'ozon-main');
const readyStoreB = ozonStore('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'OZON 新品店', 'ozon-new');
const pendingCredentialStore = {
  ...readyStoreB,
  credential: {
    state: 'PENDING', bindingMode: 'VAULT', configured: false,
    pendingVersionId: 'credential-ozon-new-pending', fingerprint: 'fingerprint-ozon-new', version: 2,
    updatedAt: '2026-08-11T02:00:00.000Z'
  },
  preflight: { status: 'NOT_RUN', currencyVerified: false },
  readiness: { ready: false, score: 25, blockers: ['新凭据尚未完成连接检查'] }
};

test.describe('OZON 独立上品工作区', () => {
  test.beforeEach(async ({ page }) => {
    const templates: any[] = [];
    await page.route(/\/api\/v1\/ozon\/.*/, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/v1/ozon/system') return route.fulfill({ json: readiness });
      if (path === '/api/v1/ozon/settings') return route.fulfill({ json: { settings: multiStoreSettings } });
      if (path === '/api/v1/ozon/stores') return route.fulfill({ json: { items: [], total: 0 } });
      if (path === '/api/v1/ozon/publication-task-summaries') {
        const url = new URL(route.request().url());
        const skus = String(url.searchParams.get('skus') || '').split(',').filter(Boolean);
        return route.fulfill({ json: {
          items: skus.map((sku, index) => ({
            publicationId: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
            sku,
            generatedVersionId: `${String(index + 1).padStart(8, '0')}-2222-4222-8222-222222222222`,
            revision: sku === publishedListing.sku ? publishedListing.revision : editableListing.revision,
            planHash: `sha256:${String(index + 1).repeat(64).slice(0, 64)}`,
            storeId: readyStoreA.id,
            storeAlias: readyStoreA.storeAlias,
            storeDisplayName: readyStoreA.displayName,
            status: 'SUCCEEDED',
            publicationMode: 'CREATE_ONLY',
            presetBinding: { presetId: compatiblePreset.id, presetName: compatiblePreset.name, presetRowVersion: 1, sourcePresetExists: true },
            offerIds: sku === publishedListing.sku ? successfulJob.offerIds : [],
            productLinks: sku === publishedListing.sku ? successfulJob.ozonProductLinks : [],
            legacyProductUrls: [],
            rowVersion: 1,
            createdAt: '2026-08-14T01:00:00.000Z',
            updatedAt: '2026-08-14T02:00:00.000Z',
            currentMaterialRevision: sku === publishedListing.sku ? publishedListing.revision : editableListing.revision,
            currentGeneratedVersionId: `${String(index + 1).padStart(8, '0')}-2222-4222-8222-222222222222`,
            capabilities: { canOpenWorkspace: true, canRepublish: false, canCompatibleAppend: false, blockedReason: '请先保存新的公共素材 revision' }
          })),
          total: skus.length
        } });
      }
      if (path === '/api/v1/ozon/publications' && route.request().method() === 'GET') return route.fulfill({ json: { items: [], total: 0 } });
       if (path === '/api/v1/ozon/automation/status') return route.fulfill({ json: {
         readiness,
         counts: { SUCCEEDED: 1 },
         managementEnabled: false,
         acceptingNewJobs: false,
         continuingBoundJobs: 0,
         worker: { running: false }
       } });
       if (path === '/api/v1/ozon/automation/jobs') {
         return route.fulfill({ json: { items: [successfulJob], total: 1, page: 1, pageSize: 30 } });
       }
       if (path === '/api/v1/ozon/listings') return route.fulfill({ json: { items: [publishedListing], total: 1, page: 1, pageSize: 20 } });
       if (path === '/api/v1/ozon/listings/0000051') return route.fulfill({ json: { listing: { ...publishedListing, data: { fulfillmentMode: 'FBS', warehouseId: '', currency: 'RUB', vat: '0.2', titleRu: '', descriptionRu: '', brand: '', sharedAttributes: [], offers: [], mediaSourceRoot: '' } } } });
       if (path === '/api/v1/ozon/listings/0000051/jobs') return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } });
      if (path === '/api/v1/ozon/catalog/status') return route.fulfill({ json: { catalog: catalogStatus } });
      if (path === '/api/v1/ozon/catalog/categories') return route.fulfill({ json: { items: [catalogEntry], catalog: catalogStatus } });
      if (path.startsWith('/api/v1/ozon/catalog/dictionaries/')) {
        const directory = path.split('/').at(-1)!;
        const dictionaryId = Number(new URL(route.request().url()).searchParams.get('dictionaryId'));
        const values: Record<string, Array<{ valueId: number; nameZh: string; nameRu: string }>> = {
          countries: [{ valueId: 9001, nameZh: '中国', nameRu: 'Китай' }],
          seasons: [{ valueId: 30940, nameZh: '夏季', nameRu: 'Лето' }],
          kinds: [{ valueId: 22880, nameZh: '男士', nameRu: 'Мужской' }],
          colors: [{ valueId: 61575, nameZh: '黑色', nameRu: 'Черный' }]
        };
        return route.fulfill({ json: {
          directory,
          dictionaryId,
          items: (values[directory] || []).map((item) => ({
            directory,
            itemKey: `${directory}:${dictionaryId}:${item.valueId}`,
            attributeId: 1,
            dictionaryId,
            ...item
          })),
          catalog: catalogStatus
        } });
      }
      if (path === '/api/v1/ozon/catalog/sync') return route.fulfill({ status: 202, json: { runId: '11111111-1111-4111-8111-111111111111', status: 'RUNNING', accepted: true } });
      if (path === '/api/v1/ozon/categories' && route.request().method() === 'POST') {
        const category = {
          categoryKey: 'ozon_15621048_91248', nameZh: '运动鞋', nameRu: 'Кроссовки', descriptionCategoryId: 15621048, typeId: 91248,
          rowVersion: 1, createdAt: '2026-07-27T02:00:00.000Z', updatedAt: '2026-07-27T02:00:00.000Z', catalogActive: true,
          draftVersion: { id: '22222222-2222-4222-8222-222222222222', categoryKey: 'ozon_15621048_91248', versionNo: 1, status: 'DRAFT', schemaHash: `sha256:${'a'.repeat(64)}`, confirmedBy: '', createdAt: '2026-07-27T02:00:00.000Z', updatedAt: '2026-07-27T02:00:00.000Z', snapshot: { categoryKey: 'ozon_15621048_91248', nameZh: '运动鞋', nameRu: 'Кроссовки', descriptionCategoryId: 15621048, typeId: 91248, attributes: [
            { id: 10, name: 'Бренд', nameRu: 'Бренд', nameZh: '品牌', description: '', type: 'String', required: true, dictionaryId: 0, maxCount: 1, groupId: 0, groupName: '', complexId: 0, isCollection: false },
            ozonRussianSizeAttribute,
            ozonPdfNameAttribute,
            ozonPdfDocumentAttribute
          ], dictionarySnapshot: {
            '4298': [
              { id: 35, value: '35', valueZh: '35', valueRu: '35' },
              { id: 36, value: '36', valueZh: '36', valueRu: '36' }
            ]
          }, media: { defaultVideoUploadMode: 'COMPRESSED_COPY' }, sizing: { sizeMode: 'sized', sizeAttributeKey: '4298:0' }, confirmedBy: '' } }
        };
        templates.push(category);
        return route.fulfill({ json: { category } });
      }
      if (path.endsWith('/attributes-order') && route.request().method() === 'PUT') {
        const input = route.request().postDataJSON() as { rowVersion: number; attributeKeys: string[]; sizing: { sizeMode: 'sized' | 'sizeless'; sizeAttributeKey?: string } };
        const category = templates.find((item) => path.includes(item.categoryKey));
        if (!category) return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } });
        const byKey = new Map(category.draftVersion.snapshot.attributes.map((attribute: any) => [`${attribute.id}:${attribute.complexId}`, attribute]));
        category.draftVersion.snapshot.attributes = input.attributeKeys.map((key) => byKey.get(key));
        category.draftVersion.snapshot.sizing = input.sizing;
        category.rowVersion += 1;
        return route.fulfill({ json: { category } });
      }
      if (path === '/api/v1/ozon/categories') return route.fulfill({ json: { items: templates } });
      if (path === '/api/v1/ozon/presets') {
        return route.fulfill({ json: { items: [] } });
      }
      return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } });
    });
  });

  test('顶部主视觉块在桌面端压缩至历史导航高度，并在窄屏自然增高', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/listing/ozon');
    await page.evaluate(() => document.fonts.ready.then(() => true));

    const hero = page.locator('.ozon-hero');
    const description = hero.locator('.ozon-hero-description');
    await expect(hero).toHaveCSS('min-height', '124px');
    await expect(hero).toHaveCSS('padding-top', '8px');
    await expect(hero).toHaveCSS('padding-bottom', '8px');
    await expect(description).toHaveCSS('margin-bottom', '0px');
    await expect(hero.locator('.ozon-seal')).toBeVisible();
    await expect(hero.getByRole('button', { name: 'OZON上品设置' })).toBeVisible();

    const desktopMetrics = await hero.evaluate((element) => {
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

    for (const width of [1024, 800, 620, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(async () => hero.evaluate((element) => {
        const container = element.getBoundingClientRect();
        const children = Array.from(element.children).map((child) => child.getBoundingClientRect());
        return {
          childrenInside: children.every((child) => child.top >= container.top && child.bottom <= container.bottom),
          pageOverflow: document.documentElement.scrollWidth > window.innerWidth
        };
      })).toEqual({ childrenInside: true, pageOverflow: false });
      if (width <= 620) {
        await expect.poll(async () => hero.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(124);
      }
    }
  });

  test('多店自动任务表只展示逐店 publication，不把共享资料准备任务当作第三家店上品', async ({ page }) => {
    const tekJob = {
      ...successfulJob,
      id: '615a9859-9130-4b27-9f79-58bef4b02d26',
      sku: '0000119',
      storeId: readyStoreA.id,
      storeAlias: readyStoreA.storeAlias,
      publicationId: 'publication-tek',
      offerId: undefined,
      offerIds: ['0000119-01'],
      ozonProductLinks: [{
        offerId: '0000119-01',
        ozonProductId: '5913618212',
        ozonSku: '5430087519',
        url: 'https://www.ozon.ru/product/5913618212',
        displayState: 'ARCHIVED',
        platformMessage: 'Убран из продажи'
      }],
      state: 'NEEDS_ATTENTION',
      stageStates: { ...successfulJob.stageStates, moderation: 'FAILED' },
      payload: { mode: 'MULTISTORE_PUBLICATION' }
    };
    const glaukeJob = {
      ...tekJob,
      id: '24675e2c-4846-4747-9261-32b6949b0ba8',
      storeId: readyStoreB.id,
      storeAlias: readyStoreB.storeAlias,
      publicationId: 'publication-glauke'
    };
    const preparationJob = {
      ...tekJob,
      id: 'c3ac35ed-df99-46d0-bebe-75e2d8afa2f1',
      storeId: '00000000-0000-4000-8000-000000000002',
      storeAlias: 'default',
      publicationId: undefined,
      payload: { multistorePreparation: true, multistoreFanout: { completed: true } }
    };
    const failedPreparationJob = {
      ...preparationJob,
      id: '3136f41c-08a1-4d35-826a-a2cec555099f',
      sku: '0000120',
      state: 'NEEDS_ATTENTION',
      lastErrorCode: 'OZON_MANUAL_DRAFT_PRESENT',
      lastErrorMessage: 'SKU 已有手动草稿或待提交资料，自动流程不会覆盖'
    };
    await page.route(/\/api\/v1\/ozon\/automation\/jobs(?:\?.*)?$/, (route) => route.fulfill({
      json: { items: [tekJob, glaukeJob, preparationJob, failedPreparationJob], total: 4, page: 1, pageSize: 20 }
    }));
    await page.route(/\/api\/v1\/ozon\/stores(?:\?.*)?$/, (route) => route.fulfill({
      json: { items: [readyStoreA, readyStoreB], total: 2 }
    }));
    await page.route(/\/api\/v1\/ozon\/automation\/status$/, (route) => route.fulfill({
      json: {
        ...readyAutomationStatus,
        counts: { NEEDS_ATTENTION: 4, SUCCEEDED: 24, CANCELLED: 3 },
        businessCounts: { ARCHIVED: 2, SUCCEEDED: 24, CANCELLED: 3 }
      }
    }));

    await page.goto('/listing/ozon');

    const console = page.locator('.ozon-console').filter({ hasText: '自动上品任务' }).first();
    const metrics = console.getByLabel('OZON 自动上品任务统计');
    await expect(metrics.locator('.ozon-automation-metric').filter({ hasText: '处理中' }).getByText('0', { exact: true })).toBeVisible();
    await expect(metrics.locator('.ozon-automation-metric').filter({ hasText: '需人工处理' }).getByText('0', { exact: true })).toBeVisible();
    await expect(console.getByText('共 2 个任务', { exact: true })).toBeVisible();
    await expect(console.getByLabel(new RegExp(tekJob.id))).toBeVisible();
    await expect(console.getByLabel(new RegExp(glaukeJob.id))).toBeVisible();
    await expect(console.getByLabel(new RegExp(tekJob.id)).getByText('商品已归档', { exact: true })).toBeVisible();
    await expect(console.getByLabel(new RegExp(glaukeJob.id)).getByText('商品已归档', { exact: true })).toBeVisible();
    await expect(console.getByLabel(new RegExp(tekJob.id))).toContainText('商品已被平台归档并隐藏');
    await expect(console.getByLabel(new RegExp(glaukeJob.id))).toContainText('Убран из продажи');
    await expect(console.getByLabel(new RegExp(preparationJob.id))).toHaveCount(0);
    await expect(console.getByLabel(new RegExp(failedPreparationJob.id))).toHaveCount(0);
    await expect(console.getByText('共享资料准备', { exact: true })).toHaveCount(0);
  });

  test('OZON 自动清单使用 WB 风格单一自动状态并保留详情阶段', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`${message.text()} (${message.location().url})`);
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const waitingJob = {
      ...waitingAutoJob,
      id: '12812812-8128-4128-8128-128128128128',
      sku: '0000128',
      storeId: readyStoreA.id,
      storeAlias: readyStoreA.storeAlias,
      publicationId: 'publication-0000128-tek',
      revision: 2,
      payload: { mode: 'MULTISTORE_PUBLICATION', revision: 2 }
    };
    const recoveryJob = {
      ...waitingJob,
      id: '13013013-0130-4130-8130-130130130130',
      sku: '0000130',
      state: 'IMPORTING',
      updatedAt: '2026-08-13T08:00:00.000Z',
      payload: {
        mode: 'MULTISTORE_PUBLICATION',
        revision: 2,
        networkRecovery: {
          schemaVersion: 1,
          status: 'WAITING_NETWORK',
          phase: 'IMPORT_READBACK',
          resumeState: 'IMPORTING',
          deliveryState: 'NOT_SENT',
          attempt: 1,
          firstFailureAt: '2026-08-13T07:58:00.000Z',
          lastFailureAt: '2026-08-13T07:59:00.000Z',
          errorCode: 'NETWORK_TIMEOUT',
          errorMessage: '网络中断，原 OZON 任务等待自动续跑。',
          nextAttemptAt: '2026-08-13T08:02:00.000Z'
        }
      }
    };
    await page.route(/\/api\/v1\/ozon\/automation\/jobs(?:\?.*)?$/, (route) => route.fulfill({
      json: { items: [waitingJob, recoveryJob], total: 2, page: 1, pageSize: 20 }
    }));
    await page.route(/\/api\/v1\/ozon\/stores(?:\?.*)?$/, (route) => route.fulfill({
      json: { items: [readyStoreA], total: 1 }
    }));
    await page.route(/\/api\/v1\/ozon\/automation\/status$/, (route) => route.fulfill({
      json: { ...readyAutomationStatus, counts: { WAITING_MEDIA: 1, IMPORTING: 1 }, businessCounts: { WAITING_MEDIA: 1, IMPORTING: 1 } }
    }));
    await page.route(new RegExp(`/api/v1/ozon/automation/jobs/${waitingJob.id}(?:\\?.*)?$`), (route) => route.fulfill({
      json: { job: waitingJob }
    }));
    await page.route('/api/v1/ozon/listings/0000128', (route) => route.fulfill({
      json: { listing: { ...editableListing, sku: '0000128', revision: 2 }, canManualTakeover: false }
    }));

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/listing/ozon');

    const console = page.locator('.ozon-automation-console');
    const table = console.locator('.ozon-auto-jobs-table');
    await expect(table.getByRole('columnheader')).toHaveText([
      '店铺', 'SKU', '修订 / 方式', '自动状态', '绑定预设', '当前说明', '更新时间', '操作', 'OZON 商品链接'
    ]);
    for (const removed of ['总状态', '平台审核', '图片读回', '产品视频/封面', '价格生效', '库存可售']) {
      await expect(table.getByRole('columnheader', { name: removed, exact: true })).toHaveCount(0);
    }

    const row = console.getByLabel(new RegExp(waitingJob.id));
    await expect(row).toContainText('0000128');
    await expect(row.getByText('公共素材 R2', { exact: true })).toBeVisible();
    await expect(row.getByText('自动创建', { exact: true })).toBeVisible();
    await expect(row.getByText('等待媒体', { exact: true })).toBeVisible();
    await expect(row).toContainText('等待对应变体的 E005 图片和 E004 视频完成投递。');
    await expect(row).toContainText(formatShanghaiTime(waitingJob.updatedAt));

    const recoveryRow = console.getByLabel(new RegExp(recoveryJob.id));
    await expect(recoveryRow.getByText('OZON上品中', { exact: true })).toBeVisible();
    await expect(recoveryRow.getByText('导入受理', { exact: true })).toHaveCount(0);
    await expect(recoveryRow.getByText('网络恢复等待', { exact: true })).toHaveCount(0);
    await expect(recoveryRow).toContainText('系统正在继续完成 OZON 上品，无需人工处理。');
    await expect(recoveryRow).toContainText('下次检查 08-13 16:02:00');

    const metrics = console.getByLabel('OZON 自动上品任务统计');
    await expect(metrics.locator('.ozon-automation-metric').filter({ hasText: '等待条件' }).getByText('1', { exact: true })).toBeVisible();
    await expect(metrics.locator('.ozon-automation-metric').filter({ hasText: '处理中' }).getByText('1', { exact: true })).toBeVisible();
    await expect(metrics.locator('.ozon-automation-metric').filter({ hasText: '需人工处理' }).getByText('0', { exact: true })).toBeVisible();
    await expect(metrics.locator('.ozon-automation-metric').filter({ hasText: '成功任务' }).getByText('0', { exact: true })).toBeVisible();

    await console.getByLabel('搜索 OZON 自动任务').fill('0000128');
    await expect(console.getByRole('button', { name: /重\s*置/ })).toBeEnabled();
    await console.getByRole('button', { name: /重\s*置/ }).click();
    await expect(console.getByLabel('搜索 OZON 自动任务')).toHaveValue('');

    await row.getByRole('button', { name: '查看详情' }).click();
    const drawer = page.getByRole('dialog', { name: /自动上品详情/ });
    for (const stage of ['导入受理', '平台审核', '图片读回', '产品视频/封面', '价格生效', '库存可售']) {
      await expect(drawer.locator('.ozon-job-progress')).toContainText(stage);
    }
    await drawer.locator('.ant-drawer-close').click();

    for (const width of [620, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await expect(table.locator('.ant-table-cell-fix-right').first()).toHaveCSS('position', 'static');
    }
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('展示四个同级入口并同步查询参数和键盘焦点', async ({ page }) => {
    await page.goto('/listing/ozon');
    await expect(page.getByRole('heading', { name: 'OZON 上品' })).toBeVisible();
    await expect(page.locator('.ozon-stage-rail')).toHaveCount(0);
    await expect(page.locator('.ozon-system-strip > .ant-card-body')).toHaveCount(0);
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(4);
    await expect(tabs).toContainText(['自动上品任务', '手动上品资料', '类目模板', '上品预设模板']);
    await tabs.nth(1).click();
    await expect(page).toHaveURL(/view=manual/);
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await tabs.nth(1).press('ArrowRight');
    await expect(page).toHaveURL(/view=categories/);
    await expect(tabs.nth(2)).toBeFocused();
  });

  test('手动任务清单按最近 planHash 为两家店铺各显示一行', async ({ page }) => {
    const listing = { ...editableListing, sku: '0000120', revision: 3, status: 'READY' };
    const publication = (id: string, store: typeof readyStoreA, offerId: string, ozonSku: string) => ({
      publicationId: id,
      sku: listing.sku,
      generatedVersionId: '90000000-0000-4000-8000-000000000120',
      revision: listing.revision,
      planHash: `sha256:${'a'.repeat(64)}`,
      storeId: store.id,
      storeAlias: store.storeAlias,
      storeDisplayName: store.displayName,
      status: 'SUCCEEDED',
      publicationMode: 'CREATE_ONLY',
      presetBinding: { presetId: compatiblePreset.id, presetName: `${store.displayName}预设`, presetRowVersion: 4, sourcePresetExists: true },
      offerIds: [offerId],
      productLinks: [{ offerId, ozonProductId: `product-${ozonSku}`, ozonSku, url: `https://www.ozon.ru/product/task-${ozonSku}/` }],
      legacyProductUrls: [], rowVersion: 3,
      createdAt: '2026-08-14T01:00:00.000Z', updatedAt: '2026-08-14T02:00:00.000Z',
      currentMaterialRevision: 4, currentGeneratedVersionId: '90000000-0000-4000-8000-000000000121',
      sourceMediaCleanup: {
        cleanupId: '93000000-0000-4000-8000-000000000120', generatedVersionId: '90000000-0000-4000-8000-000000000120',
        sku: listing.sku, revision: 3, source: 'MANUAL', state: 'CLEANED', targetStoreCount: 2, reclaimedBytes: 2048,
        artifacts: [], createdAt: '2026-08-14T01:00:00.000Z', updatedAt: '2026-08-14T02:00:00.000Z'
      },
      capabilities: { canOpenWorkspace: true, canRepublish: true, canCompatibleAppend: false }
    });
    let publicationQuery: URL | undefined;
    let republishedPublicationId: string | undefined;
    await page.route(/\/api\/v1\/ozon\/listings(?:\?.*)?$/, (route) => route.fulfill({
      json: { items: [listing], total: 1, page: 1, pageSize: 100 }
    }));
    await page.route(/\/api\/v1\/ozon\/publication-task-summaries(?:\?.*)?$/, (route) => {
      publicationQuery = new URL(route.request().url());
      return route.fulfill({ json: {
        items: [
          publication('91000000-0000-4000-8000-000000000120', readyStoreA, '0000120-01', '54620001'),
          publication('92000000-0000-4000-8000-000000000120', readyStoreB, '0000120-02', '54620002')
        ],
        total: 2
      } });
    });
    await page.route(/\/api\/v1\/ozon\/publications\/[^/]+\/republish$/, (route) => {
      republishedPublicationId = new URL(route.request().url()).pathname.split('/').at(-2);
      return route.fulfill({ json: { publication: {
        storeDisplayNameSnapshot: readyStoreA.displayName,
        storeAliasSnapshot: readyStoreA.storeAlias
      } } });
    });

    await page.goto('/listing/ozon?view=manual');

    const table = page.locator('.ozon-manual-table');
    await expect(table.getByRole('columnheader')).toHaveText([
      '店铺', 'SKU', '修订 / 方式', '上品状态', '绑定预设', '当前说明', '更新时间', '操作', 'OZON 商品链接'
    ]);
    await expect(table.locator('tbody tr').filter({ hasText: listing.sku })).toHaveCount(2);
    const storeARow = table.locator('tbody tr').filter({ hasText: readyStoreA.displayName });
    const storeBRow = table.locator('tbody tr').filter({ hasText: readyStoreB.displayName });
    await expect(storeARow).toContainText('上品完成');
    await expect(storeBRow).toContainText('上品完成');
    await expect(storeARow.getByRole('link', { name: '打开 OZON 商品 54620001' })).toBeVisible();
    await expect(storeARow.getByRole('link', { name: '打开 OZON 商品 54620002' })).toHaveCount(0);
    await expect(storeBRow.getByRole('link', { name: '打开 OZON 商品 54620002' })).toBeVisible();
    await expect(storeBRow.getByRole('link', { name: '打开 OZON 商品 54620001' })).toHaveCount(0);
    await expect(storeARow).toContainText('当前公共素材已更新至 R4');
    await expect(storeARow).toContainText('该发布版本的源媒体已清理');
    await storeARow.getByRole('button', { name: '重新上品' }).click();
    await page.getByRole('button', { name: 'OK' }).click();
    await expect.poll(() => republishedPublicationId).toBe('91000000-0000-4000-8000-000000000120');
    expect(publicationQuery?.searchParams.get('skus')).toBe(listing.sku);
    expect(publicationQuery?.searchParams.get('source')).toBe('MANUAL');
    expect(publicationQuery?.searchParams.get('latestBatchOnly')).toBe('true');
    await page.setViewportSize({ width: 320, height: 720 });
    await expect(table.locator('.ant-table-cell-fix-right').first()).toHaveCSS('position', 'static');
    await expect(storeARow.getByRole('button', { name: '打开工作台' })).toBeVisible();
  });

  test('未发布公共素材不生成任务占位行，重新选择同一 SKU 仍打开现有工作台', async ({ page }) => {
    const listing = { ...editableListing, sku: '0000134', productName: '未发布公共素材', revision: 2, rowVersion: 2 };
    const createBodies: unknown[] = [];
    await page.route(/\/api\/v1\/ozon\/system$/, (route) => route.fulfill({ json: readyReadiness }));
    await page.route(/\/api\/v1\/ozon\/listings(?:\?.*)?$/, (route) => {
      if (route.request().method() === 'POST') {
        createBodies.push(route.request().postDataJSON());
        return route.fulfill({ json: {
          listing,
          generatedVersionId: '94000000-0000-4000-8000-000000000134',
          materialRevision: 2,
          materialHash: `sha256:${'a'.repeat(64)}`,
          contentPolicyVersion: 'merchroute-ozon-content-v3'
        } });
      }
      return route.fulfill({ json: { items: [listing], total: 1, page: 1, pageSize: 100 } });
    });
    await page.route('/api/v1/ozon/listings/0000134', (route) => route.fulfill({ json: { listing, canManualTakeover: false } }));
    await page.route(/\/api\/v1\/ozon\/publication-task-summaries(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [], total: 0 } }));
    await page.route(/\/api\/v1\/purchases\?.*/, (route) => route.fulfill({ json: {
      items: [{ sku: listing.sku, productName: listing.productName, variants: [], createdAt: listing.createdAt, updatedAt: listing.updatedAt, procurement: {} }],
      total: 1, page: 1, pageSize: 100
    } }));

    await page.goto('/listing/ozon?view=manual');
    const table = page.locator('.ozon-manual-table');
    await expect(table.locator('tbody tr').filter({ hasText: listing.sku })).toHaveCount(0);
    await expect(page.getByText('暂无逐店手动上品任务；未发布的公共素材不会显示在这里', { exact: true })).toBeVisible();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await page.getByRole('button', { name: /新建公共素材/ }).first().click();
      await page.getByRole('combobox', { name: '产品 SKU' }).click();
      await page.locator('.ant-select-item-option').filter({ hasText: listing.sku }).click();
      await page.getByRole('dialog', { name: '选择 MerchRoute 产品' }).getByRole('button', { name: '创建公共素材任务' }).click();
      const drawer = page.locator('.ozon-listing-drawer');
      await expect(drawer.getByText(listing.sku, { exact: true })).toBeVisible();
      await drawer.locator('.ant-drawer-close').click();
      await expect(table.locator('tbody tr').filter({ hasText: listing.sku })).toHaveCount(0);
    }
    expect(createBodies).toEqual([{ sku: listing.sku }, { sku: listing.sku }]);
  });

  test('320px 视口无横向溢出并可直接打开预设页', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto('/listing/ozon?view=presets');
    await expect(page.getByRole('tab', { name: /上品预设模板/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('OZON LISTING BLUEPRINT', { exact: true })).toBeVisible();
    await expect(page.getByText('预设按店铺绑定', { exact: true })).toBeVisible();
    await expect(page.getByText('还没有 OZON 上品预设模板', { exact: true })).toBeVisible();
    const newPresetButton = page.getByRole('button', { name: '新建上品预设' });
    await expect(newPresetButton).toBeVisible();
    await expect.poll(async () => (await newPresetButton.boundingBox())?.width || 0).toBeGreaterThanOrEqual(250);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('预设接口失败时保留引导区并提供重试入口', async ({ page }) => {
    await page.route(/\/api\/v1\/ozon\/presets$/, (route) => route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE', message: '预设服务暂不可用' } } }));
    await page.goto('/listing/ozon?view=presets');
    await expect(page.getByText('OZON LISTING BLUEPRINT', { exact: true })).toBeVisible();
    await expect(page.getByText('上品预设模板暂不可用', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /重\s*试/ })).toBeVisible();
  });

  test('OZON上品设置支持深链、三分区和统一公共设置入口', async ({ page }) => {
    await page.goto('/listing/ozon?settings=1');
    const drawer = page.getByRole('dialog', { name: 'OZON上品设置' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('tab')).toHaveCount(3);
    await expect(drawer.getByRole('tab')).toContainText(['店铺管理', '公共设置', '运行参数']);
    await drawer.getByRole('tab', { name: /公共设置/ }).click();
    await expect(drawer.getByText('启用 OZON 上品管理', { exact: true })).toBeVisible();
    await expect(drawer.getByRole('switch', { name: '启用 OZON 上品管理' })).toBeChecked();
    await expect(drawer.getByLabel('E004 MP4 能力探测文件')).toBeVisible();
    await expect(drawer.getByRole('button', { name: '验证 MP4 公网读取' })).toBeDisabled();
    await page.setViewportSize({ width: 320, height: 760 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await drawer.locator('.ant-drawer-close').click();
    await expect(page).not.toHaveURL(/settings=1/);
  });

  test('新店铺可以不选预设和仓库分阶段创建', async ({ page }) => {
    let createBody: Record<string, unknown> | undefined;
    let preflightCalls = 0;
    const stagedStore = {
      ...readyStoreA,
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      storeAlias: 'tek-plus', displayName: 'Tek+', enabled: false, autoPublishEnabled: false,
      defaultPresetId: undefined, warehouseId: '', warehouseName: '',
      credential: { state: 'MISSING', bindingMode: 'VAULT', configured: false },
      seller: {}, permissions: [], limits: {}, warehouses: [],
      preflight: { status: 'NOT_RUN', currencyVerified: false },
      readiness: { ready: false, score: 0, blockers: ['尚未配置凭据', '尚未选择默认上品预设', '尚未选择仓库'] },
      configVersion: 1, rowVersion: 1
    };
    await page.route(/\/api\/v1\/ozon\/stores(?:\?.*)?$/, (route) => {
      if (route.request().method() === 'POST') {
        createBody = route.request().postDataJSON() as Record<string, unknown>;
        return route.fulfill({ json: { store: stagedStore } });
      }
      return route.fulfill({ json: { items: [], total: 0 } });
    });
    await page.route(/\/api\/v1\/ozon\/stores\/[^/]+\/preflight$/, (route) => {
      preflightCalls += 1;
      return route.fulfill({ json: { accepted: true, store: stagedStore } });
    });

    await page.goto('/listing/ozon?settings=1');
    const settingsDrawer = page.getByRole('dialog', { name: 'OZON上品设置' });
    await settingsDrawer.getByRole('button', { name: '新建第一个店铺' }).click();
    const editor = page.getByRole('dialog', { name: '新建 OZON 店铺' });
    await editor.getByLabel('店铺别名').fill('tek-plus');
    await editor.getByLabel('店铺显示名称').fill('Tek+');
    await expect(editor.getByTitle('CNY · 人民币')).toBeVisible();
    await expect(editor.getByText('创建时可暂不选择，可在连接检查后补齐；启用和上品前由店铺准备度校验。', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: '创建店铺' }).click();

    await expect.poll(() => createBody).toEqual({
      storeAlias: 'tek-plus', displayName: 'Tek+', defaultPresetId: null,
      autoPublishEnabled: false, autoPublishMode: 'CREATE_ONLY',
      warehouseId: '', warehouseName: '', fulfillmentMode: 'FBS', accountCurrency: 'CNY', maxDailyStyles: 100
    });
    await expect(page.getByText('店铺已创建，请继续录入双凭据并执行连接检查', { exact: true })).toBeVisible();
    expect(preflightCalls).toBe(0);
  });

  test('编辑店铺回填当前账户币种并把修改后的币种随 CAS 版本保存', async ({ page }) => {
    let updateBody: Record<string, unknown> | undefined;
    const preflightBodies: Record<string, unknown>[] = [];
    const mutationOrder: string[] = [];
    let currentStore = { ...readyStoreA, accountCurrency: 'RUB' };
    await page.route(/\/api\/v1\/ozon\/stores(?:\?.*)?$/, (route) => route.fulfill({
      json: { items: [currentStore], total: 1 }
    }));
    await page.route(new RegExp(`/api/v1/ozon/stores/${readyStoreA.id}$`), (route) => {
      mutationOrder.push(route.request().method());
      updateBody = route.request().postDataJSON() as Record<string, unknown>;
      currentStore = { ...currentStore, ...updateBody, accountCurrency: 'CNY', rowVersion: currentStore.rowVersion + 1 };
      return route.fulfill({ json: { store: currentStore } });
    });
    await page.route(new RegExp(`/api/v1/ozon/stores/${readyStoreA.id}/preflight$`), (route) => {
      mutationOrder.push(route.request().method());
      preflightBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({ json: { accepted: true, store: currentStore } });
    });

    await page.goto('/listing/ozon?settings=1');
    const settingsDrawer = page.getByRole('dialog', { name: 'OZON上品设置' });
    const storeCard = settingsDrawer.locator('.ozon-store-card-item').filter({ hasText: readyStoreA.displayName });
    await storeCard.getByRole('button', { name: '编辑' }).click();
    const editor = page.getByRole('dialog', { name: `编辑店铺 · ${readyStoreA.displayName}` });
    await expect(editor.getByText('RUB · 俄罗斯卢布', { exact: true })).toBeVisible();
    await editor.locator('.ant-form-item').filter({ hasText: '账户币种' }).locator('.ant-select-selector').click();
    const currencyCombobox = editor.getByRole('combobox', { name: '账户币种' });
    await currencyCombobox.press('ArrowUp');
    await currencyCombobox.press('Enter');
    await expect(editor.getByTitle('CNY · 人民币')).toBeVisible();
    await editor.getByRole('button', { name: '保存店铺' }).click();

    await expect.poll(() => updateBody).toMatchObject({ accountCurrency: 'CNY', rowVersion: readyStoreA.rowVersion });
    await expect.poll(() => mutationOrder).toEqual(['PUT', 'POST']);
    expect(preflightBodies).toEqual([{ rowVersion: readyStoreA.rowVersion + 1 }]);
    await expect(page.getByText('店铺设置已保存', { exact: true })).toBeVisible();
    await expect(page.getByText(`${readyStoreA.displayName} 连接检查通过`, { exact: true })).toBeVisible();

    const manualPreflightButton = storeCard.getByRole('button', { name: '连接检查' });
    await expect(manualPreflightButton).toBeEnabled();
    await manualPreflightButton.click();
    await expect.poll(() => preflightBodies).toHaveLength(2);
    expect(preflightBodies[1]).toEqual({ rowVersion: readyStoreA.rowVersion + 1 });
  });

  test('编辑店铺保存失败时保留编辑器且不执行连接检查', async ({ page }) => {
    let preflightCalls = 0;
    await page.route(/\/api\/v1\/ozon\/stores(?:\?.*)?$/, (route) => route.fulfill({
      json: { items: [readyStoreA], total: 1 }
    }));
    await page.route(new RegExp(`/api/v1/ozon/stores/${readyStoreA.id}$`), (route) => route.fulfill({
      status: 409,
      json: { error: { code: 'CONFLICT', message: 'OZON 店铺已被其他操作更新' } }
    }));
    await page.route(new RegExp(`/api/v1/ozon/stores/${readyStoreA.id}/preflight$`), (route) => {
      preflightCalls += 1;
      return route.fulfill({ json: { accepted: true, store: readyStoreA } });
    });

    await page.goto('/listing/ozon?settings=1');
    const settingsDrawer = page.getByRole('dialog', { name: 'OZON上品设置' });
    await settingsDrawer.locator('.ozon-store-card-item').filter({ hasText: readyStoreA.displayName }).getByRole('button', { name: '编辑' }).click();
    const editor = page.getByRole('dialog', { name: `编辑店铺 · ${readyStoreA.displayName}` });
    await editor.getByRole('button', { name: '保存店铺' }).click();

    await expect(page.getByText('CONFLICT: OZON 店铺已被其他操作更新', { exact: true })).toBeVisible();
    await expect(editor).toBeVisible();
    expect(preflightCalls).toBe(0);
  });

  test('编辑无可用凭据的店铺后继续引导录入凭据且不执行连接检查', async ({ page }) => {
    let preflightCalls = 0;
    let currentStore = {
      ...readyStoreA,
      credential: { state: 'MISSING', bindingMode: 'VAULT', configured: false },
      seller: {}, permissions: [], limits: {},
      preflight: { status: 'NOT_RUN', currencyVerified: false },
      readiness: { ready: false, score: 50, blockers: ['尚未配置凭据'] }
    };
    await page.route(/\/api\/v1\/ozon\/stores(?:\?.*)?$/, (route) => route.fulfill({
      json: { items: [currentStore], total: 1 }
    }));
    await page.route(new RegExp(`/api/v1/ozon/stores/${readyStoreA.id}$`), (route) => {
      currentStore = { ...currentStore, ...route.request().postDataJSON(), rowVersion: currentStore.rowVersion + 1 };
      return route.fulfill({ json: { store: currentStore } });
    });
    await page.route(new RegExp(`/api/v1/ozon/stores/${readyStoreA.id}/preflight$`), (route) => {
      preflightCalls += 1;
      return route.fulfill({ json: { accepted: true, store: currentStore } });
    });

    await page.goto('/listing/ozon?settings=1');
    const settingsDrawer = page.getByRole('dialog', { name: 'OZON上品设置' });
    await settingsDrawer.locator('.ozon-store-card-item').filter({ hasText: readyStoreA.displayName }).getByRole('button', { name: '编辑' }).click();
    await page.getByRole('dialog', { name: `编辑店铺 · ${readyStoreA.displayName}` }).getByRole('button', { name: '保存店铺' }).click();

    await expect(page.getByRole('dialog', { name: `凭据 · ${readyStoreA.displayName}` })).toBeVisible();
    expect(preflightCalls).toBe(0);
  });

  test('店铺卡保持五项固定操作、可命名准备度和窄屏触控尺寸', async ({ page }) => {
    const readyStoreWithoutPermissionLabels = { ...readyStoreA, permissions: [] };
    await page.route(/\/api\/v1\/ozon\/stores(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [readyStoreWithoutPermissionLabels, pendingCredentialStore], total: 2 } }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/listing/ozon?settings=1');
    const drawer = page.getByRole('dialog', { name: 'OZON上品设置' });
    const cards = drawer.locator('.ozon-store-card-item');
    await expect(cards).toHaveCount(2);
    const firstCard = cards.filter({ hasText: readyStoreA.displayName });
    await expect(firstCard.getByRole('progressbar', { name: `${readyStoreA.displayName} 上品准备度` })).toBeVisible();
    await expect(firstCard.getByLabel(`${readyStoreA.displayName} 上品准备度 4/4`)).toBeVisible();
    await expect(firstCard.getByText('可上品', { exact: true })).toBeVisible();
    for (const name of ['编辑', '凭据', '连接检查', '停用', '归档']) {
      await expect(firstCard.getByRole('button', { name })).toHaveCount(1);
    }
    const pendingCard = cards.filter({ hasText: pendingCredentialStore.displayName });
    await expect(pendingCard.getByText(/待连接检查激活/)).toBeVisible();
    await expect(pendingCard.getByRole('button', { name: '连接检查' })).toBeEnabled();
    const detailsToggle = firstCard.getByRole('button', { name: '展开详情' });
    await expect(detailsToggle).toHaveAttribute('aria-expanded', 'false');
    await detailsToggle.click();
    await expect(firstCard.getByRole('region', { name: readyStoreA.displayName })).toBeVisible();
    await expect(firstCard.getByText('Seller 身份已验证', { exact: true })).toBeVisible();
    await expect(firstCard.getByText('尚未检查', { exact: true })).toHaveCount(0);
    await expect(firstCard.getByRole('button', { name: '收起详情' })).toHaveAttribute('aria-expanded', 'true');

    for (const width of [1440, 980, 760, 420, 320]) {
      await page.setViewportSize({ width, height: 900 });
      if (width <= 760) {
        await expect.poll(() => firstCard.locator('.ozon-store-actions .ant-btn').first().evaluate((button) => button.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      }
      const metrics = await firstCard.evaluate((card) => {
        const cardBox = card.getBoundingClientRect();
        const actionBoxes = Array.from(card.querySelectorAll<HTMLElement>('.ozon-store-actions .ant-btn')).map((button) => button.getBoundingClientRect());
        return {
          pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
          actionsInside: actionBoxes.every((box) => box.left >= cardBox.left - 1 && box.right <= cardBox.right + 1),
          actionHeights: actionBoxes.map((box) => box.height)
        };
      });
      expect(metrics.pageOverflow, `${width}px 不应产生页面级横向溢出`).toBe(false);
      expect(metrics.actionsInside, `${width}px 店铺操作必须留在卡片内`).toBe(true);
      expect(metrics.actionHeights).toHaveLength(5);
      if (width <= 760) {
        expect(
          metrics.actionHeights.every((height) => height >= 44),
          `${width}px 店铺操作触控高度：${metrics.actionHeights.join(', ')}`
        ).toBe(true);
      }
    }
  });

  test('多家可用店铺不自动选择，计划与提交保持冻结合同且无逐店预设覆盖', async ({ page }) => {
    let planBody: unknown;
    let createBody: unknown;
    const planHash = `sha256:${'a'.repeat(64)}`;
    const materialListing = withReadyPublicMaterial(editableListing);
    await page.route(/\/api\/v1\/ozon\/system$/, (route) => route.fulfill({ json: readyReadiness }));
    await page.route(/\/api\/v1\/ozon\/stores(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [readyStoreA, readyStoreB], total: 2 } }));
    await page.route(/\/api\/v1\/ozon\/categories$/, (route) => route.fulfill({ json: { items: [presetCategory] } }));
    await page.route(/\/api\/v1\/ozon\/presets$/, (route) => route.fulfill({ json: { items: [{ ...compatiblePreset, name: '共享商品蓝图' }] } }));
    await page.route(/\/api\/v1\/ozon\/listings(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [materialListing], total: 1, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000049$/, (route) => route.fulfill({ json: { listing: materialListing, canManualTakeover: false } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000049\/jobs(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000049\/media\/scan$/, (route) => route.fulfill({ json: { changed: false, listing: materialListing, mediaAssets: materialListing.data.mediaAssets, mediaDirectory: materialListing.data.mediaSourceRoot, removedReferences: 0 } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000049\/publication-plans$/, (route) => {
      planBody = route.request().postDataJSON();
      return route.fulfill({ json: { plan: {
        planHash, sku: editableListing.sku, draftVersion: editableListing.rowVersion,
        generatedVersionId: 'generated-5', revision: editableListing.revision, createdAt: '2026-08-11T02:00:00.000Z',
        items: [{
          storeId: readyStoreA.id, storeAlias: readyStoreA.storeAlias, displayName: readyStoreA.displayName,
          ready: true, blockers: [], storeRowVersion: readyStoreA.rowVersion, storeConfigVersion: readyStoreA.configVersion,
          credentialVersionId: readyStoreA.credential.activeVersionId, credentialBindingMode: 'VAULT',
          warehouseId: readyStoreA.warehouseId, warehouseName: readyStoreA.warehouseName,
          fulfillmentMode: readyStoreA.fulfillmentMode, accountCurrency: readyStoreA.accountCurrency,
          offerIds: ['0000049-01'], offerContractHash: 'sha256:offer', materializationHash: 'sha256:material', taskId: 'task-store-a'
        }]
      } } });
    });
    await page.route(/\/api\/v1\/ozon\/listings\/0000049\/publications$/, (route) => {
      createBody = route.request().postDataJSON();
      return route.fulfill({ json: { publications: [], accepted: 1, failed: 0 } });
    });
    await routeNoPublicationTaskSummaries(page);

    await openExistingPublicMaterial(page, materialListing);
    const listingDrawer = page.getByRole('dialog', { name: /0000049/ });
    await expect(listingDrawer.getByText('公共素材任务', { exact: true })).toBeVisible();
    await expect(listingDrawer.getByLabel('履约模式')).toHaveCount(0);
    await expect(listingDrawer.getByLabel('仓库 ID')).toHaveCount(0);
    await expect(listingDrawer.getByLabel('店铺合同币种')).toHaveCount(0);
    await listingDrawer.getByRole('button', { name: '选择店铺并提交' }).click();
    const modal = page.getByRole('dialog', { name: `选择发布店铺 · ${editableListing.sku}` });
    const storeChecks = modal.getByRole('checkbox', { name: /选择店铺/ });
    await expect(storeChecks).toHaveCount(2);
    await expect(storeChecks.first()).not.toBeChecked();
    await expect(storeChecks.last()).not.toBeChecked();
    await expect(modal.getByRole('combobox')).toHaveCount(0);
    for (const width of [1440, 980, 760, 420, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const metrics = await modal.evaluate((dialog) => {
        const content = dialog.querySelector<HTMLElement>('.ant-modal-content') || dialog;
        const box = content.getBoundingClientRect();
        return {
          pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
          dialogInside: box.left >= -1 && box.right <= window.innerWidth + 1
        };
      });
      expect(metrics.pageOverflow, `${width}px 发布对话框不应产生页面级横向溢出`).toBe(false);
      expect(metrics.dialogInside, `${width}px 发布对话框必须完整留在视口内`).toBe(true);
    }
    await storeChecks.first().check();
    await modal.getByRole('button', { name: '检查发布计划' }).click();
    await expect.poll(() => planBody).toEqual({ draftVersion: editableListing.rowVersion, storeIds: [readyStoreA.id] });
    await modal.getByRole('button', { name: '向 1 家店铺提交' }).click();
    await expect.poll(() => createBody).toMatchObject({ draftVersion: editableListing.rowVersion, storeIds: [readyStoreA.id], planHash });
    expect((createBody as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test('店铺发布结果按 publication 状态开放独立操作且写入只带冻结版本', async ({ page }) => {
    let syncBody: unknown;
    let remoteRecheckCalls = 0;
    const publicationBase = {
      id: 'publication-a', sku: editableListing.sku, generatedVersionId: 'generated-5', revision: 5,
      storeId: readyStoreA.id, storeAliasSnapshot: readyStoreA.storeAlias, storeDisplayNameSnapshot: readyStoreA.displayName,
      status: 'PAUSED', source: 'MANUAL', credentialBindingMode: 'VAULT', credentialVersionId: readyStoreA.credential.activeVersionId,
      storeConfigVersion: readyStoreA.configVersion, presetId: compatiblePreset.id, taskId: 'task-publication-a',
      warehouseId: readyStoreA.warehouseId, warehouseName: readyStoreA.warehouseName,
      fulfillmentMode: readyStoreA.fulfillmentMode, accountCurrency: readyStoreA.accountCurrency,
      offerIds: ['0000049-01'], offerContractHash: 'sha256:offer-a', materializationHash: 'sha256:material-a',
      productIds: [], ozonSkus: [], productLinks: [], result: {}, rowVersion: 3,
      createdAt: '2026-08-11T02:00:00.000Z', updatedAt: '2026-08-11T02:01:00.000Z'
    };
    const succeeded = {
      ...publicationBase,
      id: 'publication-b', storeId: readyStoreB.id, storeAliasSnapshot: readyStoreB.storeAlias,
      storeDisplayNameSnapshot: readyStoreB.displayName, status: 'SUCCEEDED', taskId: 'task-publication-b',
      offerContractHash: 'sha256:offer-b', materializationHash: 'sha256:material-b', rowVersion: 7,
      updatedAt: '2026-08-11T02:02:00.000Z', completedAt: '2026-08-11T02:02:00.000Z'
    };
    await page.route(/\/api\/v1\/ozon\/system$/, (route) => route.fulfill({ json: readyReadiness }));
    await page.route(/\/api\/v1\/ozon\/categories$/, (route) => route.fulfill({ json: { items: [presetCategory] } }));
    await page.route(/\/api\/v1\/ozon\/listings(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [editableListing], total: 1, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000049$/, (route) => route.fulfill({ json: { listing: editableListing, canManualTakeover: false } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000049\/jobs(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000049\/media\/scan$/, (route) => route.fulfill({ json: { changed: false, listing: editableListing, mediaAssets: [], mediaDirectory: editableListing.data.mediaSourceRoot, removedReferences: 0 } }));
    await page.route(/\/api\/v1\/ozon\/publications(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [publicationBase, succeeded], total: 2 } }));
    await page.route(/\/api\/v1\/ozon\/publications\/publication-a\/sync$/, (route) => {
      syncBody = route.request().postDataJSON();
      return route.fulfill({ json: { publication: publicationBase } });
    });
    await page.route(/\/api\/v1\/ozon\/publications\/publication-a\/recheck$/, (route) => {
      remoteRecheckCalls += 1;
      return route.fulfill({ status: 409, json: { error: { code: 'OZON_READBACK_DISPATCH_UNAVAILABLE', message: '等待受控 OZON 多店 fleet 部署' } } });
    });

    await page.goto('/listing/ozon?view=manual');
    await page.getByRole('button', { name: '打开工作台' }).click();
    const drawer = page.getByRole('dialog', { name: /0000049/ });
    const pausedResult = drawer.getByRole('listitem', { name: `${readyStoreA.displayName} 发布结果` });
    await expect(pausedResult.getByRole('button', { name: '同步本地任务状态' })).toBeVisible();
    await expect(pausedResult.getByRole('button', { name: '等待多店 fleet 部署' })).toBeDisabled();
    await expect(pausedResult.getByRole('button', { name: '重新检查平台' })).toHaveCount(0);
    await expect(pausedResult.getByRole('button', { name: '取消' })).toBeVisible();
    const succeededResult = drawer.getByRole('listitem', { name: `${readyStoreB.displayName} 发布结果` });
    await expect(succeededResult.getByRole('button', { name: '兼容追加' })).toBeVisible();
    await expect(succeededResult.getByRole('button', { name: '重新上品' })).toBeVisible();
    for (const width of [1440, 980, 760, 420, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const metrics = await pausedResult.evaluate((result) => {
        const resultBox = result.getBoundingClientRect();
        const actionBoxes = Array.from(result.querySelectorAll<HTMLElement>('.ozon-publication-result-actions .ant-btn')).map((button) => button.getBoundingClientRect());
        return {
          pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
          actionsInside: actionBoxes.every((box) => box.left >= resultBox.left - 1 && box.right <= resultBox.right + 1)
        };
      });
      expect(metrics.pageOverflow, `${width}px publication 结果不应产生页面级横向溢出`).toBe(false);
      expect(metrics.actionsInside, `${width}px publication 操作必须留在结果卡片内`).toBe(true);
    }
    await pausedResult.getByRole('button', { name: '同步本地任务状态' }).click();
    await expect.poll(() => syncBody).toEqual({ rowVersion: publicationBase.rowVersion });
    await expect(page.getByText(`${readyStoreA.displayName} 已同步本地任务状态`, { exact: true })).toBeVisible();
    await expect(page.getByText(/OZON 状态已回查/)).toHaveCount(0);
    expect(remoteRecheckCalls).toBe(0);
  });

  test('服务端明确开放 capability 后 publication 远端回查只调用 recheck', async ({ page }) => {
    const planHash = `sha256:${'c'.repeat(64)}`;
    const requestId = '11111111-1111-4111-8111-111111111111';
    const publication = {
      id: 'publication-readback-enabled', sku: editableListing.sku, generatedVersionId: 'generated-5', revision: 5,
      storeId: readyStoreA.id, storeAliasSnapshot: readyStoreA.storeAlias, storeDisplayNameSnapshot: readyStoreA.displayName,
      status: 'PAUSED', source: 'MANUAL', credentialBindingMode: 'VAULT', credentialVersionId: readyStoreA.credential.activeVersionId,
      storeConfigVersion: readyStoreA.configVersion, presetId: compatiblePreset.id, taskId: 'task-readback-enabled',
      warehouseId: readyStoreA.warehouseId, warehouseName: readyStoreA.warehouseName,
      fulfillmentMode: readyStoreA.fulfillmentMode, accountCurrency: readyStoreA.accountCurrency,
      offerIds: ['0000049-01'], offerContractHash: 'sha256:offer-readback', materializationHash: 'sha256:material-readback',
      productIds: [], ozonSkus: [], productLinks: [], result: {}, planHash, requestId, rowVersion: 9,
      createdAt: '2026-08-11T02:00:00.000Z', updatedAt: '2026-08-11T02:01:00.000Z'
    };
    let recheckBody: unknown;
    let syncCalls = 0;
    await page.route(/\/api\/v1\/ozon\/settings$/, (route) => route.fulfill({ json: { settings: { ...multiStoreSettings, publicationReadbackEnabled: true } } }));
    await page.route(/\/api\/v1\/ozon\/system$/, (route) => route.fulfill({ json: readyReadiness }));
    await page.route(/\/api\/v1\/ozon\/categories$/, (route) => route.fulfill({ json: { items: [presetCategory] } }));
    await page.route(/\/api\/v1\/ozon\/listings(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [editableListing], total: 1, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000049$/, (route) => route.fulfill({ json: { listing: editableListing, canManualTakeover: false } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000049\/jobs(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000049\/media\/scan$/, (route) => route.fulfill({ json: { changed: false, listing: editableListing, mediaAssets: [], mediaDirectory: editableListing.data.mediaSourceRoot, removedReferences: 0 } }));
    await page.route(/\/api\/v1\/ozon\/publications(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [publication], total: 1 } }));
    await page.route(/\/api\/v1\/ozon\/publications\/publication-readback-enabled\/task-detail$/, (route) => route.fulfill({ json: {
      publication,
      events: [],
      frozenContract: { planHash, requestId },
      readback: { required: false, canRecheck: true, gatewayRequestCount: 0, deliveryStates: [] },
      recovery: { canRecheck: true, canManualTakeover: false, recoveryMode: 'READBACK_REQUIRED' }
    } }));
    await page.route(/\/api\/v1\/ozon\/publications\/publication-readback-enabled\/sync$/, (route) => {
      syncCalls += 1;
      return route.fulfill({ json: { publication } });
    });
    await page.route(/\/api\/v1\/ozon\/publications\/publication-readback-enabled\/recheck$/, (route) => {
      recheckBody = route.request().postDataJSON();
      return route.fulfill({ json: { publication: { ...publication, rowVersion: 10 } } });
    });

    await page.goto('/listing/ozon?view=manual');
    await page.getByRole('button', { name: '打开工作台' }).click();
    const result = page.getByRole('dialog', { name: /0000049/ }).getByRole('listitem', { name: `${readyStoreA.displayName} 发布结果` });
    await expect(result.getByRole('button', { name: '重新检查平台' })).toBeEnabled();
    await expect(result.getByRole('button', { name: '等待多店 fleet 部署' })).toHaveCount(0);
    await result.getByRole('button', { name: '重新检查平台' }).click();
    await expect.poll(() => recheckBody).toEqual({ rowVersion: publication.rowVersion, planHash, requestId });
    await expect(page.getByText(`${readyStoreA.displayName} 的 OZON 平台状态已重新检查`, { exact: true })).toBeVisible();
    expect(syncCalls).toBe(0);
  });

  test('预设编辑器只显示迁移说明，不提供店铺自动策略、仓库或币种控件', async ({ page }) => {
    await page.goto('/listing/ozon?view=presets');
    await page.getByRole('button', { name: '新建上品预设' }).click();
    const drawer = page.getByRole('dialog', { name: '新建 OZON 上品预设模板' });
    await expect(drawer.getByText('履约、仓库和合同币种不属于商品预设', { exact: true })).toBeVisible();
    await expect(drawer.getByLabel('自动上品策略')).toHaveCount(0);
    await expect(drawer.getByLabel('默认仓库')).toHaveCount(0);
    await expect(drawer.getByLabel('店铺合同币种')).toHaveCount(0);
  });

  test('总开关关闭时保留迁移前结果读取且不暴露 SKU 级写操作', async ({ page }) => {
    await page.goto('/listing/ozon?view=manual');
    await expect(page.getByText('OZON 上品管理未启用', { exact: true })).toBeVisible();
    await expect(page.getByText('当前禁止新建、扫描媒体和创建店铺 publication；已有共享草稿仍可查看和编辑。', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '新建公共素材' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '打开工作台' })).toBeEnabled();
    await expect(page.getByRole('button', { name: '追加新变体' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '重新上品' })).toBeDisabled();
  });

  test('自动任务页按店铺启用与就绪状态给出独立提示', async ({ page }) => {
    let statusKind: 'STORE_OFF' | 'NOT_READY' | 'READY' = 'STORE_OFF';
    await page.route(/\/api\/v1\/ozon\/automation\/status$/, (route) => {
      const systemReady = statusKind === 'READY';
      return route.fulfill({ json: {
        readiness: { ...readyReadiness, ready: systemReady, issues: systemReady ? [] : ['默认店铺凭据尚未就绪'] },
        counts: {},
        managementEnabled: true,
        acceptingNewJobs: systemReady,
        continuingBoundJobs: 0,
        worker: { running: true }
      } });
    });
    await page.route(/\/api\/v1\/ozon\/stores(?:\?.*)?$/, (route) => {
      if (statusKind === 'STORE_OFF') return route.fulfill({ json: { items: [], total: 0 } });
      const store = statusKind === 'READY' ? readyStoreA : {
        ...readyStoreA,
        readiness: { ready: false, score: 80, blockers: ['预检已过期'] },
        preflight: { ...readyStoreA.preflight, status: 'FAILED', errorMessage: '预检已过期' }
      };
      return route.fulfill({ json: { items: [store], total: 1 } });
    });

    await page.goto('/listing/ozon');
    await expect(page.getByText('自动上品未开启', { exact: true })).toBeVisible();
    statusKind = 'NOT_READY';
    await page.reload();
    await expect(page.getByText('部分自动上品店铺尚未就绪', { exact: true })).toBeVisible();
    statusKind = 'READY';
    await page.reload();
    await expect(page.getByText('自动上品已启用 · 1 家店铺可用', { exact: true })).toBeVisible();
  });

  test('预设列表只展示商品蓝图与迁移后的店铺策略说明', async ({ page }) => {
    const presetBase = {
      description: '',
      categoryKey: presetCategory.categoryKey,
      pricingTemplateId: '11111111-1111-4111-8111-111111111111',
      shippingTemplateId: '22222222-2222-4222-8222-222222222222',
      shippingServiceCode: 'CEL_RFBS_ECONOMY',
      vat: '0.2', defaultStock: 1,
      dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 0.8, weightUnit: 'kg' },
      sharedAttributes: [{ attributeId: 10, complexId: 0, values: [{ value: '涤纶' }] }], variantAttributes: [],
      titleTranslation: { workflowId: 'HDh0ZNLK2ps5qasR', language: '俄文', maxLength: 60 },
      descriptionSource: 'E003', sizeAttributeKey: '4298:0', sizes: [{ sizeId: '11111111-2222-4111-8111-111111111111', value: 'dict:35', stock: 1 }], mediaPolicy: 'REPLACE_ALL',
      rowVersion: 1, createdAt: '2026-08-02T08:00:00.000Z', updatedAt: '2026-08-02T08:00:00.000Z'
    };
    const presetItems = [
      { ...presetBase, id: '11111111-1111-4111-8111-111111111111', name: '箱包商品蓝图', description: '适用于箱包类目' },
      { ...presetBase, id: '22222222-2222-4222-8222-222222222222', name: '服饰商品蓝图' },
      { ...presetBase, id: '33333333-3333-4333-8333-333333333333', name: '家居商品蓝图' }
    ];
    const mutationRequests: string[] = [];
    let savedPresetBody: any;
    await page.route(/\/api\/v1\/ozon\/presets(?:\/.*)?$/, (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/v1/ozon/presets' && request.method() === 'GET') return route.fulfill({ json: { items: presetItems } });
      if (request.method() === 'GET') return route.fulfill({ json: { preset: presetItems.find((item) => path.includes(item.id)) || presetItems[0] } });
      mutationRequests.push(`${request.method()} ${path}`);
      if (path.endsWith('/clone')) return route.fulfill({ json: { preset: presetItems[1] } });
      if (request.method() === 'DELETE') return route.fulfill({ json: { deleted: { id: presetItems[2].id, name: presetItems[2].name } } });
      if (request.method() === 'PUT') savedPresetBody = request.postDataJSON();
      return route.fulfill({ json: { preset: presetItems[0] } });
    });
    await page.route(/\/api\/v1\/ozon\/categories$/, (route) => route.fulfill({ json: { items: [presetCategory] } }));
    await page.route(/\/api\/v1\/pricing\/templates$/, (route) => route.fulfill({ json: { items: [{
      id: presetBase.pricingTemplateId, name: 'OZON 平台默认定价', platformCode: 'OZON', platformName: 'OZON', active: true,
      createdAt: presetBase.createdAt, updatedAt: presetBase.updatedAt,
      publishedVersion: { id: '44444444-4444-4444-8444-444444444444', versionNo: 3, publishedAt: presetBase.updatedAt }
    }] } }));
    await page.route(/\/api\/v1\/shipping\/templates$/, (route) => route.fulfill({ json: { items: [{
      id: presetBase.shippingTemplateId, name: 'OZON 跨境运费', platformCode: 'OZON', scenarioCode: 'RFBS', templateType: 'STANDARD', active: true,
      carrierCode: 'CEL', carrierName: 'CEL 物流', carrierActive: true, createdAt: presetBase.createdAt, updatedAt: presetBase.updatedAt,
      publishedVersion: { id: '55555555-5555-4555-8555-555555555556', versionNo: 7, publishedAt: presetBase.updatedAt }
    }] } }));

    await page.goto('/listing/ozon?view=presets');
    const table = page.locator('.ozon-preset-table-shell');
    const rows = table.locator('tbody tr[data-row-key]');
    await expect(rows).toHaveCount(3);
    await expect(table.locator('thead')).toContainText(/预设.*定价链.*商品默认值.*店铺策略.*更新时间.*操作/);
    const blueprintRow = rows.filter({ hasText: '箱包商品蓝图' });
    await expect(blueprintRow.getByText('在店铺设置管理', { exact: true })).toBeVisible();
    await expect(blueprintRow.getByText('本页不再修改', { exact: true })).toBeVisible();
    await expect(blueprintRow.getByLabel('OZON 预设定价链')).toContainText(/OZON 平台默认定价.*V3.*CEL 物流 · OZON 跨境运费.*V7.*CEL_RFBS_ECONOMY.*上架价 CNY/);
    await expect(blueprintRow).toContainText(/双肩背包 \/ Рюкзаки.*VAT · 20%.*库存 · 1.*类目 V2/);
    await expect(blueprintRow).toContainText(new RegExp(`${formatShanghaiTime(presetBase.updatedAt, 'YYYY-MM-DD')}.*${formatShanghaiTime(presetBase.updatedAt, 'HH:mm')} · R1`));
    const candidateRow = rows.filter({ hasText: '服饰商品蓝图' });
    const removableRow = rows.filter({ hasText: '家居商品蓝图' });
    await expect(table.getByRole('button', { name: '设为默认' })).toHaveCount(0);

    await blueprintRow.getByRole('button', { name: '编辑' }).click();
    const presetDrawer = page.getByRole('dialog', { name: /箱包商品蓝图/ });
    await expect(presetDrawer).toBeVisible();
    await expect(presetDrawer.getByText('采购毛重优先，预设毛重仅兜底', { exact: true })).toBeVisible();
    await expect(presetDrawer.getByRole('spinbutton', { name: '兜底毛重 (g)' })).toHaveValue('800');
    await expect(presetDrawer.getByRole('textbox', { name: '重量单位' })).toHaveValue('g');
    await expect(presetDrawer.getByRole('textbox', { name: '重量单位' })).toHaveAttribute('readonly');
    await presetDrawer.getByRole('button', { name: '保存修改' }).click();
    await expect.poll(() => savedPresetBody).toBeTruthy();
    expect(savedPresetBody.dimensions).toEqual({ length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 800, weightUnit: 'g' });
    for (const removedField of ['isDefault', 'autoPublishEnabled', 'autoPublishMode', 'autoPublishActivatedAt', 'warehouseId', 'fulfillmentMode', 'currency']) {
      expect(savedPresetBody).not.toHaveProperty(removedField);
    }
    await expect(presetDrawer).toBeHidden();
    await candidateRow.getByRole('button', { name: '复制' }).click();
    await expect.poll(() => mutationRequests).toContain(`POST /api/v1/ozon/presets/${presetItems[1].id}/clone`);
    await removableRow.getByRole('button', { name: '删除' }).click();
    await page.locator('.ant-popconfirm:visible').getByRole('button', { name: '删除预设' }).click();
    await expect.poll(() => mutationRequests).toContain(`DELETE /api/v1/ozon/presets/${presetItems[2].id}`);
  });

  test('自动任务详情保留产品介绍视频与视频封面读回状态', async ({ page }) => {
    await page.route(`/api/v1/ozon/automation/jobs/${successfulJob.id}`, (route) => route.fulfill({ json: { job: successfulJob } }));
    await page.goto('/listing/ozon');
    const autoTable = page.locator('.ozon-console').first();
    await autoTable.getByText('0000051', { exact: true }).click();
    const detail = page.getByRole('dialog', { name: /自动上品详情/ });
    const verification = detail.getByLabel('产品视频与封面逐变体验证');
    await expect(verification.getByText('产品视频/封面读回')).toBeVisible();
    await expect(verification.getByText('0000051-01', { exact: true })).toBeVisible();
    await expect(verification.getByText('0000051-02', { exact: true })).toBeVisible();
    await expect(verification.getByText('同一 MP4', { exact: true })).toHaveCount(2);
    await expect(detail.getByText('历史任务未记录上品资料快照', { exact: true })).toBeVisible();
  });

  test('自动任务详情展示上品资料快照、待处理原因和平台一致性告警', async ({ page }) => {
    const auditedJob = {
      ...successfulJob,
      state: 'NEEDS_ATTENTION',
      lastErrorCode: 'OZON_MANUAL_DRAFT_PRESENT',
      lastErrorMessage: '检测到同一 SKU 已有手动上品资料，请先处理手动草稿',
      stageStates: { ...successfulJob.stageStates, images: 'DIFFERENCE', video: 'DIFFERENCE', productVideo: 'DIFFERENCE' },
      ozonProductLinks: successfulJob.ozonProductLinks.map((link, index) => index === 0 ? { ...link, warnings: ['主图仍在平台处理'] } : link),
      payload: {
        materialSnapshot: {
          schemaVersion: 1,
          capturedAt: '2026-08-07T04:30:00.000Z',
          preset: { id: 'preset-1', name: '默认自动预设', rowVersion: 7, definitionHash: 'sha256:preset-definition' },
          category: { key: 'ozon_17001_97001', versionId: 'category-version-1', versionNo: 3, schemaHash: 'sha256:category-schema' },
          procurement: {
            versionId: 'procurement-version-1', versionNo: 9, capturedAt: '2026-08-07T04:20:00.000Z',
            productHeightCm: '12.5', productDepthCm: '28', productWidthCm: '20', netWeightGrams: '640'
          },
          packaging: { lengthCm: 30, widthCm: 22, heightCm: 14, grossWeightGrams: 800, grossWeightSource: 'PROCUREMENT' },
          pricing: { pricingTemplateId: 'pricing-1', shippingTemplateId: 'shipping-1', shippingServiceCode: 'CDEK', optionId: 'option-1' },
          store: { storeAlias: 'default', warehouseId: 'warehouse-1', currency: 'RUB', fulfillmentMode: 'FBS' },
          offers: { count: 2, ids: ['0000051-01', '0000051-02'] },
          artifact: { revision: 11, signature: 'sha256:artifact-signature' },
          warnings: ['净重使用采购版本快照']
        },
        platformStatusRefresh: { warnings: ['OZON 读回图片数量与提交资料不同'] }
      }
    };
    await page.route(/\/api\/v1\/ozon\/automation\/jobs(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [auditedJob], total: 1, page: 1, pageSize: 30 } }));
    await page.route(new RegExp(`/api/v1/ozon/automation/jobs/${auditedJob.id}(?:\\?.*)?$`), (route) => route.fulfill({ json: { job: auditedJob } }));

    await page.goto('/listing/ozon');
    await page.locator('.ozon-console').first().getByText('0000051', { exact: true }).click();
    const detail = page.getByRole('dialog', { name: /自动上品详情/ });
    const pendingReason = detail.locator('.ant-alert').filter({ hasText: 'OZON_MANUAL_DRAFT_PRESENT' });
    await expect(pendingReason.getByText('待处理原因 · OZON_MANUAL_DRAFT_PRESENT', { exact: true })).toBeVisible();
    await expect(pendingReason.getByText('检测到同一 SKU 已有手动上品资料，请先处理手动草稿', { exact: true })).toBeVisible();
    await expect(detail.getByText('平台一致性告警', { exact: true })).toBeVisible();
    await expect(detail.getByText('阶段差异：图片读回、产品视频/封面汇总、产品介绍视频', { exact: true })).toBeVisible();
    await expect(detail.getByText('OZON 读回图片数量与提交资料不同', { exact: false })).toBeVisible();
    await expect(detail.getByText('主图仍在平台处理', { exact: true })).toBeVisible();

    await expect(detail.getByText('上品资料快照', { exact: true })).toBeVisible();
    await expect(detail.getByText('v1', { exact: true })).toBeVisible();
    await expect(detail.getByText('默认自动预设 · rowVersion 7', { exact: true })).toBeVisible();
    await expect(detail.getByText('ozon_17001_97001 · v3', { exact: true })).toBeVisible();
    await expect(detail.getByText('商品高 12.5 cm · 商品深 28 cm', { exact: true })).toBeVisible();
    await expect(detail.getByText('商品宽 20 cm · 净重 640 g', { exact: true })).toBeVisible();
    await expect(detail.getByText('包装（长 × 宽 × 高） 30 × 22 × 14 cm', { exact: true })).toBeVisible();
    await expect(detail.getByText('采购记录', { exact: true })).toBeVisible();
    await expect(detail.getByText('共 2 个 Offer', { exact: true })).toBeVisible();
    await expect(detail.getByText('快照记录了 1 条资料告警', { exact: true })).toBeVisible();
    await expect(detail.getByText('历史任务未记录上品资料快照', { exact: true })).toHaveCount(0);

    await page.setViewportSize({ width: 320, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('自动任务深链和显式入口复用同一上品资料工作台并保留筛选', async ({ page }) => {
    const listingDetail = {
      ...publishedListing,
      data: {
        ...editableListing.data,
        mediaSourceRoot: 'G:\\01_MerchRoute\\OZON-Auto-Publish\\inbox\\0000051',
        offers: []
      }
    };
    await page.route(/\/api\/v1\/ozon\/.*/, async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (path === '/api/v1/ozon/system') return route.fulfill({ json: readyReadiness });
      if (path === '/api/v1/ozon/automation/status') return route.fulfill({ json: { ...readyAutomationStatus, counts: { SUCCEEDED: 1 } } });
      if (path === '/api/v1/ozon/automation/jobs' && method === 'GET') return route.fulfill({ json: { items: [successfulJob], total: 1, page: 1, pageSize: 30 } });
      if (path === `/api/v1/ozon/automation/jobs/${successfulJob.id}` && method === 'GET') return route.fulfill({ json: { job: successfulJob } });
      if (path === `/api/v1/ozon/automation/jobs/${successfulJob.id}/listing-snapshot` && method === 'GET') return route.fulfill({ json: { snapshot: {
        mode: 'AUTO_TASK_SNAPSHOT',
        readOnly: true,
        jobId: successfulJob.id,
        publicationId: 'publication-0000051',
        generatedVersionId: 'generated-0000051-r3',
        sku: successfulJob.sku,
        revision: 3,
        store: { id: successfulJob.storeId, storeAlias: 'default', displayName: 'OZON 主店', accountCurrency: 'CNY', accountCurrencyChanged: false },
        listing: { ...listingDetail, generatedVersionId: 'generated-0000051-r3' },
        pricing: { currency: 'CNY', offers: [] }
      } } });
      if (path === '/api/v1/ozon/listings/0000051' && method === 'GET') return route.fulfill({ json: { listing: listingDetail, canManualTakeover: false } });
      if (path === '/api/v1/ozon/listings/0000051/jobs' && method === 'GET') return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } });
      return route.fallback();
    });

    await page.goto(`/listing/ozon?job=${successfulJob.id}&store=${successfulJob.storeId}`);
    let detail = page.getByRole('dialog', { name: /自动上品详情/ });
    await expect(detail).toBeVisible();
    await expect(detail.getByRole('row', { name: /产品 SKU 0000051/ })).toBeVisible();
    const initialActions = detail.locator('.ozon-auto-job-actions .ant-btn');
    await expect(initialActions).toHaveCount(3);
    expect(await initialActions.allTextContents()).toEqual(['打开上品资料', '重新检测', '取消自动任务']);
    await expect(initialActions.nth(0)).toBeEnabled();

    await page.setViewportSize({ width: 320, height: 900 });
    await expect(detail.getByRole('button', { name: '打开上品资料' })).toBeVisible();
    await expect(detail.getByRole('button', { name: '重新检测' })).toBeVisible();
    await expect(detail.getByRole('button', { name: '取消自动任务' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await detail.getByRole('button', { name: 'Close' }).click();
    await expect(detail).toBeHidden();
    await expect(page).not.toHaveURL(/job=/);

    const search = page.getByRole('searchbox', { name: '搜索 OZON 自动任务' });
    await search.fill('0000051');
    const row = page.locator('.ozon-console').first().locator('tbody tr').filter({ hasText: '0000051' });
    await row.getByRole('button', { name: '查看详情' }).click();
    await expect(page).toHaveURL(new RegExp(`job=${successfulJob.id}.*store=${successfulJob.storeId}`));
    detail = page.getByRole('dialog', { name: /自动上品详情/ });
    await detail.getByRole('button', { name: '打开上品资料' }).click();

    const editor = page.getByRole('dialog', { name: /0000051/ });
    await expect(editor).toBeVisible();
    await expect(page.getByRole('tab', { name: /自动上品任务/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(new RegExp(`job=${successfulJob.id}.*store=${successfulJob.storeId}.*listing=0000051`));
    await editor.getByRole('button', { name: 'Close' }).click();
    await expect(page).toHaveURL(new RegExp(`job=${successfulJob.id}.*store=${successfulJob.storeId}`));
    await expect(page).not.toHaveURL(/listing=/);
    await expect(page.getByRole('dialog', { name: /自动上品详情/ })).toBeVisible();
    await expect(search).toHaveValue('0000051');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('纯 legacy 自动任务仍使用 storeId 旧接口，远程任务禁止取消', async ({ page }) => {
    let managementEnabled = true;
    let recheckCalls = 0;
    let cancelCalls = 0;
    let localJob = {
      ...waitingAutoJob,
      publicationId: undefined,
      state: 'NEEDS_ATTENTION',
      lastErrorCode: 'MEDIA_NOT_READY',
      lastErrorMessage: '等待媒体重新检测'
    };
    const remoteJob = {
      ...waitingAutoJob,
      id: '77777777-7777-4777-8777-777777777777',
      sku: '0000062',
      state: 'NEEDS_ATTENTION',
      importTaskId: 'ozon-import-0000062',
      directoryStage: 'PROCESSING',
      rowVersion: 8
    };
    const leasedJob = {
      ...waitingAutoJob,
      id: '88888888-8888-4888-8888-888888888888',
      sku: '0000063',
      state: 'NEEDS_ATTENTION',
      leaseOwner: 'ozon-p002:e2e',
      leaseExpiresAt: '2099-08-09T12:34:56.000Z',
      rowVersion: 9
    };
    await page.route(/\/api\/v1\/ozon\/.*/, async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (path === '/api/v1/ozon/system') return route.fulfill({ json: readyReadiness });
      if (path === '/api/v1/ozon/automation/status') return route.fulfill({ json: { ...readyAutomationStatus, managementEnabled, counts: { NEEDS_ATTENTION: 3 } } });
      if (path === '/api/v1/ozon/automation/jobs' && method === 'GET') return route.fulfill({ json: { items: [localJob, remoteJob, leasedJob], total: 3, page: 1, pageSize: 30 } });
      if (path === `/api/v1/ozon/automation/jobs/${localJob.id}` && method === 'GET') return route.fulfill({ json: { job: localJob } });
      if (path === `/api/v1/ozon/automation/jobs/${remoteJob.id}` && method === 'GET') return route.fulfill({ json: { job: remoteJob } });
      if (path === `/api/v1/ozon/automation/jobs/${leasedJob.id}` && method === 'GET') return route.fulfill({ json: { job: leasedJob } });
      if (path === `/api/v1/ozon/automation/jobs/${localJob.id}/recheck` && method === 'POST') {
        expect(route.request().postDataJSON()).toEqual({ storeId: localJob.storeId });
        recheckCalls += 1;
        return route.fulfill({ json: { job: localJob } });
      }
      if (path === `/api/v1/ozon/automation/jobs/${localJob.id}/cancel` && method === 'POST') {
        expect(route.request().postDataJSON()).toEqual({ storeId: localJob.storeId });
        cancelCalls += 1;
        localJob = { ...localJob, state: 'CANCELLED', rowVersion: localJob.rowVersion + 1 };
        return route.fulfill({ json: { job: localJob } });
      }
      if (/\/api\/v1\/ozon\/listings\/\d+$/.test(path) && method === 'GET') return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: '尚未生成上品资料' } } });
      return route.fallback();
    });

    await page.goto('/listing/ozon');
    const autoTable = page.locator('.ozon-console').first();
    await autoTable.locator('tbody tr').filter({ hasText: '0000049' }).getByRole('button', { name: '查看详情' }).click();
    let detail = page.getByRole('dialog', { name: /自动上品详情/ });
    await expect(detail.getByRole('button', { name: '重新检测' })).toBeEnabled();
    await expect(detail.getByRole('button', { name: '取消自动任务' })).toBeEnabled();

    await detail.getByRole('button', { name: '重新检测' }).click();
    await expect.poll(() => recheckCalls).toBe(1);
    await expect(page.getByText('SKU 0000049 已重新检测，将继续使用原自动任务处理', { exact: true })).toBeVisible();

    managementEnabled = false;
    await detail.getByRole('button', { name: '取消自动任务' }).click();
    const confirm = page.locator('.ant-modal-confirm').filter({ hasText: '取消 SKU 0000049 的自动上品任务？' });
    await expect(confirm).toContainText('保留已经生成的上品资料');
    await confirm.getByRole('button', { name: '取消自动任务' }).click();
    await expect.poll(() => cancelCalls).toBe(1);
    await expect(page.getByText('SKU 0000049 的自动上品任务已取消，上品资料已保留', { exact: true })).toBeVisible();
    await expect(detail.getByRole('button', { name: '取消自动任务' })).toBeDisabled();
    await detail.getByRole('button', { name: 'Close' }).click();
    await expect(detail).toBeHidden();

    await autoTable.locator('tbody tr').filter({ hasText: '0000062' }).getByRole('button', { name: '查看详情' }).click();
    detail = page.getByRole('dialog', { name: /自动上品详情/ });
    await expect(detail.getByRole('button', { name: '重新检测' })).toBeEnabled();
    const remoteCancel = detail.getByRole('button', { name: '取消自动任务' });
    await expect(remoteCancel).toBeDisabled();
    await detail.locator('.ozon-auto-job-action-tooltip').nth(2).hover();
    await expect(page.getByRole('tooltip')).toContainText('任务已进入 OZON 远程执行，不能取消');
    await detail.getByRole('button', { name: 'Close' }).click();

    await autoTable.locator('tbody tr').filter({ hasText: leasedJob.sku }).getByRole('button', { name: '查看详情' }).click();
    detail = page.getByRole('dialog', { name: /自动上品详情/ });
    const leasedCancel = detail.getByRole('button', { name: '取消自动任务' });
    await expect(leasedCancel).toBeDisabled();
    await detail.locator('.ozon-auto-job-action-tooltip').nth(2).hover();
    const leaseDisplay = await page.evaluate((value) => {
      const date = new Date(value);
      const pad = (part: number) => String(part).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }, leasedJob.leaseExpiresAt);
    await expect(page.getByRole('tooltip')).toContainText(`任务正在运行，lease 占用至 ${leaseDisplay}，释放后才能取消`);
  });

  test('publication 自动任务在 readback capability 关闭时禁用且不调用 recheck', async ({ page }) => {
    const publicationId = '11111111-1111-4111-8111-111111111119';
    const publicationJob = {
      ...waitingAutoJob,
      id: '11111111-1111-4111-8111-111111111118',
      publicationId,
      state: 'NEEDS_ATTENTION',
      importTaskId: 'remote-import-task-readback-disabled',
      rowVersion: 12
    };
    let publicationReads = 0;
    let publicationRecheckCalls = 0;
    let legacyRecheckCalls = 0;
    await page.route(/\/api\/v1\/ozon\/.*/, async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (path === '/api/v1/ozon/settings') return route.fulfill({ json: { settings: { ...multiStoreSettings, publicationReadbackEnabled: false } } });
      if (path === '/api/v1/ozon/system') return route.fulfill({ json: readyReadiness });
      if (path === '/api/v1/ozon/stores') return route.fulfill({ json: { items: [readyStoreA], total: 1 } });
      if (path === '/api/v1/ozon/automation/status') return route.fulfill({ json: { ...readyAutomationStatus, counts: { NEEDS_ATTENTION: 1 } } });
      if (path === '/api/v1/ozon/automation/jobs' && method === 'GET') return route.fulfill({ json: { items: [publicationJob], total: 1, page: 1, pageSize: 30 } });
      if (path === `/api/v1/ozon/automation/jobs/${publicationJob.id}` && method === 'GET') return route.fulfill({ json: { job: publicationJob } });
      if (path === `/api/v1/ozon/automation/jobs/${publicationJob.id}/recheck` && method === 'POST') {
        legacyRecheckCalls += 1;
        return route.fulfill({ status: 500, json: { error: { code: 'UNSAFE_LEGACY_CALL', message: '不应调用 legacy recheck' } } });
      }
      if (path === `/api/v1/ozon/publications/${publicationId}` && method === 'GET') {
        publicationReads += 1;
        return route.fulfill({ json: { publication: { id: publicationId, rowVersion: 9 } } });
      }
      if (path === `/api/v1/ozon/publications/${publicationId}/recheck` && method === 'POST') {
        publicationRecheckCalls += 1;
        return route.fulfill({ status: 500, json: { error: { code: 'UNEXPECTED_RECHECK', message: 'capability 关闭时不应调用' } } });
      }
      if (path === `/api/v1/ozon/listings/${publicationJob.sku}` && method === 'GET') return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: '尚未生成上品资料' } } });
      return route.fallback();
    });

    await page.goto('/listing/ozon');
    await page.locator('.ozon-console').first().locator('tbody tr').filter({ hasText: publicationJob.sku }).getByRole('button', { name: '查看详情' }).click();
    const detail = page.getByRole('dialog', { name: /自动上品详情/ });
    await expect(detail.getByRole('button', { name: '重新检测' })).toBeDisabled();
    await detail.locator('.ozon-auto-job-action-tooltip').nth(1).hover();
    await expect(page.getByRole('tooltip')).toContainText('等待受控 OZON 多店 fleet 部署');
    expect(publicationReads).toBe(0);
    expect(publicationRecheckCalls).toBe(0);
    expect(legacyRecheckCalls).toBe(0);
  });

  test('publication 自动任务先读取最新 rowVersion 且绝不调用 legacy 动作接口', async ({ page }) => {
    const publicationId = '22222222-2222-4222-8222-222222222222';
    const planHash = `sha256:${'d'.repeat(64)}`;
    const requestId = '44444444-4444-4444-8444-444444444444';
    const publicationJob = {
      ...waitingAutoJob,
      id: '33333333-3333-4333-8333-333333333333',
      publicationId,
      state: 'NEEDS_ATTENTION',
      lastErrorCode: 'OZON_RECHECK_REQUIRED',
      lastErrorMessage: '等待 publication 重新检查',
      rowVersion: 12
    };
    let publication = {
      id: publicationId,
      sku: publicationJob.sku,
      generatedVersionId: 'generated-publication-12',
      revision: 12,
      storeId: publicationJob.storeId,
      storeAliasSnapshot: publicationJob.storeAlias,
      storeDisplayNameSnapshot: 'OZON 主店',
      status: 'PAUSED',
      source: 'AUTOMATION',
      credentialBindingMode: 'VAULT',
      storeConfigVersion: 2,
      warehouseId: 'warehouse-main',
      warehouseName: '主店仓库',
      fulfillmentMode: 'FBS',
      accountCurrency: 'RUB',
      offerIds: [],
      offerContractHash: `sha256:${'a'.repeat(64)}`,
      materializationHash: `sha256:${'b'.repeat(64)}`,
      productIds: [],
      ozonSkus: [],
      productLinks: [],
      result: {},
      planHash,
      requestId,
      rowVersion: 41,
      createdAt: '2026-08-11T02:00:00.000Z',
      updatedAt: '2026-08-11T02:01:00.000Z'
    };
    const operationOrder: string[] = [];
    let legacyActionCalls = 0;
    await page.route(/\/api\/v1\/ozon\/.*/, async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (path === '/api/v1/ozon/settings') return route.fulfill({ json: { settings: { ...multiStoreSettings, publicationReadbackEnabled: true } } });
      if (path === '/api/v1/ozon/system') return route.fulfill({ json: readyReadiness });
      if (path === '/api/v1/ozon/stores') return route.fulfill({ json: { items: [readyStoreA], total: 1 } });
      if (path === '/api/v1/ozon/automation/status') return route.fulfill({ json: { ...readyAutomationStatus, counts: { NEEDS_ATTENTION: 1 } } });
      if (path === '/api/v1/ozon/automation/jobs' && method === 'GET') return route.fulfill({ json: { items: [publicationJob], total: 1, page: 1, pageSize: 30 } });
      if (path === `/api/v1/ozon/automation/jobs/${publicationJob.id}` && method === 'GET') return route.fulfill({ json: { job: publicationJob } });
      if (path === `/api/v1/ozon/automation/jobs/${publicationJob.id}/recheck` && method === 'POST') {
        legacyActionCalls += 1;
        return route.fulfill({ status: 500, json: { error: { code: 'UNSAFE_LEGACY_CALL', message: 'publication 任务不得调用 legacy recheck' } } });
      }
      if (path === `/api/v1/ozon/automation/jobs/${publicationJob.id}/cancel` && method === 'POST') {
        legacyActionCalls += 1;
        return route.fulfill({ status: 500, json: { error: { code: 'UNSAFE_LEGACY_CALL', message: 'publication 任务不得调用 legacy cancel' } } });
      }
      if (path === `/api/v1/ozon/publications/${publicationId}/task-detail` && method === 'GET') {
        operationOrder.push(`GET-TASK:${publication.rowVersion}`);
        return route.fulfill({ json: {
          publication,
          job: publicationJob,
          events: [],
          frozenContract: { planHash, requestId },
          readback: { required: false, canRecheck: true, gatewayRequestCount: 0, deliveryStates: [] },
          recovery: { canRecheck: true, canManualTakeover: false, recoveryMode: 'READBACK_REQUIRED' }
        } });
      }
      if (path === `/api/v1/ozon/publications/${publicationId}` && method === 'GET') {
        operationOrder.push(`GET-PUBLICATION:${publication.rowVersion}`);
        return route.fulfill({ json: { publication } });
      }
      if (path === `/api/v1/ozon/publications/${publicationId}/recheck` && method === 'POST') {
        operationOrder.push('POST:recheck');
        expect(route.request().postDataJSON()).toEqual({ rowVersion: publication.rowVersion, planHash, requestId });
        publication = { ...publication, rowVersion: publication.rowVersion + 1, updatedAt: '2026-08-11T02:02:00.000Z' };
        return route.fulfill({ json: { publication } });
      }
      if (path === `/api/v1/ozon/publications/${publicationId}/cancel` && method === 'POST') {
        operationOrder.push('POST:cancel');
        expect(route.request().postDataJSON()).toEqual({ rowVersion: publication.rowVersion });
        publication = { ...publication, status: 'CANCELLED', rowVersion: publication.rowVersion + 1, updatedAt: '2026-08-11T02:03:00.000Z' };
        return route.fulfill({ json: { publication } });
      }
      if (path === `/api/v1/ozon/listings/${publicationJob.sku}` && method === 'GET') return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: '尚未生成上品资料' } } });
      return route.fallback();
    });

    await page.goto('/listing/ozon');
    await page.locator('.ozon-console').first().locator('tbody tr').filter({ hasText: publicationJob.sku }).getByRole('button', { name: '查看详情' }).click();
    const detail = page.getByRole('dialog', { name: /自动上品详情/ });

    await detail.getByRole('button', { name: '重新检测' }).click();
    await expect.poll(() => operationOrder).toEqual(['GET-TASK:41', 'POST:recheck']);
    await expect(page.getByText(`SKU ${publicationJob.sku} 的店铺 publication 已提交重新检查`, { exact: true })).toBeVisible();

    await detail.getByRole('button', { name: '取消自动任务' }).click();
    const confirm = page.locator('.ant-modal-confirm').filter({ hasText: `取消 SKU ${publicationJob.sku} 的自动上品任务？` });
    await confirm.getByRole('button', { name: '取消自动任务' }).click();
    await expect.poll(() => operationOrder).toEqual(['GET-TASK:41', 'POST:recheck', 'GET-PUBLICATION:42', 'POST:cancel']);
    await expect(page.getByText(`SKU ${publicationJob.sku} 的店铺 publication 已取消，上品资料已保留`, { exact: true })).toBeVisible();
    expect(legacyActionCalls).toBe(0);
  });

  test('详情读取失败使用列表快照重试，共享草稿 404 或 500 不阻止读取独立冻结资料', async ({ page }) => {
    let detailReads = 0;
    let listingReads = 0;
    let listingStatus = 404;
    await page.route(/\/api\/v1\/ozon\/.*/, async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (path === '/api/v1/ozon/system') return route.fulfill({ json: readyReadiness });
      if (path === '/api/v1/ozon/automation/status') return route.fulfill({ json: readyAutomationStatus });
      if (path === '/api/v1/ozon/automation/jobs' && method === 'GET') return route.fulfill({ json: { items: [waitingAutoJob], total: 1, page: 1, pageSize: 30 } });
      if (path === `/api/v1/ozon/automation/jobs/${waitingAutoJob.id}` && method === 'GET') {
        detailReads += 1;
        if (detailReads === 1) return route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE', message: '详情服务暂不可用' } } });
        return route.fulfill({ json: { job: waitingAutoJob } });
      }
      if (path === '/api/v1/ozon/listings' && method === 'GET') return route.fulfill({ json: { items: [editableListing], total: 1, page: 1, pageSize: 100 } });
      if (path === '/api/v1/ozon/listings/0000049' && method === 'GET') {
        listingReads += 1;
        return route.fulfill({ status: listingStatus, json: { error: { code: listingStatus === 404 ? 'NOT_FOUND' : 'SERVICE_UNAVAILABLE', message: listingStatus === 404 ? '尚未生成上品资料' : '资料服务暂不可用' } } });
      }
      return route.fallback();
    });

    await page.goto('/listing/ozon');
    const row = page.locator('.ozon-console').first().locator('tbody tr').filter({ hasText: '0000049' });
    await row.getByRole('button', { name: '查看详情' }).click();
    let detail = page.getByRole('dialog', { name: /自动上品详情/ });
    const fallback = detail.locator('.ozon-auto-job-fallback');
    await expect(fallback.getByText('正在显示列表快照', { exact: true })).toBeVisible();
    const openListing = detail.getByRole('button', { name: '打开上品资料' });
    await expect(openListing).toBeEnabled();
    await fallback.getByRole('button', { name: /重\s*试/ }).click();
    await expect.poll(() => detailReads).toBe(2);
    await expect(fallback).toHaveCount(0);
    await detail.getByRole('button', { name: 'Close' }).click();
    await expect(detail).toBeHidden();

    listingStatus = 500;
    await row.getByRole('button', { name: '查看详情' }).click();
    detail = page.getByRole('dialog', { name: /自动上品详情/ });
    await expect.poll(() => listingReads).toBeGreaterThan(1);
    const unavailableListing = detail.getByRole('button', { name: '打开上品资料' });
    await expect(unavailableListing).toBeEnabled();
    await detail.getByRole('button', { name: 'Close' }).click();
    await expect(detail).toBeHidden();

    await page.getByRole('tab', { name: /手动上品资料/ }).click();
    await page.getByRole('button', { name: '打开工作台' }).click();
    const editor = page.getByRole('dialog', { name: '加载 OZON 上品资料' });
    await expect(editor.getByText('OZON 上品资料加载失败', { exact: true })).toBeVisible();
    await expect(editor.getByRole('button', { name: /重\s*试/ })).toBeVisible();
    await expect(editor.locator('.ant-skeleton')).toHaveCount(0);
  });

  test('自动任务可按采购记录新建日期快捷或自定义查询', async ({ page }) => {
    await page.goto('/listing/ozon');
    const filter = page.locator('.ozon-filter').first();
    const datePreset = filter.locator('.ozon-purchase-date-preset');
    await expect(datePreset).toContainText('全部采购新建日期');

    const todayRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === '/api/v1/ozon/automation/jobs' && url.searchParams.has('purchaseCreatedFrom');
    });
    await datePreset.click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '当天' }).click();
    const todayParams = new URL((await todayRequest).url()).searchParams;
    expect(Date.parse(todayParams.get('purchaseCreatedTo')!) - Date.parse(todayParams.get('purchaseCreatedFrom')!)).toBe(24 * 60 * 60 * 1000);

    await datePreset.click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '时间段查询' }).click();
    const startDate = filter.getByPlaceholder('开始日期');
    const endDate = filter.getByPlaceholder('结束日期');
    await startDate.fill('2026-07-20');
    await endDate.fill('2026-07-23');
    const customRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === '/api/v1/ozon/automation/jobs'
        && url.searchParams.get('purchaseCreatedFrom') === '2026-07-19T16:00:00.000Z'
        && url.searchParams.get('purchaseCreatedTo') === '2026-07-23T16:00:00.000Z';
    });
    await endDate.press('Enter');
    await customRequest;

    await page.getByRole('tab', { name: /手动上品资料/ }).click();
    const manualFilter = page.locator('.ozon-manual-filter');
    const manualDatePreset = manualFilter.locator('.ozon-purchase-date-preset');
    await expect(manualDatePreset).toContainText('全部采购新建日期');
    const last7DaysRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === '/api/v1/ozon/listings' && url.searchParams.has('purchaseCreatedFrom');
    });
    await manualDatePreset.click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '近 7 天' }).click();
    const last7DaysParams = new URL((await last7DaysRequest).url()).searchParams;
    expect(Date.parse(last7DaysParams.get('purchaseCreatedTo')!) - Date.parse(last7DaysParams.get('purchaseCreatedFrom')!)).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test('自动和手动列表复制 0000049 时保留前导零且不触发行操作', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:4183' });
    await page.route(/\/api\/v1\/ozon\/.*/, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/v1/ozon/automation/jobs') {
        return route.fulfill({ json: { items: [waitingAutoJob], total: 1, page: 1, pageSize: 30 } });
      }
      if (path === '/api/v1/ozon/listings') {
        return route.fulfill({ json: { items: [editableListing], total: 1, page: 1, pageSize: 100 } });
      }
      return route.fallback();
    });

    await page.goto('/listing/ozon');
    const autoTable = page.locator('.ozon-console').first();
    const autoSkuCopy = autoTable.getByRole('button', { name: /SKU.*0000049/ });
    await autoSkuCopy.click();
    await expect(autoSkuCopy).toHaveClass(/is-copied/);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('0000049');
    await expect(page.getByRole('dialog', { name: /自动上品详情/ })).toHaveCount(0);

    await page.getByRole('tab', { name: /手动上品资料/ }).click();
    const manualTable = page.locator('.ozon-console').first();
    const manualSkuCopy = manualTable.getByRole('button', { name: /SKU.*0000049/ });
    await manualSkuCopy.click();
    await expect(manualSkuCopy).toHaveClass(/is-copied/);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('0000049');
    await expect(page.getByRole('dialog', { name: /0000049/ })).toHaveCount(0);

    await page.setViewportSize({ width: 320, height: 720 });
    await expect(manualSkuCopy).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('自动和手动记录支持复制 SKU、显示全部商品链接且新变体使用两位编码', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:4183' });
    await page.route(/\/api\/v1\/ozon\/categories$/, (route) => route.fulfill({ json: { items: [presetCategory] } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000051$/, (route) => route.fulfill({ json: { listing: {
      ...publishedListing,
      data: {
        categoryKey: 'ozon_17001_97001',
        categoryVersionId: presetCategory.publishedVersion.id,
        fulfillmentMode: 'FBS', warehouseId: '', currency: 'RUB', vat: '0.2', titleRu: '', descriptionRu: '', brand: '',
        dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 800, weightUnit: 'g' },
        sharedAttributes: [], offers: [], mediaSourceRoot: ''
      }
    } } }));
    await page.goto('/listing/ozon');
    const autoTable = page.locator('.ozon-console').first();
    const operationHeader = autoTable.locator('thead th').nth(-2);
    const productLinksHeader = autoTable.locator('thead th').last();
    await expect(operationHeader).toContainText('操作');
    await expect(operationHeader).toHaveClass(/ant-table-cell-fix-right-first/);
    await expect(productLinksHeader).toContainText('OZON 商品链接');
    await expect(productLinksHeader).toHaveClass(/ant-table-cell-fix-right/);
    await expect(autoTable.locator('thead')).not.toContainText('来源');
    await expect(autoTable.getByText('共 2 个变体')).toBeVisible();
    const firstProductLink = autoTable.getByRole('link', { name: `打开 OZON 商品 ${productOzonSku}` });
    await expect(firstProductLink).toHaveAttribute('href', productUrl);
    await expect(autoTable.getByRole('link', { name: `打开 OZON 商品 ${secondProductOzonSku}` })).toHaveAttribute('href', secondProductUrl);
    expect(await autoTable.locator('.ozon-product-links a').allTextContents()).toEqual(['0000051-01', '0000051-02']);
    const autoRow = autoTable.locator('tbody tr').filter({ hasText: '0000051' }).first();
    await expect(autoRow.locator('td').nth(-2)).toHaveClass(/ant-table-cell-fix-right-first/);
    await expect(autoRow.locator('td').last()).toHaveClass(/ant-table-cell-fix-right/);
    await firstProductLink.evaluate((element) => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      event.preventDefault();
      element.dispatchEvent(event);
    });
    await expect(page.getByRole('dialog', { name: /自动上品详情/ })).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 720 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 720 });
    const autoSkuCopy = autoTable.getByRole('button', { name: /SKU.*0000051/ });
    await autoSkuCopy.hover();
    await expect(page.getByRole('tooltip')).toHaveText('复制SKU');
    await autoSkuCopy.click();
    await expect(autoSkuCopy).toHaveClass(/is-copied/);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('0000051');
    await expect(page.getByRole('dialog', { name: /自动上品详情/ })).toHaveCount(0);

    await page.getByRole('tab', { name: /手动上品资料/ }).click();
    const manualTable = page.locator('.ozon-console').first();
    await expect(manualTable.getByRole('columnheader')).toHaveText([
      '店铺', 'SKU', '修订 / 方式', '上品状态', '绑定预设', '当前说明', '更新时间', '操作', 'OZON 商品链接'
    ]);
    await expect(manualTable.getByText('共 2 个变体')).toBeVisible();
    await expect(manualTable.getByRole('link', { name: `打开 OZON 商品 ${productOzonSku}` })).toHaveAttribute('href', productUrl);
    await expect(manualTable.getByRole('link', { name: `打开 OZON 商品 ${secondProductOzonSku}` })).toHaveAttribute('href', secondProductUrl);
    expect(await manualTable.locator('.ozon-product-links a').allTextContents()).toEqual(['0000051-01', '0000051-02']);
    await expect(manualTable.locator('thead th').nth(-2)).toHaveClass(/ant-table-cell-fix-right-first/);
    await expect(manualTable.locator('thead th').last()).toHaveClass(/ant-table-cell-fix-right/);
    const manualSkuCopy = manualTable.getByRole('button', { name: /SKU.*0000051/ });
    await manualSkuCopy.click();
    await expect(manualSkuCopy).toHaveClass(/is-copied/);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('0000051');
    await manualTable.getByRole('button', { name: '打开工作台' }).click();
    const drawer = page.getByRole('dialog', { name: /0000051/ });
    const editorCardTitles = drawer.locator('.ozon-editor-main .ant-card-head-title');
    await expect(editorCardTitles.filter({ hasText: '公共素材' })).toBeVisible();
    await expect(editorCardTitles.filter({ hasText: '产品变体与媒体' })).toBeVisible();
    await expect(editorCardTitles.filter({ hasText: 'OZON 类目字段' })).toHaveCount(0);
    await expect(drawer.getByText('上品就绪度', { exact: true })).toHaveCount(0);
    await expect(drawer.getByText('材质', { exact: true })).toHaveCount(0);
    await expect(drawer.getByText('Материал', { exact: true })).toHaveCount(0);
    await drawer.getByRole('button', { name: '添加变体' }).click();
    await expect(drawer.getByLabel('产品变体名称').last()).toBeVisible();
    await expect(drawer.getByLabel('稳定变体编码')).toHaveCount(0);
    await expect(drawer.getByLabel('offer_id')).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  // 以下迁移前 SKU 草稿断言已由后续“逐店生成并冻结发布快照”场景取代；
  // 公共素材工作台不再编辑类目、价格、库存等平台字段。
  test.skip('手动资料只读显示采购尺寸净重，并保持 #23249 为普通类目字段', async ({ page }) => {
    const purchaseCategory = structuredClone(presetCategory);
    purchaseCategory.publishedVersion.snapshot.attributes.push(
      { id: 5299, name: 'Высота, см', nameRu: 'Высота, см', nameZh: '物体高度，厘米', description: '', type: 'Decimal', required: false, dictionaryId: 0, maxCount: 1, groupId: 0, groupName: '', complexId: 0, isCollection: false },
      { id: 6573, name: 'Глубина, см', nameRu: 'Глубина, см', nameZh: '物体深度，厘米', description: '', type: 'Decimal', required: false, dictionaryId: 0, maxCount: 1, groupId: 0, groupName: '', complexId: 0, isCollection: false },
      { id: 5355, name: 'Ширина, см', nameRu: 'Ширина, см', nameZh: '物体宽度，厘米', description: '', type: 'Decimal', required: false, dictionaryId: 0, maxCount: 1, groupId: 0, groupName: '', complexId: 0, isCollection: false },
      { id: 4383, name: 'Вес товара, г', nameRu: 'Вес товара, г', nameZh: '商品重量，克', description: '', type: 'Decimal', required: false, dictionaryId: 0, maxCount: 1, groupId: 0, groupName: '', complexId: 0, isCollection: false },
      { id: 23249, name: 'Количество товара в УЕИ', nameRu: 'Количество товара в УЕИ', nameZh: '统一计量单位中的商品数量', description: '', type: 'Integer', required: false, dictionaryId: 0, maxCount: 1, groupId: 0, groupName: '', complexId: 0, isCollection: false }
    );
    const purchaseMeasurements = {
      procurementVersionId: '77777777-7777-4777-8777-777777777777',
      procurementVersionNo: 7,
      capturedAt: '2026-08-05T02:30:00.000Z',
      productHeightCm: '30',
      productDepthCm: null,
      productWidthCm: '39.5',
      netWeightGrams: '550'
    };
    const purchaseMeasurementProjection = {
      source: 'LATEST_PURCHASE',
      snapshot: purchaseMeasurements,
      fields: [
        { attributeId: 5299, purchaseField: 'productHeightCm', labelZh: '物体高度，厘米', labelRu: 'Высота, см', unit: 'cm', value: '30', required: false, applicable: true, status: 'AVAILABLE' },
        { attributeId: 6573, purchaseField: 'productDepthCm', labelZh: '物体深度，厘米', labelRu: 'Глубина, см', unit: 'cm', value: null, required: false, applicable: true, status: 'OPTIONAL_MISSING' },
        { attributeId: 5355, purchaseField: 'productWidthCm', labelZh: '物体宽度，厘米', labelRu: 'Ширина, см', unit: 'cm', value: '39.5', required: false, applicable: true, status: 'AVAILABLE' },
        { attributeId: 4383, purchaseField: 'netWeightGrams', labelZh: '商品重量，克', labelRu: 'Вес товара, г', unit: 'g', value: '550', required: false, applicable: true, status: 'AVAILABLE' }
      ],
      issues: []
    };
    let savedBody: any;
    const listing = {
      ...editableListing,
      status: 'DRAFT',
      rowVersion: 9,
      revision: 8,
      data: {
        ...editableListing.data,
        sharedAttributes: [
          { attributeId: 10, complexId: 0, values: [{ value: 'Нейлон' }] },
          { attributeId: 5299, complexId: 0, values: [{ value: '30' }] },
          { attributeId: 5355, complexId: 0, values: [{ value: '39.5' }] },
          { attributeId: 4383, complexId: 0, values: [{ value: '550' }] },
          { attributeId: 23249, complexId: 0, values: [{ value: '6' }] }
        ]
      }
    };

    await page.route(/\/api\/v1\/ozon\/system$/, (route) => route.fulfill({ json: readyReadiness }));
    await page.route(/\/api\/v1\/ozon\/categories$/, (route) => route.fulfill({ json: { items: [purchaseCategory] } }));
    await page.route(/\/api\/v1\/ozon\/listings(?:\?.*)?$/, (route) => route.fulfill({
      json: { items: [listing], total: 1, page: 1, pageSize: 100 }
    }));
    await page.route(/\/api\/v1\/purchases\/0000049$/, (route) => route.fulfill({ json: { purchase: {
      sku: '0000049',
      productName: listing.productName,
      variants: [],
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-05T02:30:00.000Z',
      procurementVersions: [{
        id: purchaseMeasurements.procurementVersionId,
        versionNo: purchaseMeasurements.procurementVersionNo,
        purchasePrice: '31',
        courierFee: '0',
        currency: 'CNY',
        productHeightCm: '30.000',
        productDepthCm: null,
        productWidthCm: '39.500',
        netWeightGrams: '550.000',
        providerUrl: 'https://example.com/0000049',
        createdAt: purchaseMeasurements.capturedAt
      }],
      downloadJobs: []
    } } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000049$/, async (route) => {
      if (route.request().method() === 'PUT') {
        savedBody = route.request().postDataJSON();
        const data = { ...savedBody };
        delete data.rowVersion;
        return route.fulfill({ json: { listing: { ...listing, rowVersion: 10, revision: 9, data } } });
      }
      return route.fulfill({ json: { listing, purchaseMeasurementProjection, canManualTakeover: false } });
    });
    await page.route(/\/api\/v1\/ozon\/listings\/0000049\/jobs$/, (route) => route.fulfill({
      json: { items: [], total: 0, page: 1, pageSize: 100 }
    }));
    await routeNoPublicationTaskSummaries(page);

    await page.goto('/listing/ozon?view=manual');
    await page.getByRole('button', { name: '打开工作台' }).click();
    const drawer = page.getByRole('dialog', { name: /0000049/ });
    const managed = drawer.locator('.ozon-purchase-managed-workbench');
    await expect(managed.getByText('采购管理自动取值', { exact: true })).toBeVisible();
    await expect(managed).toContainText('物体高度，厘米');
    await expect(managed).toContainText('Высота, см');
    await expect(managed).toContainText('#5299');
    await expect(managed).toContainText('30 cm · 采购 V7');
    await expect(managed).toContainText('物体深度，厘米');
    await expect(managed).toContainText('Глубина, см');
    await expect(managed).toContainText('#6573');
    await expect(managed).toContainText('物体宽度，厘米');
    await expect(managed).toContainText('Ширина, см');
    await expect(managed).toContainText('#5355');
    await expect(managed).toContainText('39.5 cm · 采购 V7');
    await expect(managed).toContainText('商品重量，克');
    await expect(managed).toContainText('Вес товара, г');
    await expect(managed).toContainText('#4383');
    await expect(managed).toContainText('550 g · 采购 V7');
    await expect(managed.getByText(/采购信息未填写，本次不上传 · 采购 V7/)).toHaveCount(1);
    await expect(managed.locator('input, textarea, [role="spinbutton"], [role="combobox"]')).toHaveCount(0);
    for (const attributeId of [5299, 6573, 5355, 4383]) {
      await expect(drawer.locator('.ant-form-item').filter({ hasText: `#${attributeId}` })).toHaveCount(0);
    }
    await expect(managed.getByRole('link', { name: '前往产品URL下载' })).toHaveAttribute('href', '/purchases/url-download?query=0000049');

    await drawer.getByRole('button', { name: '显示所有' }).click();
    const quantityField = drawer.locator('.ant-form-item').filter({ hasText: '统一计量单位中的商品数量' }).first();
    await expect(quantityField).toContainText('Количество товара в УЕИ');
    await expect(quantityField).toContainText('#23249');
    const quantityInput = quantityField.getByRole('textbox');
    await expect(quantityInput).toHaveValue('6');
    await quantityInput.fill('8');
    await drawer.getByRole('button', { name: '保存草稿' }).click();
    await expect.poll(() => savedBody).toBeTruthy();
    expect(savedBody.sharedAttributes).toEqual(expect.arrayContaining([
      { attributeId: 23249, complexId: 0, values: [{ value: '8' }] }
    ]));

    await page.setViewportSize({ width: 320, height: 900 });
    await expect(managed).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test.skip('采购毛重联动草稿锁定克数与单位，保留尺寸编辑和服务端审计', async ({ page }) => {
    const grossWeightResolution = {
      source: 'PROCUREMENT',
      effectiveGrossWeightGrams: 650.5,
      procurementGrossWeightGrams: 650.5,
      presetGrossWeightGrams: 800,
      procurementVersionId: '77777777-7777-4777-8777-777777777777',
      procurementVersionNo: 7,
      procurementCapturedAt: '2026-08-07T02:30:00.000Z'
    };
    const managedListing = {
      ...editableListing,
      status: 'READY',
      rowVersion: 9,
      revision: 8,
      data: {
        ...editableListing.data,
        dimensions: { ...editableListing.data.dimensions, weight: 650.5, weightUnit: 'g' },
        sharedAttributes: [{ attributeId: 10, complexId: 0, values: [{ value: 'Нейлон' }] }],
        initialization: {
          status: 'COMPLETE', initializedAt: '2026-08-07T02:30:00.000Z', issues: [], grossWeightResolution
        }
      }
    };
    let savedBody: any;
    await page.route(/\/api\/v1\/ozon\/system$/, (route) => route.fulfill({ json: readyReadiness }));
    await page.route(/\/api\/v1\/ozon\/categories$/, (route) => route.fulfill({ json: { items: [presetCategory] } }));
    await page.route(/\/api\/v1\/ozon\/listings(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [managedListing], total: 1, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000049$/, async (route) => {
      if (route.request().method() === 'PUT') {
        savedBody = route.request().postDataJSON();
        const data = { ...savedBody };
        delete data.rowVersion;
        return route.fulfill({ json: { listing: { ...managedListing, rowVersion: 10, revision: 9, data } } });
      }
      return route.fulfill({ json: { listing: managedListing, canManualTakeover: false } });
    });
    await page.route(/\/api\/v1\/ozon\/listings\/0000049\/jobs(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000049\/media\/scan$/, (route) => route.fulfill({ json: { changed: false, listing: managedListing, mediaAssets: [], mediaDirectory: '', removedReferences: 0 } }));

    await page.goto('/listing/ozon?view=manual');
    await page.getByRole('button', { name: '打开工作台' }).click();
    const drawer = page.getByRole('dialog', { name: /0000049/ });
    const weight = drawer.getByRole('spinbutton', { name: '毛重 (g)' });
    const weightUnit = drawer.getByRole('combobox', { name: '重量单位' });
    await expect(weight).toHaveValue('650.5');
    await expect(weight).toHaveAttribute('readonly');
    await expect(drawer.getByText('采购 V7', { exact: true })).toBeVisible();
    await expect(weightUnit).toBeDisabled();
    await expect(drawer.getByRole('spinbutton', { name: '长' })).toBeEditable();
    await expect(drawer.getByRole('combobox', { name: '尺寸单位' })).toBeEnabled();
    await drawer.getByRole('spinbutton', { name: '长' }).fill('31');
    await drawer.getByRole('button', { name: '保存草稿' }).click();

    await expect.poll(() => savedBody).toBeTruthy();
    expect(savedBody.initialization).toEqual(managedListing.data.initialization);
    expect(savedBody.dimensions).toEqual({ length: 31, width: 20, height: 10, dimensionUnit: 'cm', weight: 650.5, weightUnit: 'g' });
  });

  test.skip('预设兜底草稿显示兜底来源，历史草稿保持毛重与单位可编辑', async ({ page }) => {
    const fallbackListing = {
      ...editableListing,
      status: 'READY',
      data: {
        ...editableListing.data,
        initialization: {
          status: 'COMPLETE', initializedAt: '2026-08-07T02:30:00.000Z', issues: [],
          grossWeightResolution: {
            source: 'PRESET_FALLBACK', effectiveGrossWeightGrams: 800, procurementGrossWeightGrams: null, presetGrossWeightGrams: 800,
            procurementVersionId: '77777777-7777-4777-8777-777777777777', procurementVersionNo: 7, procurementCapturedAt: '2026-08-07T02:30:00.000Z'
          }
        }
      }
    };
    const legacyListing = {
      ...editableListing,
      sku: '0000052',
      productName: '历史未联动商品',
      status: 'READY',
      data: {
        ...editableListing.data,
        dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 2, weightUnit: 'lb' }
      }
    };
    const listingsBySku: Record<string, any> = { '0000049': fallbackListing, '0000052': legacyListing };
    await page.route(/\/api\/v1\/ozon\/system$/, (route) => route.fulfill({ json: readyReadiness }));
    await page.route(/\/api\/v1\/ozon\/categories$/, (route) => route.fulfill({ json: { items: [presetCategory] } }));
    await page.route(/\/api\/v1\/ozon\/listings(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [fallbackListing, legacyListing], total: 2, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/ozon\/listings\/(0000049|0000052)$/, (route) => {
      const listing = listingsBySku[new URL(route.request().url()).pathname.split('/').at(-1)!];
      return route.fulfill({ json: { listing, canManualTakeover: false } });
    });
    await page.route(/\/api\/v1\/ozon\/listings\/(0000049|0000052)\/jobs(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/ozon\/listings\/(0000049|0000052)\/media\/scan$/, (route) => {
      const sku = new URL(route.request().url()).pathname.split('/').at(-3)!;
      return route.fulfill({ json: { changed: false, listing: listingsBySku[sku], mediaAssets: [], mediaDirectory: '', removedReferences: 0 } });
    });

    await page.goto('/listing/ozon?view=manual');
    const table = page.locator('.ozon-console').first();
    await table.locator('tbody tr').filter({ hasText: '0000049' }).getByRole('button', { name: '打开工作台' }).click();
    let drawer = page.getByRole('dialog', { name: /0000049/ });
    await expect(drawer.getByText('预设兜底', { exact: true })).toBeVisible();
    await expect(drawer.getByRole('spinbutton', { name: '毛重 (g)' })).toHaveAttribute('readonly');
    await expect(drawer.getByRole('combobox', { name: '重量单位' })).toBeDisabled();
    await drawer.locator('.ant-drawer-close').click();

    await table.locator('tbody tr').filter({ hasText: '0000052' }).getByRole('button', { name: '打开工作台' }).click();
    drawer = page.getByRole('dialog', { name: /0000052/ });
    await expect(drawer.getByText('历史未联动：毛重仍可手动编辑', { exact: true })).toBeVisible();
    await expect(drawer.getByRole('spinbutton', { name: '毛重' })).toBeEditable();
    await expect(drawer.getByRole('spinbutton', { name: '毛重' })).toHaveValue('2');
    await expect(drawer.getByRole('combobox', { name: '重量单位' })).toBeEnabled();
  });

  test('手动资料可导入 UTF-8 TXT 覆盖俄文商品详情并保存', async ({ page }) => {
    let currentListing: any = {
      ...withReadyPublicMaterial(editableListing),
      status: 'DRAFT',
      rowVersion: 7,
      data: {
        ...withReadyPublicMaterial(editableListing).data,
        descriptionRu: 'Старое описание',
        sharedAttributes: [{ attributeId: 10, complexId: 0, values: [{ value: 'Кожа' }] }]
      }
    };
    let savedBody: any;
    await page.route(/\/api\/v1\/ozon\/system$/, (route) => route.fulfill({ json: readyReadiness }));
    await page.route(/\/api\/v1\/ozon\/categories$/, (route) => route.fulfill({ json: { items: [presetCategory] } }));
    await page.route(/\/api\/v1\/ozon\/listings(?:\?.*)?$/, (route) => route.fulfill({
      json: { items: [currentListing], total: 1, page: 1, pageSize: 100 }
    }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000049$/, async (route) => {
      return route.fulfill({ json: { listing: currentListing, canManualTakeover: false } });
    });
    await page.route(/\/api\/v1\/ozon\/listings\/0000049\/shared-material$/, (route) => {
      savedBody = route.request().postDataJSON();
      currentListing = {
        ...currentListing,
        rowVersion: currentListing.rowVersion + 1,
        revision: currentListing.revision + 1,
        data: {
          ...currentListing.data,
          descriptionRu: savedBody.descriptionRu,
          descriptionSource: savedBody.descriptionSource,
          offers: savedBody.variants.map((variant: any, index: number) => ({ ...currentListing.data.offers[index], ...variant }))
        }
      };
      return route.fulfill({ json: {
        listing: currentListing,
        generatedVersionId: `e2e-material-${currentListing.sku}`,
        materialRevision: currentListing.revision,
        materialHash: `sha256:${'b'.repeat(64)}`,
        contentPolicyVersion: 'merchroute-ozon-content-v3'
      } });
    });
    await page.route(/\/api\/v1\/ozon\/listings\/0000049\/jobs$/, (route) => route.fulfill({
      json: { items: [], total: 0, page: 1, pageSize: 100 }
    }));

    await routeNoPublicationTaskSummaries(page);
    await openExistingPublicMaterial(page, currentListing);
    let drawer = page.getByRole('dialog', { name: /0000049/ });
    let description = drawer.getByRole('textbox', { name: /^共享俄文商品详情/ });
    const fileInput = drawer.locator('input[type="file"][accept=".txt,text/plain"]');

    await fileInput.setInputFiles({
      name: '俄文详情.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('\uFEFFПервый абзац\r\n\r\nВторой абзац', 'utf8')
    });
    await expect(page.getByText('已导入 俄文详情.txt，保存草稿后生效')).toBeVisible();
    await expect(description).toHaveValue('Первый абзац\n\nВторой абзац');

    await fileInput.setInputFiles({
      name: '俄文详情.md',
      mimeType: 'text/plain',
      buffer: Buffer.from('Нельзя заменять', 'utf8')
    });
    await expect(page.getByText('只允许导入 .txt 文件')).toBeVisible();
    await expect(description).toHaveValue('Первый абзац\n\nВторой абзац');

    await fileInput.setInputFiles({
      name: '俄文详情.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Обновленный текст', 'utf8')
    });
    await expect(description).toHaveValue('Обновленный текст');

    await drawer.getByRole('button', { name: '保存公共素材' }).click();
    await expect.poll(() => savedBody?.descriptionRu).toBe('Обновленный текст');
    await drawer.getByRole('button', { name: 'Close' }).click();
    await openExistingPublicMaterial(page, currentListing, false);
    drawer = page.getByRole('dialog', { name: /0000049/ });
    description = drawer.getByRole('textbox', { name: /^共享俄文商品详情/ });
    await expect(description).toHaveValue('Обновленный текст');

    await page.setViewportSize({ width: 320, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    currentListing = { ...currentListing, status: 'SUBMITTING' };
    await drawer.getByRole('button', { name: 'Close' }).click();
    await page.reload();
    await openExistingPublicMaterial(page, currentListing, false);
    drawer = page.getByRole('dialog', { name: /0000049/ });
    await expect(drawer.getByRole('button', { name: '导入 UTF-8 TXT' })).toBeDisabled();
  });

  test('自动清单只显示 AUTO，MANUAL 历史留在 SKU 工作台并支持键盘查看', async ({ page }) => {
    const manualJob = {
      ...waitingAutoJob,
      id: '55555555-5555-4555-8555-555555555555',
      source: 'MANUAL',
      state: 'SUCCEEDED',
      offerIds: ['0000049-01', '0000049-02'],
      ozonProductLinks: [{ offerId: '0000049-01', ozonProductId: '5686268840', ozonSku: '5260178092', url: 'https://www.ozon.ru/product/5260178092/' }],
      updatedAt: '2026-07-28T10:15:00.000Z'
    };
    await page.route(/\/api\/v1\/ozon\/.*/, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/v1/ozon/automation/jobs') return route.fulfill({ json: { items: [successfulJob, manualJob], total: 2, page: 1, pageSize: 30 } });
      if (path === '/api/v1/ozon/listings') return route.fulfill({ json: { items: [editableListing], total: 1, page: 1, pageSize: 100 } });
      if (path === '/api/v1/ozon/listings/0000049') return route.fulfill({ json: { listing: editableListing, canManualTakeover: false } });
      if (path === '/api/v1/ozon/listings/0000049/jobs') return route.fulfill({ json: { items: [manualJob, successfulJob], total: 1, page: 1, pageSize: 100 } });
      if (path === `/api/v1/ozon/listings/0000049/jobs/${manualJob.id}`) return route.fulfill({ json: { job: manualJob } });
      return route.fallback();
    });

    await page.goto('/listing/ozon');
    const autoTable = page.locator('.ozon-console').first();
    await expect(autoTable.getByText('0000051', { exact: true })).toBeVisible();
    await expect(autoTable.getByText('0000049', { exact: true })).toHaveCount(0);
    await expect(autoTable.getByText('共 1 个任务', { exact: true })).toBeVisible();
    await expect(autoTable.locator('thead')).not.toContainText('来源');

    await page.getByRole('tab', { name: /手动上品资料/ }).click();
    await page.getByRole('button', { name: '打开工作台' }).click();
    const workspace = page.getByRole('dialog', { name: /0000049/ });
    const history = workspace.getByLabel('0000049 手动任务历史');
    await expect(history.getByText(manualJob.id)).toBeVisible();
    await expect(history.getByText(successfulJob.id)).toHaveCount(0);
    await expect(history.getByText('链接未同步')).toBeVisible();
    await history.getByRole('button', { name: `打开手动任务详情 ${manualJob.id}` }).press('Enter');
    await expect(page.getByRole('dialog', { name: '手动任务详情 · 0000049' })).toContainText(manualJob.id);
    await expect(page).toHaveURL(/view=manual/);
    expect(page.url()).not.toContain('job=');
  });

  test('已进入 OZON 的手动任务只恢复原 importTaskId，并展示逐变体库存进度', async ({ page }) => {
    const jobId = 'f7fbf031-bd04-4ce5-8e8b-67c81e1ded9f';
    const offerIds = ['0000062-01', '0000062-02', '0000062-03'];
    const manualJob = {
      ...waitingAutoJob,
      id: jobId,
      sku: '0000062',
      source: 'MANUAL',
      credentialBindingMode: 'PURE_LEGACY',
      state: 'NEEDS_ATTENTION',
      rowVersion: 7,
      revision: 5,
      importTaskId: '5280256601',
      offerIds,
      taskFolder: '0000062__r5',
      workRelPath: 'processing/0000062__r5',
      directoryStage: 'PROCESSING',
      lastErrorCode: 'OZON_PRICE_STOCK_WRITE_FAILED',
      lastErrorMessage: 'TOO_MANY_REQUESTS Stock is updated too frequently'
    };
    const listing = {
      ...editableListing,
      sku: '0000062',
      status: 'NEEDS_ATTENTION',
      data: {
        ...editableListing.data,
        offers: offerIds.map((offerId, index) => ({ variantId: `variant-${index + 1}`, variantCode: String(index + 1).padStart(2, '0'), offerId, stock: 1, media: [], attributes: [] }))
      }
    };
    const recovery = {
      action: 'RECHECK',
      retryable: true,
      reason: 'OZON 已受理商品，但库存仍在平台内部同步；继续处理会复用原导入任务。',
      resumeState: 'IMPORTING',
      attempt: 3,
      maxAttempts: 12,
      nextAttemptAt: '2026-08-01T12:02:00.000Z',
      offers: offerIds.map((offerId) => ({
        offerId,
        priceStatus: 'SUCCEEDED',
        stockStatus: offerId === '0000062-02' ? 'SUCCEEDED' : 'PENDING',
        ...(offerId === '0000062-02' ? {} : { errors: [{ operation: 'stocksWrite', code: 'TOO_MANY_REQUESTS', message: 'Stock is updated too frequently' }] })
      }))
    };
    let recheckBody: unknown;
    let submitCalled = false;
    await page.route(/\/api\/v1\/ozon\/.*/, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/v1/ozon/system') return route.fulfill({ json: readyReadiness });
      if (path === '/api/v1/ozon/listings') return route.fulfill({ json: { items: [listing], total: 1, page: 1, pageSize: 100 } });
      if (path === '/api/v1/ozon/listings/0000062') return route.fulfill({ json: {
        listing,
        activeJob: { ...manualJob, recoveryAction: 'RECHECK' },
        canManualTakeover: false
      } });
      if (path === '/api/v1/ozon/listings/0000062/jobs') return route.fulfill({ json: { items: [manualJob], total: 1, page: 1, pageSize: 100 } });
      if (path === `/api/v1/ozon/listings/0000062/jobs/${jobId}`) return route.fulfill({ json: { job: manualJob, recovery } });
      if (path === `/api/v1/ozon/listings/0000062/jobs/${jobId}/recheck`) {
        recheckBody = route.request().postDataJSON();
        return route.fulfill({ json: { job: { ...manualJob, state: 'IMPORTING', rowVersion: 8, lastErrorCode: undefined, lastErrorMessage: undefined } } });
      }
      if (path === '/api/v1/ozon/listings/0000062/submit') {
        submitCalled = true;
        return route.fulfill({ status: 500, json: {} });
      }
      return route.fallback();
    });
    await routeNoPublicationTaskSummaries(page);

    await openExistingPublicMaterial(page, listing);
    const workspace = page.getByRole('dialog', { name: /0000062/ });
    await expect(workspace.getByText('该任务已进入 OZON，不能重复创建；可继续处理原任务。')).toBeVisible();
    await workspace.getByRole('button', { name: '继续处理' }).click();
    const detail = page.getByRole('dialog', { name: '手动任务详情 · 0000062' });
    await expect(detail.getByText('TOO_MANY_REQUESTS').first()).toBeVisible();
    await expect(detail.getByText('0000062-02').last()).toBeVisible();
    await expect(detail.getByText('成功', { exact: true }).first()).toBeVisible();
    await detail.getByRole('button', { name: '继续处理原任务' }).click();
    await page.getByRole('tooltip').getByRole('button', { name: '继续处理', exact: true }).click();
    await expect.poll(() => recheckBody).toEqual({ rowVersion: 7 });
    await expect(page.getByText('原任务已恢复，将复用现有 OZON 导入任务继续处理')).toBeVisible();
    expect(submitCalled).toBe(false);

    await page.setViewportSize({ width: 320, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('逐变体俄文详情显示清理审计与重复词提醒，平台字段失败可返回编辑', async ({ page }) => {
    const variantId = '66666666-6666-4666-8666-666666666666';
    const repeatedPocketDescription = 'Карман на молнии, открытый накладной карман для мелочей, на задней стенке предусмотрен дополнительный горизонтальный карман';
    const failedListing = {
      ...editableListing,
      data: {
        ...editableListing.data,
        descriptionRu: repeatedPocketDescription,
        descriptionSource: { kind: 'E003', executionId: '87830', productVariantId: variantId },
        descriptionWarnings: [{
          code: 'OZON_DESCRIPTION_KEYWORD_STUFFING',
          fieldPath: 'descriptionRu',
          policyVersion: 'merchroute-ozon-content-v4'
        }],
        offers: [{
          variantId,
          variantCode: '01',
          offerId: '0000049-01',
          barcode: '',
          modelGroup: '0000049',
          price: 2990,
          oldPrice: 3990,
          stock: 5,
          descriptionRu: 'с выраженной фактурой.',
          descriptionSource: { kind: 'E003', executionId: '87829', productVariantId: variantId },
          descriptionWarnings: [{
            code: 'OZON_DESCRIPTION_CJK_REMOVED',
            fieldPath: 'offers[0].descriptionRu',
            removedFragments: ['под荔枝纹'],
            beforeSha256: 'a'.repeat(64),
            afterSha256: 'b'.repeat(64)
          }],
          attributes: [],
          media: []
        }]
      }
    };
    const failedJob = {
      ...waitingAutoJob,
      id: '66666666-6666-4666-8666-666666666667',
      source: 'MANUAL',
      credentialBindingMode: 'PURE_LEGACY',
      state: 'NEEDS_ATTENTION',
      rowVersion: 6,
      revision: failedListing.revision,
      taskFolder: '0000049__r5',
      workRelPath: 'processing/0000049__r5',
      directoryStage: 'PROCESSING',
      lastErrorCode: 'OZON_IMPORT_PARTIAL_FAILED',
      lastErrorMessage: 'DESCRIPTION_DECLINE: attribute_id 4191 contains недопустимые символы'
    };
    let returnBody: unknown;
    await page.route(/\/api\/v1\/ozon\/.*/, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/v1/ozon/system') return route.fulfill({ json: readyReadiness });
      if (path === '/api/v1/ozon/categories') return route.fulfill({ json: { items: [presetCategory] } });
      if (path === '/api/v1/ozon/listings') return route.fulfill({ json: { items: [failedListing], total: 1, page: 1, pageSize: 100 } });
      if (path === '/api/v1/ozon/listings/0000049') return route.fulfill({ json: { listing: failedListing, canManualTakeover: false } });
      if (path === '/api/v1/ozon/listings/0000049/jobs') return route.fulfill({ json: { items: [failedJob], total: 1, page: 1, pageSize: 100 } });
      if (path === `/api/v1/ozon/listings/0000049/jobs/${failedJob.id}`) return route.fulfill({ json: {
        job: failedJob,
        recovery: {
          action: 'RETURN_TO_EDIT', retryable: false,
          reason: 'OZON 返回商品字段错误，需要返回草稿修正后重新生成。',
          attempt: 0, maxAttempts: 12, offers: []
        }
      } });
      if (path === `/api/v1/ozon/listings/0000049/jobs/${failedJob.id}/return-to-edit`) {
        returnBody = route.request().postDataJSON();
        return route.fulfill({ json: {
          job: { ...failedJob, state: 'CANCELLED', rowVersion: 7 },
          listing: { ...failedListing, status: 'READY', rowVersion: 6 },
          recovery: { mode: 'HARDLINK', restoredFileCount: 3, inboxDirectory: 'G:\\01_MerchRoute\\OZON-Auto-Publish\\inbox\\0000049' }
        } });
      }
      return route.fallback();
    });
    await routeNoPublicationTaskSummaries(page);

    await openExistingPublicMaterial(page, failedListing);
    const workspace = page.getByRole('dialog', { name: /0000049/ });
    await expect(workspace.getByLabel('该变体的俄文商品详情')).toHaveValue('с выраженной фактурой.');
    await expect(workspace.getByText('E003 执行 87829')).toBeVisible();
    await expect(workspace.getByText('历史详情清理记录', { exact: true })).toBeVisible();
    await expect(workspace.getByText('该记录来自旧版本，不代表当前会自动清理：под荔枝纹', { exact: true })).toBeVisible();
    await expect(workspace.getByText('详情重复词提醒', { exact: true })).toBeVisible();
    await expect(workspace.getByText('检测到高密度重复词，系统已允许继续上品，请人工确认不是搜索词堆砌。字段：descriptionRu', { exact: true })).toBeVisible();

    await workspace.getByRole('button', { name: `打开手动任务详情 ${failedJob.id}` }).click();
    const jobDrawer = page.getByRole('dialog', { name: '手动任务详情 · 0000049' });
    await expect(jobDrawer.getByRole('button', { name: '返回编辑并修正' })).toBeVisible();
    await jobDrawer.getByRole('button', { name: '返回编辑并修正' }).click();
    await expect(page.getByText('返回编辑并修正该任务？')).toBeVisible();
    await page.getByRole('button', { name: '返回编辑', exact: true }).click();
    await expect(page.getByText('媒体已通过硬链接恢复，任务已返回编辑')).toBeVisible();
    expect(returnBody).toEqual({ jobRowVersion: 6, listingRowVersion: 5 });
  });

  test('publication 手动任务按 publication task-detail 读取合同并隐藏 legacy 动作', async ({ page }) => {
    const planHash = `sha256:${'e'.repeat(64)}`;
    const requestId = '55555555-5555-4555-8555-555555555555';
    const publicationManualJob = {
      ...waitingAutoJob,
      id: '99999999-9999-4999-8999-999999999998',
      publicationId: '99999999-9999-4999-8999-999999999997',
      source: 'MANUAL',
      state: 'NEEDS_ATTENTION',
      rowVersion: 6,
      lastErrorCode: 'OZON_IMPORT_PARTIAL_FAILED',
      lastErrorMessage: 'publication 任务等待处理'
    };
    const publication = {
      id: publicationManualJob.publicationId,
      sku: publicationManualJob.sku,
      generatedVersionId: '77777777-7777-4777-8777-777777777777',
      revision: 5,
      storeId: publicationManualJob.storeId,
      storeAliasSnapshot: publicationManualJob.storeAlias,
      storeDisplayNameSnapshot: 'OZON 主店',
      status: 'NEEDS_ATTENTION',
      source: 'MANUAL',
      credentialBindingMode: 'VAULT',
      storeConfigVersion: 3,
      warehouseId: 'warehouse-main',
      warehouseName: '主店仓库',
      fulfillmentMode: 'FBS',
      accountCurrency: 'RUB',
      offerIds: ['0000049-01'],
      offerContractHash: `sha256:${'a'.repeat(64)}`,
      materializationHash: `sha256:${'b'.repeat(64)}`,
      productIds: [],
      ozonSkus: [],
      productLinks: [],
      result: {},
      planHash,
      requestId,
      rowVersion: 7,
      createdAt: '2026-08-11T02:00:00.000Z',
      updatedAt: '2026-08-11T02:01:00.000Z'
    };
    let legacyActionCalls = 0;
    let legacyDetailCalls = 0;
    let publicationDetailCalls = 0;
    await page.route(/\/api\/v1\/ozon\/.*/, async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (path === '/api/v1/ozon/system') return route.fulfill({ json: readyReadiness });
      if (path === '/api/v1/ozon/categories') return route.fulfill({ json: { items: [presetCategory] } });
      if (path === '/api/v1/ozon/listings' && method === 'GET') return route.fulfill({ json: { items: [editableListing], total: 1, page: 1, pageSize: 100 } });
      if (path === '/api/v1/ozon/listings/0000049' && method === 'GET') return route.fulfill({ json: { listing: editableListing, canManualTakeover: false } });
      if (path === '/api/v1/ozon/listings/0000049/jobs' && method === 'GET') return route.fulfill({ json: { items: [publicationManualJob], total: 1, page: 1, pageSize: 100 } });
      if (path === `/api/v1/ozon/listings/0000049/jobs/${publicationManualJob.id}` && method === 'GET') {
        legacyDetailCalls += 1;
        return route.fulfill({ status: 500, json: { error: { code: 'UNSAFE_LEGACY_CALL', message: 'publication 任务不得调用 legacy detail' } } });
      }
      if (path === `/api/v1/ozon/publications/${publication.id}/task-detail` && method === 'GET') {
        publicationDetailCalls += 1;
        return route.fulfill({ json: {
          publication,
          job: publicationManualJob,
          events: [{ id: '66666666-6666-4666-8666-666666666667', jobId: publicationManualJob.id, eventType: 'MULTISTORE_PUBLICATION_NEEDS_ATTENTION', message: '原 attempt 需要处理', createdAt: publication.updatedAt }],
          frozenContract: { planHash, requestId, materialHash: `sha256:${'f'.repeat(64)}`, contentPolicyVersion: 'merchroute-ozon-content-v3', publicationMode: 'CREATE_ONLY' },
          readback: { required: true, canRecheck: false, gatewayRequestCount: 1, deliveryStates: ['UNKNOWN'] },
          recovery: { canRecheck: false, canManualTakeover: false, recoveryMode: 'READBACK_REQUIRED', blockedReason: 'GATEWAY_UNKNOWN' }
        } });
      }
      if (path === `/api/v1/ozon/listings/0000049/jobs/${publicationManualJob.id}/recheck` && method === 'POST') {
        legacyActionCalls += 1;
        return route.fulfill({ status: 500, json: { error: { code: 'UNSAFE_LEGACY_CALL', message: '不应调用 legacy recheck' } } });
      }
      if (path === `/api/v1/ozon/listings/0000049/jobs/${publicationManualJob.id}/return-to-edit` && method === 'POST') {
        legacyActionCalls += 1;
        return route.fulfill({ status: 500, json: { error: { code: 'UNSAFE_LEGACY_CALL', message: '不应调用 legacy return-to-edit' } } });
      }
      if (path === '/api/v1/ozon/listings/0000049/media/scan' && method === 'POST') return route.fulfill({ json: { changed: false, listing: editableListing, mediaAssets: [], mediaDirectory: editableListing.data.mediaSourceRoot, removedReferences: 0 } });
      return route.fallback();
    });

    await page.goto('/listing/ozon?view=manual');
    await page.getByRole('button', { name: '打开工作台' }).click();
    const workspace = page.getByRole('dialog', { name: /0000049/ });
    await workspace.getByRole('button', { name: `打开手动任务详情 ${publicationManualJob.id}` }).click();
    const detail = page.getByRole('dialog', { name: '手动任务详情 · 0000049' });
    await expect(detail.getByText('该任务由店铺 publication 管理', { exact: true })).toBeVisible();
    await expect(detail.getByText('原 attempt 暂不能恢复', { exact: true })).toBeVisible();
    await expect(detail).toContainText('GATEWAY_UNKNOWN');
    await expect(detail).toContainText(planHash);
    await expect(detail.getByRole('button', { name: '继续处理原任务' })).toHaveCount(0);
    await expect(detail.getByRole('button', { name: '重检原任务' })).toHaveCount(0);
    await expect(detail.getByRole('button', { name: '返回编辑并修正' })).toHaveCount(0);
    expect(publicationDetailCalls).toBe(1);
    expect(legacyDetailCalls).toBe(0);
    expect(legacyActionCalls).toBe(0);
  });

  test('打开空白 DRAFT 自动补齐标题和逐变体详情，人工改写后来源切换为 MANUAL', async ({ page }) => {
    const variantId = '77777777-7777-4777-8777-777777777777';
    const materialSeed = withReadyPublicMaterial(editableListing, variantId);
    const emptyListing = {
      ...materialSeed,
      sku: '0000051',
      productName: '新款斜挎包',
      status: 'DRAFT',
      rowVersion: 7,
      revision: 4,
      data: {
        ...materialSeed.data,
        titleRu: '',
        descriptionRu: '',
        sharedAttributes: [{ attributeId: 10, complexId: 0, values: [{ value: 'Нейлон' }] }],
        offers: [{
          ...materialSeed.data.offers[0],
          variantCode: '01',
          offerId: '0000051-01',
          barcode: '',
          modelGroup: '0000051',
          price: 2990,
          stock: 5,
          descriptionRu: '',
          attributes: [{ attributeId: 4298, complexId: 0, values: [{ dictionaryValueId: 35 }] }],
          media: materialSeed.data.offers[0].media
        }]
      }
    };
    const initializedListing = {
      ...emptyListing,
      rowVersion: 8,
      revision: 5,
      data: {
        ...emptyListing.data,
        titleRu: 'Новая сумка через плечо',
        descriptionRu: 'Общее описание товара.',
        descriptionSource: { type: 'E003', workflowCode: 'E003', executionId: 87830 },
        initialization: {
          status: 'COMPLETE',
          initializedAt: '2026-08-06T08:00:00.000Z',
          issues: [],
          title: { workflowId: 'HDh0ZNLK2ps5qasR', language: '俄文', maxLength: 60, cached: false },
          description: { workflowCode: 'E003', executionId: 87830 }
        },
        offers: [{
          ...emptyListing.data.offers[0],
          descriptionRu: 'Описание черного варианта.',
          descriptionSource: { type: 'E003', workflowCode: 'E003', executionId: 87830, productVariantId: variantId }
        }]
      }
    };
    let initializeBody: unknown;
    let updateBody: any;
    let releaseInitialize = () => {};
    const initializeGate = new Promise<void>((resolve) => { releaseInitialize = resolve; });
    await page.route(/\/api\/v1\/ozon\/system$/, (route) => route.fulfill({ json: readyReadiness }));
    await page.route(/\/api\/v1\/ozon\/categories$/, (route) => route.fulfill({ json: { items: [presetCategory] } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000051\/initialize-missing$/, async (route) => {
      initializeBody = route.request().postDataJSON();
      await initializeGate;
      return route.fulfill({ json: { listing: initializedListing } });
    });
    await page.route(/\/api\/v1\/ozon\/listings\/0000051$/, async (route) => {
      return route.fulfill({ json: { listing: emptyListing, canManualTakeover: false } });
    });
    await page.route(/\/api\/v1\/ozon\/listings\/0000051\/shared-material$/, (route) => {
      updateBody = route.request().postDataJSON();
      const savedListing = {
        ...initializedListing,
        rowVersion: 9,
        revision: 6,
        data: {
          ...initializedListing.data,
          descriptionRu: updateBody.descriptionRu,
          descriptionSource: updateBody.descriptionSource,
          offers: updateBody.variants.map((variant: any, index: number) => ({ ...initializedListing.data.offers[index], ...variant }))
        }
      };
      return route.fulfill({ json: {
        listing: savedListing,
        generatedVersionId: 'e2e-material-0000051',
        materialRevision: 6,
        materialHash: `sha256:${'c'.repeat(64)}`,
        contentPolicyVersion: 'merchroute-ozon-content-v3'
      } });
    });
    await routeNoPublicationTaskSummaries(page);

    await openExistingPublicMaterial(page, emptyListing);
    const drawer = page.getByRole('dialog', { name: /0000051/ });
    await expect.poll(() => initializeBody).toEqual({ rowVersion: 7 });
    await drawer.getByRole('textbox', { name: /^共享俄文商品详情/ }).fill('Общее описание от пользователя.');
    await drawer.getByLabel('该变体的俄文商品详情').fill('Описание варианта от пользователя.');
    const initializeResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/initialize-missing'));
    releaseInitialize();
    await initializeResponse;
    await expect(drawer.getByRole('textbox', { name: /^共享俄文商品详情/ })).toHaveValue('Общее описание от пользователя.');
    await expect(drawer.getByLabel('该变体的俄文商品详情')).toHaveValue('Описание варианта от пользователя.');
    await expect(drawer.getByText('俄文标题与商品详情已自动初始化')).toBeVisible();
    expect(updateBody).toBeUndefined();

    await drawer.getByRole('button', { name: '保存公共素材' }).click();
    await expect.poll(() => updateBody).not.toBeUndefined();
    expect(updateBody.descriptionSource).toEqual({ type: 'MANUAL' });
    expect(updateBody.variants[0].descriptionSource).toEqual({ type: 'MANUAL', productVariantId: variantId });
  });

  test('打开 OZON 工作台后自动扫描共享媒体库并按产品变体勾选主图和主图视频', async ({ page }) => {
    const mediaCategory = structuredClone(presetCategory);
    mediaCategory.publishedVersion.snapshot.attributes = mediaCategory.publishedVersion.snapshot.attributes.map((attribute) => attribute.id === 20 ? { ...attribute, required: false } : attribute);
    const firstVariantId = '11111111-1111-4111-8111-111111111111';
    const secondVariantId = '22222222-2222-4222-8222-222222222222';
    const firstColor = { colorKey: 'c'.repeat(64), nameRu: 'Коричневый', nameZh: '咖啡色' };
    const secondColor = { colorKey: 'd'.repeat(64), nameRu: 'Хаки', nameZh: '卡其色' };
    const imageAsset = {
      assetId: 'image-shared',
      relativePath: 'variants/咖啡色/images/e005-batch/01.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 1024,
      sha256: 'a'.repeat(64),
      modifiedAt: '2026-07-27T00:00:00.000Z',
      validationStatus: 'VALID',
      productVariantId: firstVariantId,
      productVariantName: '咖啡色',
      productVariantColor: firstColor,
      sourceStageId: 'E005',
      sourceSubmissionId: 'e005-first',
      deliveredAt: '2026-07-27T00:00:00.000Z'
    };
    const videoAsset = {
      assetId: 'video-shared',
      relativePath: 'variants/咖啡色/videos/e004-batch/main.mp4',
      kind: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 2048,
      sha256: 'b'.repeat(64),
      modifiedAt: '2026-07-27T00:00:00.000Z',
      validationStatus: 'VALID',
      productVariantId: firstVariantId,
      productVariantName: '咖啡色',
      productVariantColor: firstColor,
      sourceStageId: 'E004',
      sourceSubmissionId: 'e004-first',
      deliveredAt: '2026-07-27T00:00:00.000Z'
    };
    const secondImageAsset = {
      ...imageAsset,
      assetId: 'image-khaki',
      relativePath: 'variants/卡其色/images/e005-batch/01-khaki.png',
      sha256: 'c'.repeat(64),
      productVariantId: secondVariantId,
      productVariantName: '卡其色',
      productVariantColor: secondColor,
      sourceSubmissionId: 'e005-second'
    };
    const secondVideoAsset = {
      ...videoAsset,
      assetId: 'video-khaki',
      relativePath: 'variants/卡其色/videos/e004-batch/main-khaki.mp4',
      sha256: 'd'.repeat(64),
      productVariantId: secondVariantId,
      productVariantName: '卡其色',
      productVariantColor: secondColor,
      sourceSubmissionId: 'e004-second'
    };
    const scannedAssets = [imageAsset, videoAsset, secondImageAsset, secondVideoAsset];
    const listing = {
      ...publishedListing,
      status: 'DRAFT',
      rowVersion: 7,
      revision: 4,
      data: {
        categoryKey: presetCategory.categoryKey,
        categoryVersionId: presetCategory.publishedVersion.id,
        fulfillmentMode: 'FBS',
        warehouseId: '10001',
        currency: 'RUB',
        vat: '0.2',
        titleRu: 'Рюкзак',
        descriptionRu: 'Описание',
        brand: '',
        dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 800, weightUnit: 'g' },
        sharedAttributes: [{ attributeId: 10, complexId: 0, values: [{ value: 'Нейлон' }] }],
        offers: [
          { variantId: firstVariantId, productVariantId: firstVariantId, productVariantName: '咖啡色', productVariantColor: firstColor, variantCode: '01', offerId: '0000051-01', barcode: '', modelGroup: '0000051', price: 2990, stock: 5, descriptionRu: 'Описание коричневого варианта', attributes: [{ attributeId: 4298, complexId: 0, values: [{ dictionaryValueId: 35 }] }], media: [] },
          { variantId: secondVariantId, productVariantId: secondVariantId, productVariantName: '卡其色', productVariantColor: secondColor, variantCode: '02', offerId: '0000051-02', barcode: '', modelGroup: '0000051', price: 2990, stock: 5, descriptionRu: 'Описание варианта хаки', attributes: [{ attributeId: 4298, complexId: 0, values: [{ dictionaryValueId: 36 }] }], media: [] }
        ],
        mediaAssets: [],
        mediaSourceRoot: 'G:\\01_MerchRoute\\OZON-Auto-Publish\\inbox\\0000051'
      }
    };
    const scannedListing = { ...listing, rowVersion: 8, revision: 5, data: { ...listing.data, mediaAssets: scannedAssets } };
    let scanCalls = 0;
    let updateCalls = 0;
    await page.route(/\/api\/v1\/ozon\/system$/, (route) => route.fulfill({ json: {
      ...readyReadiness,
      settings: { ...readyReadiness.settings, rootDirectory: 'G:\\01_MerchRoute\\OZON-Auto-Publish' }
    } }));
    await page.route(/\/api\/v1\/ozon\/categories$/, (route) => route.fulfill({ json: { items: [mediaCategory] } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000051$/, async (route) => {
      return route.fulfill({ json: { listing } });
    });
    await page.route(/\/api\/v1\/ozon\/listings\/0000051\/shared-material$/, (route) => {
      updateCalls += 1;
      const data = route.request().postDataJSON() as any;
      const savedListing = {
        ...scannedListing,
        status: 'READY',
        rowVersion: 9,
        revision: 6,
        data: {
          ...scannedListing.data,
          descriptionRu: data.descriptionRu,
          offers: data.variants.map((variant: any, index: number) => ({ ...scannedListing.data.offers[index], ...variant }))
        }
      };
      return route.fulfill({ json: {
        listing: savedListing,
        generatedVersionId: 'e2e-material-0000051',
        materialRevision: 6,
        materialHash: `sha256:${'d'.repeat(64)}`,
        contentPolicyVersion: 'merchroute-ozon-content-v3'
      } });
    });
    await page.route(/\/api\/v1\/ozon\/listings\/0000051\/media\/.+/, (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/media/scan')) {
        scanCalls += 1;
        return route.fulfill({ json: { changed: true, listing: scannedListing, mediaAssets: scannedAssets, mediaDirectory: 'G:\\01_MerchRoute\\OZON-Auto-Publish\\inbox\\0000051\\variants', removedReferences: 0 } });
      }
      if (url.searchParams.get('thumbnail') === 'true') {
        return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
      }
      return route.fulfill({ contentType: 'video/mp4', body: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]) });
    });
    await routeNoPublicationTaskSummaries(page);

    const scanRequest = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/media/scan'));
    await openExistingPublicMaterial(page, listing);
    const drawer = page.getByRole('dialog', { name: /0000051/ });
    expect((await scanRequest).postDataJSON()).toEqual({ rowVersion: 7 });
    await expect.poll(() => scanCalls).toBe(1);
    await expect(drawer.getByText('G:\\01_MerchRoute\\OZON-Auto-Publish\\inbox\\0000051\\variants')).toBeVisible();
    await expect(drawer.getByText('共享媒体库', { exact: true })).toBeVisible();
    await expect(drawer.getByText('产品介绍视频链接', { exact: true })).toHaveCount(0);
    await expect(drawer.getByText('产品介绍视频标题', { exact: true })).toHaveCount(0);
    await expect(drawer.getByText('视频封面系统字段', { exact: true })).toHaveCount(0);
    await expect(drawer.getByText('视频中的商品', { exact: true })).toHaveCount(0);
    const imageTile = drawer.locator('.ozon-media-tile').filter({ hasText: '01.png' });
    const videoTile = drawer.locator('.ozon-media-tile').filter({ hasText: 'main.mp4' });
    await expect(drawer.getByText('已生成媒体自动匹配建议，尚未保存')).toBeVisible();
    await expect(imageTile.getByRole('checkbox', { name: '用于当前变体' })).toBeChecked();
    await expect(videoTile.getByRole('checkbox', { name: '设为产品视频/封面' })).toBeChecked();
    await expect(videoTile.getByText('产品介绍视频', { exact: true })).toBeVisible();
    await expect(videoTile.getByText('视频封面', { exact: true })).toBeVisible();
    await expect(drawer.locator('.ozon-selected-media').getByText('01.png')).toBeVisible();
    await expect(drawer.locator('.ozon-selected-video').getByText('main.mp4')).toBeVisible();
    await expect(drawer.locator('.ozon-selected-video').getByText('产品介绍视频', { exact: true })).toBeVisible();
    await expect(drawer.locator('.ozon-selected-video').getByText('视频封面', { exact: true })).toBeVisible();
    await drawer.getByRole('tab', { name: /0000051-02/ }).click();
    const activeVariant = drawer.locator('.ant-tabs-tabpane-active');
    await expect(activeVariant.locator('.ozon-selected-media').getByText('01-khaki.png')).toBeVisible();
    await expect(activeVariant.locator('.ozon-selected-video').getByText('main-khaki.mp4')).toBeVisible();
    expect(updateCalls).toBe(0);

    const requestPromise = page.waitForRequest((request) => request.method() === 'PUT' && new URL(request.url()).pathname === '/api/v1/ozon/listings/0000051/shared-material');
    await drawer.getByRole('button', { name: '保存公共素材' }).click();
    const saved = (await requestPromise).postDataJSON();
    expect(saved.rowVersion).toBe(8);
    expect(saved.variants).toHaveLength(2);
    expect(saved.variants[0].media.map((entry: any) => entry.assetId)).toEqual(['image-shared', 'video-shared']);
    expect(saved.variants[1].media.map((entry: any) => entry.assetId)).toEqual(['image-khaki', 'video-khaki']);
    expect(saved.variants.every((variant: any) => variant.media.filter((entry: any) => entry.kind === 'image' && entry.isPrimary).length === 1)).toBe(true);
    expect(saved.variants.every((variant: any) => variant.media.filter((entry: any) => entry.kind === 'video').length === 1)).toBe(true);
    expect(updateCalls).toBe(1);
    expect(scanCalls).toBe(1);
    await expect(drawer.getByText('资料就绪', { exact: true }).first()).toBeVisible();
    await expect(drawer.getByRole('button', { name: '选择店铺并提交' })).toBeEnabled();
    await page.setViewportSize({ width: 320, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('自动扫描无资产变化时保持草稿干净，重开后对已入库媒体生成未保存建议', async ({ page }) => {
    const variantId = '33333333-3333-4333-8333-333333333333';
    const listing = {
      ...editableListing,
      sku: '0000051',
      productName: '媒体同步无变化测试商品',
      status: 'DRAFT',
      rowVersion: 11,
      revision: 7,
      data: {
        ...editableListing.data,
        titleRu: 'Рюкзак',
        descriptionRu: 'Общее описание',
        sharedAttributes: [{ attributeId: 10, complexId: 0, values: [{ value: 'Нейлон' }] }],
        offers: [{
          variantId,
          productVariantId: variantId,
          productVariantName: '黑色',
          variantCode: '01',
          offerId: '0000051-01',
          barcode: '',
          modelGroup: '0000051',
          price: 2990,
          stock: 5,
          descriptionRu: 'Описание черного варианта',
          attributes: [{ attributeId: 4298, complexId: 0, values: [{ dictionaryValueId: 35 }] }],
          media: []
        }],
        mediaAssets: [],
        mediaSourceRoot: 'G:\\01_MerchRoute\\OZON-Auto-Publish\\inbox\\0000051'
      }
    };
    const lateImage = {
      assetId: 'late-image',
      relativePath: 'variants/黑色/images/e005-late/01.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 1024,
      sha256: 'e'.repeat(64),
      modifiedAt: '2026-08-06T10:00:00.000Z',
      validationStatus: 'VALID',
      productVariantId: variantId,
      productVariantName: '黑色',
      sourceStageId: 'E005',
      sourceSubmissionId: 'e005-late',
      deliveredAt: '2026-08-06T10:00:00.000Z'
    };
    const lateVideo = {
      ...lateImage,
      assetId: 'late-video',
      relativePath: 'variants/黑色/videos/e004-late/main.mp4',
      kind: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 2048,
      sha256: 'f'.repeat(64),
      sourceStageId: 'E004',
      sourceSubmissionId: 'e004-late'
    };
    const lateAssets = [lateImage, lateVideo];
    const lateScannedListing = { ...listing, rowVersion: 12, revision: 8, data: { ...listing.data, mediaAssets: lateAssets } };
    let mediaAvailable = false;
    let scanCalls = 0;
    let updateCalls = 0;
    let releaseScan = () => {};
    const scanGate = new Promise<void>((resolve) => { releaseScan = resolve; });
    await page.route(/\/api\/v1\/ozon\/system$/, (route) => route.fulfill({ json: readyReadiness }));
    await page.route(/\/api\/v1\/ozon\/categories$/, (route) => route.fulfill({ json: { items: [presetCategory] } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000051$/, async (route) => {
      if (route.request().method() === 'PUT') {
        updateCalls += 1;
        return route.fulfill({ json: { listing: mediaAvailable ? lateScannedListing : listing } });
      }
      return route.fulfill({ json: { listing: mediaAvailable ? lateScannedListing : listing, canManualTakeover: false } });
    });
    await page.route(/\/api\/v1\/ozon\/listings\/0000051\/media\/scan$/, async (route) => {
      scanCalls += 1;
      if (scanCalls === 1) {
        await scanGate;
        return route.fulfill({ json: {
          changed: false,
          listing,
          mediaAssets: [],
          mediaDirectory: 'G:\\01_MerchRoute\\OZON-Auto-Publish\\inbox\\0000051\\variants',
          removedReferences: 0
        } });
      }
      return route.fulfill({ json: {
        changed: false,
        listing: lateScannedListing,
        mediaAssets: lateAssets,
        mediaDirectory: 'G:\\01_MerchRoute\\OZON-Auto-Publish\\inbox\\0000051\\variants',
        removedReferences: 0
      } });
    });
    await routeNoPublicationTaskSummaries(page);

    const scanRequest = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/media/scan'));
    await openExistingPublicMaterial(page, listing);
    const drawer = page.getByRole('dialog', { name: /0000051/ });
    expect((await scanRequest).postDataJSON()).toEqual({ rowVersion: 11 });
    await expect.poll(() => scanCalls).toBe(1);

    const saveButton = drawer.getByRole('button', { name: '保存公共素材' });
    const submitButton = drawer.getByRole('button', { name: '选择店铺并提交' });
    await expect(saveButton).toBeDisabled();
    await saveButton.locator('xpath=..').hover();
    await expect(page.getByRole('tooltip').filter({ hasText: '正在同步标题、详情和媒体' })).toBeVisible();

    const scanResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/media/scan'));
    releaseScan();
    await scanResponse;
    await expect(drawer.getByText('有未保存修改')).toHaveCount(0);
    await expect(saveButton).toBeDisabled();
    await saveButton.locator('xpath=..').hover();
    await expect(page.getByRole('tooltip').filter({ hasText: '当前公共素材已保存' })).toBeVisible();
    await expect(submitButton).toBeDisabled();
    await submitButton.locator('xpath=..').hover();
    const submitReason = page.getByRole('tooltip').filter({ hasText: '每个产品变体至少需要一张图片' });
    await expect(submitReason).toBeVisible();
    await expect(submitReason).toContainText('每个产品变体至少需要一张图片');
    await expect(drawer.getByRole('button', { name: '扫描 variants 目录' })).toBeEnabled();
    await page.waitForTimeout(250);
    expect(scanCalls).toBe(1);
    expect(updateCalls).toBe(0);

    mediaAvailable = true;
    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(drawer).toBeHidden();
    await page.reload();
    const reopenedScanRequest = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/media/scan'));
    await openExistingPublicMaterial(page, lateScannedListing, false);
    const reopenedDrawer = page.getByRole('dialog', { name: /0000051/ });
    expect((await reopenedScanRequest).postDataJSON()).toEqual({ rowVersion: 12 });
    await expect.poll(() => scanCalls).toBe(2);
    await expect(reopenedDrawer.getByText('已生成媒体自动匹配建议，尚未保存')).toBeVisible();
    const lateImageTile = reopenedDrawer.locator('.ozon-media-tile').filter({ hasText: '01.png' });
    const lateVideoTile = reopenedDrawer.locator('.ozon-media-tile').filter({ hasText: 'main.mp4' });
    await expect(lateImageTile.getByRole('checkbox', { name: '用于当前变体' })).toBeChecked();
    await expect(lateVideoTile.getByRole('checkbox', { name: '设为产品视频/封面' })).toBeChecked();
    await expect(reopenedDrawer.getByText('有未保存修改', { exact: true })).toBeVisible();
    await page.waitForTimeout(250);
    expect(scanCalls).toBe(2);
    expect(updateCalls).toBe(0);
  });

  test('关闭 A 后的迟到扫描响应不污染 B，B 会继续自动扫描一次', async ({ page }) => {
    const makeListing = (sku: string, suffix: string, variantId: string) => ({
      ...editableListing,
      sku,
      productName: `跨 SKU 扫描测试 ${suffix}`,
      status: 'DRAFT',
      rowVersion: 7,
      revision: 4,
      ozonProductLinks: [],
      data: {
        ...editableListing.data,
        titleRu: `Рюкзак ${suffix}`,
        descriptionRu: `Общее описание ${suffix}`,
        sharedAttributes: [{ attributeId: 10, complexId: 0, values: [{ value: 'Нейлон' }] }],
        offers: [{
          variantId,
          productVariantId: variantId,
          productVariantName: suffix,
          variantCode: '01',
          offerId: `${sku}-01`,
          barcode: '',
          modelGroup: sku,
          price: 2990,
          stock: 5,
          descriptionRu: `Описание варианта ${suffix}`,
          attributes: [{ attributeId: 4298, complexId: 0, values: [{ dictionaryValueId: 35 }] }],
          media: []
        }],
        mediaAssets: [],
        mediaSourceRoot: `G:\\01_MerchRoute\\OZON-Auto-Publish\\inbox\\${sku}`
      }
    });
    const listingA = makeListing('0000051', 'A', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const listingB = makeListing('0000052', 'B', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const assetA = {
      assetId: 'a-late-image',
      relativePath: 'variants/A/images/e005-a/01-a.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 1024,
      sha256: '1'.repeat(64),
      modifiedAt: '2026-08-06T11:00:00.000Z',
      validationStatus: 'VALID',
      productVariantId: listingA.data.offers[0].productVariantId,
      productVariantName: 'A',
      sourceStageId: 'E005',
      sourceSubmissionId: 'e005-a',
      deliveredAt: '2026-08-06T11:00:00.000Z'
    };
    const scannedA = { ...listingA, rowVersion: 8, revision: 5, data: { ...listingA.data, titleRu: 'Ответ A не должен попасть в B', mediaAssets: [assetA] } };
    let scanCallsA = 0;
    let scanCallsB = 0;
    let updateCalls = 0;
    let releaseA = () => {};
    const scanGateA = new Promise<void>((resolve) => { releaseA = resolve; });
    await page.route(/\/api\/v1\/ozon\/system$/, (route) => route.fulfill({ json: readyReadiness }));
    await page.route(/\/api\/v1\/ozon\/categories$/, (route) => route.fulfill({ json: { items: [presetCategory] } }));
    await page.route(/\/api\/v1\/ozon\/listings(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [listingA, listingB], total: 2, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/ozon\/listings\/000005[12]$/, (route) => {
      if (route.request().method() === 'PUT') updateCalls += 1;
      const target = new URL(route.request().url()).pathname.endsWith('0000051') ? listingA : listingB;
      return route.fulfill({ json: { listing: target, canManualTakeover: false } });
    });
    await page.route(/\/api\/v1\/ozon\/listings\/000005[12]\/jobs$/, (route) => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/ozon\/listings\/000005[12]\/media\/.+/, async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith('/media/scan')) {
        return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
      }
      if (url.pathname.includes('/0000051/')) {
        scanCallsA += 1;
        await scanGateA;
        return route.fulfill({ json: { changed: true, listing: scannedA, mediaAssets: [assetA], mediaDirectory: 'G:\\01_MerchRoute\\OZON-Auto-Publish\\inbox\\0000051\\variants', removedReferences: 0 } });
      }
      scanCallsB += 1;
      return route.fulfill({ json: { changed: false, listing: listingB, mediaAssets: [], mediaDirectory: 'G:\\01_MerchRoute\\OZON-Auto-Publish\\inbox\\0000052\\variants', removedReferences: 0 } });
    });
    await routeNoPublicationTaskSummaries(page);

    const scanRequestA = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/0000051/media/scan'));
    await openExistingPublicMaterial(page, listingA, true, [listingA, listingB]);
    const drawerA = page.getByRole('dialog', { name: /0000051/ });
    expect((await scanRequestA).postDataJSON()).toEqual({ rowVersion: 7 });
    await expect.poll(() => scanCallsA).toBe(1);
    await drawerA.getByRole('button', { name: 'Close' }).click();
    await expect(drawerA).toBeHidden();

    const scanRequestB = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/0000052/media/scan'));
    await openExistingPublicMaterial(page, listingB, false);
    const drawerB = page.getByRole('dialog', { name: /0000052/ });
    await expect(drawerB.getByRole('textbox', { name: /^共享俄文商品详情/ })).toHaveValue('Общее описание B');
    const responseA = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/0000051/media/scan'));
    releaseA();
    await responseA;
    expect((await scanRequestB).postDataJSON()).toEqual({ rowVersion: 7 });
    await expect.poll(() => scanCallsB).toBe(1);
    await expect(drawerB.getByRole('textbox', { name: /^共享俄文商品详情/ })).toHaveValue('Общее описание B');
    await expect(drawerB.getByText('有未保存修改', { exact: true })).toHaveCount(0);
    await expect(drawerB.getByText('01-a.png')).toHaveCount(0);
    await page.waitForTimeout(250);
    expect(scanCallsA).toBe(1);
    expect(scanCallsB).toBe(1);
    expect(updateCalls).toBe(0);
  });

  test.skip('类目要求未支持的视频商品字段时降级为仅封面，旧 V1 文件只作迁移提示', async ({ page }) => {
    const coverOnlyCategory = structuredClone(presetCategory);
    coverOnlyCategory.publishedVersion.snapshot.attributes = coverOnlyCategory.publishedVersion.snapshot.attributes.map((attribute: any) => (
      attribute.id === 22273 && attribute.complexId === 100001 ? { ...attribute, required: true } : attribute
    ));
    await page.route(/\/api\/v1\/ozon\/system$/, (route) => route.fulfill({ json: readyReadiness }));
    await page.route(/\/api\/v1\/ozon\/categories$/, (route) => route.fulfill({ json: { items: [coverOnlyCategory] } }));
    await page.route(/\/api\/v1\/ozon\/listings(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [editableListing], total: 1, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000049$/, (route) => route.fulfill({ json: {
      listing: editableListing,
      canManualTakeover: false,
      generatedProductSummary: {
        schemaVersion: 1,
        videoMode: 'COVER_ONLY',
        revision: editableListing.revision,
        isCurrent: true
      }
    } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000049\/jobs(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));
    await routeNoPublicationTaskSummaries(page);

    await page.goto('/listing/ozon?view=manual');
    await page.getByRole('button', { name: '打开工作台' }).click();
    const drawer = page.getByRole('dialog', { name: /0000049/ });
    await expect(drawer.getByText('当前类目已降级为仅视频封面')).toBeVisible();
    await expect(drawer.getByText('该类目要求填写“视频中的商品”')).toBeVisible();
    await expect(drawer.getByText('已检测到迁移前 V1 文件', { exact: true })).toBeVisible();
    await expect(drawer.getByRole('button', { name: '检查共享资料' })).toBeEnabled();
    await expect(drawer.getByRole('button', { name: '选择店铺并提交' })).toBeEnabled();
    await expect(drawer.getByText('视频中的商品', { exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('过期 product.json 显示安全替换提示且不阻止提交', async ({ page }) => {
    const materialListing = withReadyPublicMaterial(editableListing);
    await page.route(/\/api\/v1\/ozon\/system$/, (route) => route.fulfill({ json: readyReadiness }));
    await page.route(/\/api\/v1\/ozon\/categories$/, (route) => route.fulfill({ json: { items: [presetCategory] } }));
    await page.route(/\/api\/v1\/ozon\/listings(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [materialListing], total: 1, page: 1, pageSize: 100 } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000049$/, (route) => route.fulfill({ json: {
      listing: materialListing,
      canManualTakeover: false,
      generatedProductSummary: {
        schemaVersion: 1,
        videoMode: 'COVER_ONLY',
        revision: 4,
        generatedAt: '2026-07-29T07:42:47.992Z',
        isCurrent: false
      }
    } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000049\/jobs(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 100 } }));

    await routeNoPublicationTaskSummaries(page);
    await openExistingPublicMaterial(page, materialListing);
    const drawer = page.getByRole('dialog', { name: /0000049/ });
    await expect(drawer.getByText('迁移前共享 product.json 已过期', { exact: true })).toBeVisible();
    await expect(drawer.getByText(`磁盘文件为 r4，当前草稿为 r${editableListing.revision}`, { exact: false })).toBeVisible();
    await expect(drawer.getByText('已检测到迁移前 V1 文件', { exact: true })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: '选择店铺并提交' })).toBeEnabled();
    await page.setViewportSize({ width: 320, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test.skip('手动资料的中文类目文本和字典选择会进入保存请求', async ({ page }) => {
    let saved: any;
    const listing = {
      ...publishedListing,
      status: 'READY',
      rowVersion: 7,
      revision: 7,
      data: {
        categoryKey: presetCategory.categoryKey,
        categoryVersionId: presetCategory.publishedVersion.id,
        fulfillmentMode: 'FBS',
        warehouseId: '10001',
        currency: 'RUB',
        vat: '0.2',
        titleRu: 'Рюкзак',
        descriptionRu: 'Описание',
        brand: '',
        dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 800, weightUnit: 'g' },
        sharedAttributes: [],
        offers: [],
        mediaAssets: [],
        mediaSourceRoot: ''
      }
    };
    await page.route(/\/api\/v1\/ozon\/categories$/, (route) => route.fulfill({ json: { items: [presetCategory] } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000051$/, async (route) => {
      if (route.request().method() === 'PUT') {
        saved = route.request().postDataJSON();
        return route.fulfill({ json: { listing: { ...listing, rowVersion: 8, revision: 8, data: { ...saved, rowVersion: undefined } } } });
      }
      return route.fulfill({ json: { listing } });
    });

    await page.goto('/listing/ozon?view=manual');
    await page.getByRole('button', { name: '打开工作台' }).click();
    const drawer = page.getByRole('dialog', { name: /0000051/ });
    const materialField = drawer.locator('.ant-form-item').filter({ hasText: '材质' }).first();
    await materialField.getByRole('textbox').fill('中文尼龙');
    await drawer.getByRole('button', { name: '显示所有' }).click();
    const countryField = drawer.locator('.ant-form-item').filter({ hasText: '原产国' }).first();
    await countryField.locator('.ant-select').click();
    await page.locator('.ant-select-item-option-content').filter({ hasText: '中国 / Китай' }).click();
    await drawer.getByRole('button', { name: '保存草稿' }).click();

    await expect.poll(() => saved).toBeTruthy();
    expect(saved.sharedAttributes).toEqual(expect.arrayContaining([
      { attributeId: 10, complexId: 0, values: [{ value: '中文尼龙' }] },
      { attributeId: 4389, complexId: 0, values: [{ dictionaryValueId: 9001 }] }
    ]));
  });

  test.skip('两个变体固定显示并保存 SKU 模型分组，俄文标题变化不影响属性 9048', async ({ page }) => {
    let saved: any;
    const category = structuredClone(presetCategory);
    category.publishedVersion.snapshot.attributes.push(
      { id: 9048, name: 'Артикул', nameRu: 'Артикул', nameZh: '商品编码', description: '', type: 'String', required: true, dictionaryId: 0, maxCount: 1, groupId: 0, groupName: '', complexId: 0, isCollection: false },
      { id: 4180, name: 'Название модели', nameRu: 'Название модели', nameZh: '型号名称', description: '', type: 'String', required: true, dictionaryId: 0, maxCount: 1, groupId: 0, groupName: '', complexId: 0, isCollection: false },
      { id: 4191, name: 'Аннотация', nameRu: 'Аннотация', nameZh: '商品描述', description: '', type: 'String', required: true, dictionaryId: 0, maxCount: 1, groupId: 0, groupName: '', complexId: 0, isCollection: false }
    );
    const listing = {
      ...publishedListing,
      status: 'READY',
      rowVersion: 9,
      revision: 9,
      data: {
        categoryKey: category.categoryKey,
        categoryVersionId: category.publishedVersion.id,
        fulfillmentMode: 'FBS',
        warehouseId: '10001',
        currency: 'RUB',
        vat: '0.2',
        titleRu: 'Старое название',
        descriptionRu: 'Описание',
        brand: '',
        dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 800, weightUnit: 'g' },
        sharedAttributes: [
          { attributeId: 10, complexId: 0, values: [{ value: 'Нейлон' }] },
          { attributeId: 9048, complexId: 0, values: [{ value: 'Старое название 0000051' }] },
          { attributeId: 4180, complexId: 0, values: [{ value: 'Старое название' }] },
          { attributeId: 4191, complexId: 0, values: [{ value: 'Описание' }] }
        ],
        offers: [
          {
            variantId: '11111111-1111-4111-8111-111111111111',
            variantCode: '01',
            offerId: '0000051-01',
            barcode: '',
            modelGroup: 'legacy-group-a',
            price: 2990,
            stock: 5,
            attributes: [{ attributeId: 4298, complexId: 0, values: [{ dictionaryValueId: 35 }] }],
            media: []
          },
          {
            variantId: '22222222-2222-4222-8222-222222222222',
            variantCode: '02',
            offerId: '0000051-02',
            barcode: '',
            modelGroup: 'legacy-group-b',
            price: 3090,
            stock: 6,
            attributes: [{ attributeId: 4298, complexId: 0, values: [{ dictionaryValueId: 36 }] }],
            media: []
          }
        ],
        mediaAssets: [],
        mediaSourceRoot: ''
      }
    };
    await page.route(/\/api\/v1\/ozon\/categories$/, (route) => route.fulfill({ json: { items: [category] } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000051$/, async (route) => {
      if (route.request().method() === 'PUT') {
        saved = route.request().postDataJSON();
        return route.fulfill({ json: { listing: { ...listing, rowVersion: 10, revision: 10, data: { ...saved, rowVersion: undefined } } } });
      }
      return route.fulfill({ json: { listing, canManualTakeover: false } });
    });

    await page.goto('/listing/ozon?view=manual');
    await page.getByRole('button', { name: '打开工作台' }).click();
    const drawer = page.getByRole('dialog', { name: /0000051/ });
    const title = drawer.getByRole('textbox', { name: '俄文商品标题' });
    await title.fill('Новое название');

    const firstModelGroup = drawer.getByRole('textbox', { name: '模型分组' });
    await expect(firstModelGroup).toHaveValue('0000051');
    await expect(firstModelGroup).toHaveAttribute('readonly');
    await drawer.getByRole('tab', { name: /0000051-02/ }).click();
    const secondModelGroup = drawer.getByRole('textbox', { name: '模型分组' });
    await expect(secondModelGroup).toHaveValue('0000051');
    await expect(secondModelGroup).toHaveAttribute('readonly');

    await drawer.getByRole('button', { name: '保存草稿' }).click();
    await expect.poll(() => saved).toBeTruthy();
    expect(saved.offers).toHaveLength(2);
    expect(saved.offers.map((offer: any) => offer.modelGroup)).toEqual(['0000051', '0000051']);
    expect(saved.sharedAttributes.find((attribute: any) => attribute.attributeId === 9048)).toEqual({
      attributeId: 9048,
      complexId: 0,
      values: [{ value: '0000051' }]
    });
    expect(saved.sharedAttributes.find((attribute: any) => attribute.attributeId === 4180)).toEqual({
      attributeId: 4180,
      complexId: 0,
      values: [{ value: 'Новое название' }]
    });
  });

  test.skip('新草稿将类目类型显示为系统只读中俄名称并保存 typeId', async ({ page }) => {
    let saved: any;
    const category = {
      ...presetCategory,
      nameZh: '包/袋',
      nameRu: 'Сумка',
      publishedVersion: {
        ...presetCategory.publishedVersion,
        snapshot: {
          ...presetCategory.publishedVersion.snapshot,
          nameZh: '包/袋',
          nameRu: 'Сумка',
          attributes: [
            ozonSystemTypeAttribute,
            { id: 85, name: 'Бренд', nameRu: 'Бренд', nameZh: '品牌', description: '', type: 'String', required: true, dictionaryId: 28732849, maxCount: 1, groupId: 0, groupName: '', complexId: 0, isCollection: false },
            { id: 9024, name: 'Код продавца', nameRu: 'Код продавца', nameZh: '卖家代码', description: '', type: 'String', required: false, dictionaryId: 0, maxCount: 1, groupId: 0, groupName: '', complexId: 0, isCollection: false },
            ozonRussianSizeAttribute,
            { id: 10097, name: 'Название цвета', nameRu: 'Название цвета', nameZh: '颜色名称', description: '', type: 'String', required: false, dictionaryId: 0, maxCount: 1, groupId: 0, groupName: '', complexId: 0, isCollection: false }
          ]
        }
      }
    };
    const listing = {
      ...editableListing,
      activeJob: undefined,
      data: {
        ...editableListing.data,
        categoryKey: category.categoryKey,
        categoryVersionId: category.publishedVersion.id,
        brand: '无品牌',
        sharedAttributes: [
          { attributeId: 8229, complexId: 0, values: [{ value: '0000049' }] },
          { attributeId: 85, complexId: 0, values: [{ value: '无品牌' }] },
          { attributeId: 9024, complexId: 0, values: [{ value: '0000049' }] }
        ],
        offers: [{
          variantId: '55555555-5555-4555-8555-555555555551',
          variantCode: '01',
          offerId: '0000049-01',
          barcode: '',
          modelGroup: '0000049',
          price: 385.33,
          oldPrice: 770.65,
          minPrice: 192.66,
          stock: 18,
          attributes: [{ attributeId: 4298, complexId: 0, values: [{ dictionaryValueId: 35 }] }],
          media: []
        }]
      }
    };
    await page.route(/\/api\/v1\/ozon\/categories$/, (route) => route.fulfill({ json: { items: [category] } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000049$/, async (route) => {
      if (route.request().method() === 'PUT') {
        saved = route.request().postDataJSON();
        return route.fulfill({ json: { listing: { ...listing, rowVersion: 6, revision: 6, data: saved } } });
      }
      return route.fulfill({ json: { listing, canManualTakeover: false } });
    });
    await page.route(/\/api\/v1\/ozon\/listings(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [listing], total: 1, page: 1, pageSize: 100 } }));

    await page.goto('/listing/ozon?view=manual');
    await page.getByRole('button', { name: '打开工作台' }).click();
    const drawer = page.getByRole('dialog', { name: /0000049/ });
    const typeInput = drawer.getByRole('textbox', { name: 'OZON 类目类型（系统只读）' });
    const typeField = typeInput.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-form-item ")][1]');
    const brandField = drawer.locator('.ant-form-item').filter({ hasText: '品牌' }).filter({ has: page.locator('.ozon-preset-attribute-label') }).first();
    await expect(typeInput).toHaveValue('包/袋 / Сумка');
    await expect(typeInput).toHaveAttribute('readonly');
    await expect(typeField).toContainText('系统只读');
    await expect(typeField).not.toContainText('#8229');
    await expect(typeField).not.toContainText('dict:');
    await expect(drawer).not.toContainText('新建草稿默认显示 MerchRoute SKU');
    await expect(brandField.getByRole('textbox')).toHaveValue('无品牌');
    const variant = drawer.locator('.ozon-variant-panel').first();
    await expect(variant.getByRole('spinbutton', { name: '上架价' })).toHaveValue('385.33');
    await expect(variant.getByRole('spinbutton', { name: '划线价' })).toHaveValue('770.65');
    await expect(variant.getByRole('spinbutton', { name: '最低价' })).toHaveValue('192.66');
    await expect(variant.getByRole('spinbutton', { name: '默认库存' })).toHaveValue('18');
    await variant.getByRole('button', { name: '显示所有' }).click();
    const colorName = variant.locator('.ant-form-item').filter({ hasText: '颜色名称' }).first();
    await colorName.locator('.ant-select').click();
    await page.locator('.ant-select-item-option-content').filter({ hasText: '黑色 / Черный' }).click();
    await drawer.getByRole('button', { name: '保存草稿' }).click();

    await expect.poll(() => saved).toBeTruthy();
    const savedType = saved.sharedAttributes.find((attribute: any) => attribute.attributeId === 8229);
    expect(savedType).toEqual({
      attributeId: 8229,
      complexId: 0,
      values: [{ dictionaryValueId: category.typeId }]
    });
    expect(JSON.stringify(savedType)).not.toContain('0000049');
    expect(saved.offers[0]).toMatchObject({ price: 385.33, oldPrice: 770.65, minPrice: 192.66, stock: 18 });
    expect(saved.offers[0].attributes).toEqual(expect.arrayContaining([
      { attributeId: 10097, complexId: 0, values: [{ value: 'Черный' }] }
    ]));
  });

  test.skip('四类 OZON 本地双语字典可用于手动资料和预设共享字段', async ({ page }) => {
    await page.route(/\/api\/v1\/ozon\/categories$/, (route) => route.fulfill({ json: { items: [presetCategory] } }));
    await page.route(/\/api\/v1\/ozon\/listings\/0000051$/, (route) => route.fulfill({ json: { listing: {
      ...publishedListing,
      data: {
        categoryKey: presetCategory.categoryKey,
        categoryVersionId: presetCategory.publishedVersion.id,
        fulfillmentMode: 'FBS', warehouseId: '', currency: 'RUB', vat: '0.2', titleRu: '', descriptionRu: '', brand: '',
        dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 800, weightUnit: 'g' },
        sharedAttributes: [], offers: [], mediaSourceRoot: ''
      }
    } } }));

    await page.goto('/listing/ozon?view=manual');
    await page.getByRole('button', { name: '打开工作台' }).click();
    const listingDrawer = page.getByRole('dialog', { name: /0000051/ });
    await listingDrawer.getByRole('button', { name: '显示所有' }).click();
    const countryField = listingDrawer.locator('.ant-form-item').filter({ hasText: '原产国' }).first();
    await expect(countryField).toContainText('Страна-изготовитель');
    await countryField.locator('.ant-select').click();
    await expect(page.locator('.ant-select-item-option-content').filter({ hasText: '中国 / Китай' })).toBeVisible();
    await page.locator('.ant-select-item-option-content').filter({ hasText: '中国 / Китай' }).click();
    await expect(countryField.locator('.ant-select-selection-item').filter({ hasText: '中国 / Китай' })).toBeVisible();
    await listingDrawer.locator('.ant-drawer-close').click();

    await page.getByRole('tab', { name: /上品预设模板/ }).click();
    await page.getByRole('button', { name: '新建上品预设' }).click();
    const presetDrawer = page.getByRole('dialog', { name: '新建 OZON 上品预设模板' });
    await presetDrawer.getByLabel('OZON 类目模板').click();
    await page.locator('.ant-select-item-option-content').filter({ hasText: '双肩背包' }).click();
    const colorField = presetDrawer.locator('.ant-form-item').filter({ hasText: '商品颜色' }).first();
    await expect(colorField).toContainText('Цвет товара');
    await colorField.locator('.ant-select').click();
    await expect(page.locator('.ant-select-item-option-content').filter({ hasText: '黑色 / Черный' })).toBeVisible();
    await page.locator('.ant-select-item-option-content').filter({ hasText: '黑色 / Черный' }).click();
    await expect(colorField.locator('.ant-select-selection-item')).toContainText('黑色 / Черный');
  });

  test('OZON 预设只显示本平台定价链并从运费模板读取服务渠道', async ({ page }) => {
    const pricingId = '11111111-1111-4111-8111-111111111111';
    const shippingId = '22222222-2222-4222-8222-222222222222';
    await page.route(/\/api\/v1\/pricing\/templates$/, (route) => route.fulfill({ json: { items: [
      { id: pricingId, name: 'OZON平台默认定价', platformCode: 'OZON', platformName: 'OZON', active: true, publishedVersion: { id: 'p1', versionNo: 2, publishedAt: '2026-07-27T00:00:00Z' } },
      { id: '33333333-3333-4333-8333-333333333333', name: 'WB平台默认定价', platformCode: 'WB', platformName: 'Wildberries', active: true, publishedVersion: { id: 'p2', versionNo: 3, publishedAt: '2026-07-27T00:00:00Z' } }
    ] } }));
    await page.route(/\/api\/v1\/shipping\/templates$/, (route) => route.fulfill({ json: { items: [
      { id: shippingId, name: 'CEL OZON-rFBS', platformCode: 'OZON', scenarioCode: 'OZON_RFBS', templateType: 'OZON_RFBS', active: true, carrierCode: 'CEL', carrierName: 'CEL物流', carrierActive: true, publishedVersion: { id: 's1', versionNo: 2, publishedAt: '2026-07-27T00:00:00Z' } },
      { id: '44444444-4444-4444-8444-444444444444', name: 'CEL WB', platformCode: 'WB', scenarioCode: 'WB', templateType: 'WB', active: true, carrierCode: 'CEL', carrierName: 'CEL物流', carrierActive: true, publishedVersion: { id: 's2', versionNo: 4, publishedAt: '2026-07-27T00:00:00Z' } }
    ] } }));
    await page.route(new RegExp(`/api/v1/shipping/templates/${shippingId}$`), (route) => route.fulfill({ json: { template: {
      id: shippingId, name: 'CEL OZON-rFBS', platformCode: 'OZON', scenarioCode: 'OZON_RFBS', templateType: 'OZON_RFBS', active: true, carrierCode: 'CEL', carrierName: 'CEL物流', carrierActive: true,
      versions: [{ id: 's1', versionNo: 2, status: 'PUBLISHED', definition: { currency: 'CNY', schemaVersion: '1', salePriceCurrencyCode: 'RUB', services: [
        { code: 'CEL_RFBS_ECONOMY', name: 'CEL Economy', channel: '陆运经济', sortOrder: 10, rules: [] },
        { code: 'CEL_RFBS_EXPRESS', name: 'CEL Express', channel: '陆空特快', sortOrder: 20, rules: [] }
      ] }, createdAt: '2026-07-27T00:00:00Z', updatedAt: '2026-07-27T00:00:00Z', publishedAt: '2026-07-27T00:00:00Z' }]
    } } }));
    await page.route(/\/api\/v1\/ozon\/categories$/, (route) => route.fulfill({ json: { items: [presetCategory] } }));

    await page.goto('/listing/ozon?view=presets');
    await page.getByRole('button', { name: '新建上品预设' }).click();
    const drawer = page.getByRole('dialog', { name: '新建 OZON 上品预设模板' });
    await expect(drawer.getByLabel('预设名称')).toBeVisible();
    await expect(drawer.getByText('店铺绑定及发布策略请在 OZON上品设置中管理', { exact: true })).toBeVisible();
    await expect(drawer.getByText('新草稿默认', { exact: true })).toHaveCount(0);
    await expect(drawer.getByLabel('自动上品策略')).toHaveCount(0);
    await expect(drawer.getByText('定价链与包装预设')).toBeVisible();
    await expect(drawer.getByText('采购毛重优先，预设毛重仅兜底', { exact: true })).toBeVisible();
    await expect(drawer.getByRole('spinbutton', { name: '兜底毛重 (g)' })).toBeVisible();
    await expect(drawer.getByRole('textbox', { name: '重量单位' })).toHaveValue('g');
    await expect(drawer.getByRole('textbox', { name: '重量单位' })).toHaveAttribute('readonly');
    await expect(drawer.getByText('商品资料默认值')).toBeVisible();
    await expect(drawer.getByText('固定使用一个 E004 MP4')).toBeVisible();
    await expect(drawer.getByLabel('产品视频只读用途').getByText('产品介绍视频', { exact: true })).toBeVisible();
    await expect(drawer.getByLabel('产品视频只读用途').getByText('视频封面', { exact: true })).toBeVisible();
    await expect(drawer.getByText('俄文标题与商品详情')).toBeVisible();
    await expect(drawer.getByText('OZON 类目字段')).toBeVisible();
    await expect(drawer.getByText('尺码与默认库存')).toBeVisible();
    await expect(drawer.getByLabel('翻译工作流 ID')).toHaveValue('HDh0ZNLK2ps5qasR');
    await expect(drawer.getByLabel('目标语言')).toHaveValue('俄文');
    await expect(drawer.getByLabel('标题最大长度')).toHaveValue('200');
    await drawer.getByLabel('OZON 类目模板').click();
    await page.locator('.ant-select-item-option-content').filter({ hasText: '双肩背包' }).click();
    const categoryType = drawer.getByRole('textbox', { name: 'OZON 类目类型（系统只读）' });
    const categoryTypeField = categoryType.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-form-item ")][1]');
    await expect(categoryType).toHaveValue('双肩背包 / Рюкзаки');
    await expect(categoryType).toHaveAttribute('readonly');
    await expect(categoryTypeField).toContainText('系统只读');
    await expect(categoryTypeField).not.toContainText('#8229');
    await expect(categoryTypeField).not.toContainText('dict:');
    await expect(drawer.getByText('当前类目支持产品介绍视频与视频封面')).toBeVisible();
    await expect(drawer.getByText('材质')).toBeVisible();
    await expect(drawer.getByText('Материал')).toBeVisible();
    const categorySizing = drawer.getByLabel('类目尺码规则');
    await expect(categorySizing).toHaveValue('俄罗斯尺码 / Российский размер · #4298');
    await expect(categorySizing).toHaveAttribute('readonly');
    await expect(drawer.getByText('当前类目按尺码生成 Offer', { exact: true })).toBeVisible();
    await expect(drawer.getByRole('button', { name: '添加尺码' })).toBeVisible();
    await drawer.getByLabel('默认定价模板').click();
    await expect(page.locator('.ant-select-item-option-content').filter({ hasText: 'OZON平台默认定价' })).toBeVisible();
    await expect(page.locator('.ant-select-item-option-content').filter({ hasText: 'WB平台默认定价' })).toHaveCount(0);
    await page.locator('.ant-select-item-option-content').filter({ hasText: 'OZON平台默认定价' }).click();
    await drawer.getByLabel('默认运费模板').click();
    await expect(page.locator('.ant-select-item-option-content').filter({ hasText: 'CEL OZON-rFBS' })).toBeVisible();
    await expect(page.locator('.ant-select-item-option-content').filter({ hasText: 'CEL WB' })).toHaveCount(0);
    await page.locator('.ant-select-item-option-content').filter({ hasText: 'CEL OZON-rFBS' }).click();
    const serviceSelector = drawer.getByLabel('服务渠道').locator('xpath=ancestor::*[contains(@class, "ant-select-selector")]');
    await serviceSelector.click();
    await expect(page.locator('.ant-select-item-option-content').filter({ hasText: 'CEL Economy' })).toBeVisible();
    await page.locator('.ant-select-item-option-content').filter({ hasText: 'CEL Economy' }).click();
    await expect(serviceSelector.locator('.ant-select-selection-item')).toContainText('CEL Economy');
    await page.setViewportSize({ width: 320, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(drawer.getByText('尺码与默认库存')).toBeVisible();
  });

  test('OZON 运动鞋预设继承类目 #4298 并保存逐尺码默认库存', async ({ page }) => {
    let savedPresetBody: any;
    await routeOzonSizingPresetEditor(page, [sportsShoePresetCategory, sizelessPresetCategory], (body) => { savedPresetBody = body; });

    await page.goto('/listing/ozon?view=presets');
    const presetRow = page.locator('.ozon-preset-table-shell tbody tr[data-row-key]').filter({ hasText: sizingPreset.name });
    await presetRow.getByRole('button', { name: '编辑' }).click();
    const drawer = page.getByRole('dialog', { name: sizingPreset.name });
    const brandField = drawer.locator('.ant-form-item').filter({ hasText: '服装和鞋类品牌' }).first();
    const genderField = drawer.locator('.ant-form-item').filter({ hasText: '性别' }).first();
    const mergeCardField = drawer.locator('.ant-form-item').filter({ hasText: '合并至一张卡片' }).first();
    const productColorField = drawer.locator('.ant-form-item').filter({ hasText: '商品颜色' }).first();
    const materialField = drawer.locator('.ant-form-item').filter({ hasText: '材质' }).first();
    const optionalPdfField = drawer.locator('.ant-form-item').filter({ hasText: 'PDF文件名称' }).first();
    for (const requiredField of [brandField, genderField, mergeCardField, productColorField, materialField]) {
      await expect(requiredField.locator('.ant-form-item-label > label')).toHaveClass(/ant-form-item-required/);
    }
    await expect(optionalPdfField.locator('.ant-form-item-label > label')).not.toHaveClass(/ant-form-item-required/);
    await expect(brandField.getByRole('textbox', { name: '服装和鞋类品牌（系统自动生成）' })).toHaveValue('无品牌（系统自动生成） / Нет бренда');
    await expect(brandField.getByRole('textbox')).toHaveAttribute('readonly');
    await expect(brandField).toContainText('系统自动生成');
    await expect(mergeCardField.getByRole('textbox', { name: '合并至一张卡片（系统自动生成）' })).toHaveValue('主 SKU（系统自动生成） / Основной SKU');
    await expect(mergeCardField.getByRole('textbox')).toHaveAttribute('readonly');
    await expect(productColorField.getByRole('textbox', { name: '商品颜色（自动取值）' })).toHaveValue('来自 E001 审核颜色 / Цвет из E001');
    await expect(productColorField.getByRole('textbox')).toHaveAttribute('readonly');
    await expect(productColorField).toContainText('E001 自动取值');
    await expect(genderField.locator('.ant-select-selection-item')).toContainText('男士 / Мужской');
    const categorySizing = drawer.getByLabel('类目尺码规则');
    const categorySizingField = categorySizing.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " ant-form-item ")][1]');
    await expect(categorySizing).toHaveValue('俄罗斯尺码 / Российский размер · #4298');
    await expect(categorySizing).toHaveAttribute('readonly');
    await expect(categorySizingField).toContainText('俄罗斯尺码');
    await expect(categorySizingField).toContainText('Российский размер · #4298');
    await expect(categorySizingField.locator('.ant-form-item-label > label')).toHaveClass(/ant-form-item-required/);
    await expect(drawer.getByText('当前类目按尺码生成 Offer', { exact: true })).toBeVisible();
    await expect(drawer.getByLabel('OZON 尺码属性')).toHaveCount(0);
    await expect(drawer.getByText(/3 个颜色 × 11 个尺码 =/)).toBeVisible();
    await expect(drawer.getByText('33 个 Offer', { exact: true })).toBeVisible();

    await genderField.locator('.ant-select').hover();
    await genderField.locator('.ant-select-clear').click();
    await drawer.getByRole('button', { name: '保存修改' }).click();
    await expect(genderField).toContainText('性别 / Пол · #9163 为 OZON 必填目录属性');
    expect(savedPresetBody).toBeUndefined();
    await genderField.locator('.ant-select-selector').click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '男士 / Мужской' }).click();

    const sizeRows = drawer.locator('.ozon-preset-size-row');
    await expect(sizeRows).toHaveCount(11);
    await expect(sizeRows.nth(0).locator('.ant-select-selection-item')).toContainText('36');
    await expect(sizeRows.nth(0).getByRole('spinbutton', { name: '默认库存' })).toHaveValue('1');
    await expect(sizeRows.nth(10).locator('.ant-select-selection-item')).toContainText('46');
    await expect(sizeRows.nth(10).getByRole('spinbutton', { name: '默认库存' })).toHaveValue('1');
    await drawer.getByRole('button', { name: '保存修改' }).click();

    await expect.poll(() => savedPresetBody).toBeTruthy();
    expect(savedPresetBody).toMatchObject({
      categoryKey: sportsShoePresetCategory.categoryKey,
      sizeAttributeKey: '4298:0',
      defaultStock: 1,
      rowVersion: sizingPreset.rowVersion,
      sizes: sizingPreset.sizes
    });
    expect(savedPresetBody.sizes).toHaveLength(11);
    expect(savedPresetBody.sizes.map((size: any) => size.sizeId)).toEqual(sizingPreset.sizes.map((size) => size.sizeId));
    expect(savedPresetBody.sharedAttributes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ attributeId: 4298 })
    ]));
    expect(savedPresetBody.variantAttributes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ attributeId: 4298 })
    ]));
    expect(savedPresetBody.sharedAttributes).toEqual(expect.arrayContaining([
      { attributeId: 10, complexId: 0, values: [{ value: '网布' }] },
      { attributeId: 9163, complexId: 0, values: [{ dictionaryValueId: 22880 }] }
    ]));
    expect(savedPresetBody.sharedAttributes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ attributeId: 31 }),
      expect.objectContaining({ attributeId: 8292 }),
      expect.objectContaining({ attributeId: 10096 })
    ]));
    await expect(drawer).toBeHidden();
  });

  test('类目属性重新发布为必填后预设立即显示红星并阻止空值保存', async ({ page }) => {
    let savedPresetBody: any;
    const initialCategory = structuredClone(sportsShoePresetCategory);
    initialCategory.publishedVersion.snapshot.attributes = initialCategory.publishedVersion.snapshot.attributes.map((attribute) => (
      attribute.id === ozonPdfNameAttribute.id ? { ...attribute, required: false } : attribute
    ));
    const routedCategories: any[] = [initialCategory];
    await routeOzonSizingPresetEditor(page, routedCategories, (body) => { savedPresetBody = body; });
    await page.route(new RegExp(`/api/v1/ozon/categories/${initialCategory.categoryKey}/refresh$`), (route) => {
      const current = routedCategories[0];
      const refreshed = {
        ...current,
        rowVersion: current.rowVersion + 1,
        draftVersion: {
          ...current.publishedVersion,
          id: '99999999-8888-4777-8666-555555555555',
          versionNo: current.publishedVersion.versionNo + 1,
          status: 'DRAFT',
          snapshot: {
            ...current.publishedVersion.snapshot,
            attributes: current.publishedVersion.snapshot.attributes.map((attribute: any) => (
              attribute.id === ozonPdfNameAttribute.id ? { ...attribute, required: true } : attribute
            ))
          }
        }
      };
      routedCategories[0] = refreshed;
      return route.fulfill({ json: { category: refreshed } });
    });
    await page.route(new RegExp(`/api/v1/ozon/categories/${initialCategory.categoryKey}/publish$`), (route) => {
      const current = routedCategories[0];
      const published = {
        ...current,
        rowVersion: current.rowVersion + 1,
        draftVersion: undefined,
        publishedVersion: { ...current.draftVersion, status: 'PUBLISHED' }
      };
      routedCategories[0] = published;
      return route.fulfill({ json: { category: published } });
    });

    await page.goto('/listing/ozon?view=presets');
    const presetRow = page.locator('.ozon-preset-table-shell tbody tr[data-row-key]').filter({ hasText: sizingPreset.name });
    await presetRow.getByRole('button', { name: '编辑' }).click();
    let drawer = page.getByRole('dialog', { name: sizingPreset.name });
    let pdfNameField = drawer.locator('.ant-form-item').filter({ hasText: 'PDF文件名称' }).first();
    await expect(pdfNameField.locator('.ant-form-item-label > label')).not.toHaveClass(/ant-form-item-required/);
    await drawer.locator('.ant-drawer-close').click();

    await page.getByRole('tab', { name: '类目模板' }).click();
    const categoryRow = page.locator('tbody tr[data-row-key]').filter({ hasText: initialCategory.nameZh });
    await categoryRow.getByRole('button', { name: '刷新' }).click();
    await expect(page.getByText('运动鞋 已刷新为新草稿版本', { exact: true })).toBeVisible();
    await expect(categoryRow).toContainText(`v${initialCategory.publishedVersion.versionNo + 1}`);
    await categoryRow.getByRole('button', { name: /发\s*布/ }).click();
    await expect(page.getByText('类目模板版本已发布', { exact: true })).toBeVisible();

    await page.getByRole('tab', { name: '上品预设模板' }).click();
    await presetRow.getByRole('button', { name: '编辑' }).click();
    drawer = page.getByRole('dialog', { name: sizingPreset.name });
    pdfNameField = drawer.locator('.ant-form-item').filter({ hasText: 'PDF文件名称' }).first();
    await expect(pdfNameField.locator('.ant-form-item-label > label')).toHaveClass(/ant-form-item-required/);
    await drawer.getByRole('button', { name: '保存修改' }).click();
    await expect(pdfNameField).toContainText('PDF文件名称 / Название файла PDF · #8789 为 OZON 必填目录属性');
    expect(savedPresetBody).toBeUndefined();
  });

  test('OZON 预设切换到无尺码类目时清空鞋码并只保留单库存行', async ({ page }) => {
    let savedPresetBody: any;
    await routeOzonSizingPresetEditor(page, [sportsShoePresetCategory, sizelessPresetCategory], (body) => { savedPresetBody = body; });

    await page.goto('/listing/ozon?view=presets');
    const presetRow = page.locator('.ozon-preset-table-shell tbody tr[data-row-key]').filter({ hasText: sizingPreset.name });
    await presetRow.getByRole('button', { name: '编辑' }).click();
    const drawer = page.getByRole('dialog', { name: sizingPreset.name });
    const categoryField = drawer.locator('.ant-form-item').filter({ hasText: 'OZON 类目模板' }).first();
    await categoryField.locator('.ant-select-selector').click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: '无尺码配件' }).click();

    await expect(drawer.getByText('当前类目为无尺码商品', { exact: true })).toBeVisible();
    await expect(drawer.getByRole('button', { name: '添加尺码' })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: '删除' })).toHaveCount(0);
    await drawer.locator('.ant-form-item').filter({ hasText: '材质' }).first().getByRole('textbox').fill('涤纶');
    const sizeRows = drawer.locator('.ozon-preset-size-row');
    await expect(sizeRows).toHaveCount(1);
    await expect(sizeRows.getByRole('combobox', { name: '尺码值' })).toHaveCount(0);
    await sizeRows.getByRole('spinbutton', { name: '默认库存' }).fill('9');

    await page.setViewportSize({ width: 320, height: 900 });
    await expect(drawer.getByText('尺码与默认库存', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await drawer.getByRole('button', { name: '保存修改' }).click();

    await expect.poll(() => savedPresetBody).toBeTruthy();
    expect(savedPresetBody).toMatchObject({
      categoryKey: sizelessPresetCategory.categoryKey,
      defaultStock: 9,
      rowVersion: sizingPreset.rowVersion,
      sizes: [{ value: '', stock: 9 }],
      variantAttributes: []
    });
    expect(savedPresetBody.sharedAttributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ attributeId: 8229, complexId: 0, values: [{ dictionaryValueId: sizelessPresetCategory.typeId }] }),
      { attributeId: 10, complexId: 0, values: [{ value: '涤纶' }] }
    ]));
    expect(savedPresetBody.sharedAttributes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ attributeId: 4298 })
    ]));
    expect(savedPresetBody).not.toHaveProperty('sizeAttributeKey');
    expect(savedPresetBody.sizes[0].sizeId).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(drawer).toBeHidden();
  });

  test('已进入远程阶段的迁移前任务保留工作台详情，新的提交入口改走 publication 计划', async ({ page }) => {
    const blockingJob = {
      ...waitingAutoJob,
      id: '44444444-4444-4444-8444-444444444444',
      state: 'IMPORTING',
      source: 'MANUAL',
      taskId: 'n8n-task-0000049',
      importTaskId: 'ozon-import-0000049',
      updatedAt: '2026-07-28T10:05:00.000Z'
    };
    await page.route(/\/api\/v1\/ozon\/.*/, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/v1/ozon/system') return route.fulfill({ json: readyReadiness });
      if (path === '/api/v1/ozon/categories') return route.fulfill({ json: { items: [presetCategory] } });
      if (path === '/api/v1/ozon/listings') return route.fulfill({ json: { items: [editableListing], total: 1, page: 1, pageSize: 100 } });
      if (path === '/api/v1/ozon/listings/0000049') return route.fulfill({ json: { listing: editableListing, activeJob: blockingJob, canManualTakeover: false } });
      if (path === '/api/v1/ozon/listings/0000049/jobs') return route.fulfill({ json: { items: [blockingJob], total: 1, page: 1, pageSize: 100 } });
      if (path === `/api/v1/ozon/listings/0000049/jobs/${blockingJob.id}`) return route.fulfill({ json: { job: blockingJob } });
      return route.fallback();
    });

    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto('/listing/ozon?view=manual');
    await page.getByRole('button', { name: '打开工作台' }).click();
    const drawer = page.getByRole('dialog', { name: /0000049/ });
    await expect(drawer.getByText('该 SKU 已有进行中的 OZON 上品任务')).toBeVisible();
    await expect(drawer.getByRole('button', { name: '选择店铺并提交' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: '提交到 OZON' })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await drawer.getByRole('button', { name: '查看手动任务', exact: true }).click();
    await expect(page).toHaveURL(/view=manual/);
    expect(page.url()).not.toContain('job=');
    const jobDrawer = page.getByRole('dialog', { name: '手动任务详情 · 0000049' });
    await expect(jobDrawer.getByText('ozon-import-0000049')).toBeVisible();
  });

  test.skip('迁移前结果保持只读展示且不再触发 SKU 级平台刷新', async ({ page }) => {
    const refreshedAt = '2026-08-06T03:24:18.000Z';
    const offerIds = ['0000051-01', '0000051-02'];
    const platformLinks = [
      {
        offerId: offerIds[0],
        ozonProductId: '5686268830',
        ozonSku: productOzonSku,
        url: productUrl,
        displayState: 'MODERATING',
        businessState: 'MODERATING',
        platformMessage: 'На модерации',
        warnings: ['主图仍在平台处理'],
        lastVerifiedAt: refreshedAt
      },
      {
        offerId: offerIds[1],
        ozonProductId: '5686268831',
        ozonSku: secondProductOzonSku,
        url: secondProductUrl,
        displayState: 'OUT_OF_STOCK',
        businessState: 'NEEDS_ATTENTION',
        platformMessage: 'Нет на складе',
        warnings: ['OZON 当前可售库存为 0'],
        lastVerifiedAt: refreshedAt
      }
    ];
    const listing = {
      ...editableListing,
      sku: '0000051',
      productName: '复古斜挎包',
      status: 'MODERATING',
      rowVersion: 3,
      revision: 3,
      data: {
        ...editableListing.data,
        categoryKey: presetCategory.categoryKey,
        categoryVersionId: presetCategory.publishedVersion.id,
        offers: offerIds.map((offerId, index) => ({
          variantId: `${index + 1}1111111-1111-4111-8111-111111111111`,
          variantCode: `0${index + 1}`,
          offerId,
          barcode: '',
          modelGroup: '0000051',
          price: 420.21,
          stock: 1,
          attributes: [],
          media: []
        }))
      },
      ozonProductLinks: platformLinks
    };
    const manualJob = {
      ...successfulJob,
      source: 'MANUAL',
      sku: listing.sku,
      offerIds,
      ozonProductLinks: platformLinks
    };
    let legacyRefreshCalls = 0;
    await page.route(/\/api\/v1\/ozon\/.*/, async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const method = route.request().method();
      if (path === '/api/v1/ozon/system') return route.fulfill({ json: readyReadiness });
      if (path === '/api/v1/ozon/categories') return route.fulfill({ json: { items: [presetCategory] } });
      if (path === '/api/v1/ozon/presets') return route.fulfill({ json: { items: [] } });
      if (path === '/api/v1/ozon/listings' && method === 'GET') return route.fulfill({ json: { items: [listing], total: 1, page: 1, pageSize: 100 } });
      if (path === '/api/v1/ozon/listings/0000051' && method === 'GET') return route.fulfill({ json: { listing, canManualTakeover: false } });
      if (path === '/api/v1/ozon/listings/0000051/platform-status/refresh' && method === 'POST') {
        legacyRefreshCalls += 1;
        return route.abort();
      }
      if (path === '/api/v1/ozon/listings/0000051/jobs') return route.fulfill({ json: { items: [manualJob], total: 1, page: 1, pageSize: 100 } });
      if (path === `/api/v1/ozon/listings/0000051/jobs/${manualJob.id}`) return route.fulfill({ json: { job: manualJob } });
      return route.fallback();
    });

    await page.goto('/listing/ozon?view=manual');
    const manualTable = page.locator('.ozon-manual-table');
    await expect(manualTable.getByText('正在上品', { exact: true })).toBeVisible();
    await expect(manualTable.getByRole('button', { name: '刷新 OZON 状态' })).toHaveCount(0);
    const compactLedger = manualTable.getByLabel('迁移前 OZON 商品链接，共 2 个变体');
    await expect(compactLedger.getByText('审核中', { exact: true })).toBeVisible();
    await expect(compactLedger.getByText('缺货', { exact: true })).toBeVisible();

    await manualTable.getByRole('button', { name: '打开工作台' }).click();
    const workspace = page.getByRole('dialog', { name: /0000051/ });
    const ledger = workspace.getByLabel('迁移前默认店铺的 OZON 平台结果，共 2 个变体');
    await expect(ledger).toContainText(offerIds[0]);
    await expect(ledger).toContainText(offerIds[1]);
    await expect(ledger).toContainText('На модерации');
    await expect(ledger).toContainText('OZON 当前可售库存为 0');
    await expect(ledger).toContainText(formatShanghaiTime(refreshedAt));
    await expect(workspace.getByRole('button', { name: '刷新 OZON 状态' })).toHaveCount(0);

    await workspace.getByRole('button', { name: '查看详情' }).click();
    const jobDrawer = page.getByRole('dialog', { name: '手动任务详情 · 0000051' });
    await expect(jobDrawer.getByLabel('该任务的迁移前平台结果，共 2 个变体')).toContainText('缺货');
    await expect(jobDrawer.getByRole('button', { name: '刷新 OZON 状态' })).toHaveCount(0);
    expect(legacyRefreshCalls).toBe(0);

    await page.setViewportSize({ width: 320, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test.skip('手动历史 RUB 草稿显示服务端 CNY 投影并可直接保存为新修订', async ({ page }) => {
    let saved: any;
    const listing = {
      ...editableListing,
      status: 'PUBLISHED',
      data: {
        ...editableListing.data,
        currency: 'RUB',
        sharedAttributes: [{ attributeId: 10, complexId: 0, values: [{ value: 'Текстиль' }] }],
        offers: [{
          variantId: '12912912-9129-4129-8129-129129129129', variantCode: '01', offerId: '0000049-01',
          barcode: '', modelGroup: '0000049', price: 7425, oldPrice: 14850, minPrice: 3712.5,
          stock: 8, descriptionRu: 'Описание', attributes: [{ attributeId: 4298, complexId: 0, values: [{ dictionaryValueId: 35 }] }], media: []
        }]
      }
    };
    const priceProjection = {
      status: 'RECALCULATED', sourceCurrency: 'RUB', targetCurrency: 'CNY', pendingSave: true,
      offers: [{ offerId: '0000049-01', price: 675, oldPrice: 1350, minPrice: 337.5 }]
    };
    await page.route(/\/api\/v1\/ozon\/.*/, async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (path === '/api/v1/ozon/system') return route.fulfill({ json: readyReadiness });
      if (path === '/api/v1/ozon/categories') return route.fulfill({ json: { items: [presetCategory] } });
      if (path === '/api/v1/ozon/listings' && method === 'GET') return route.fulfill({ json: { items: [listing], total: 1, page: 1, pageSize: 100 } });
      if (path === '/api/v1/ozon/listings/0000049' && method === 'GET') return route.fulfill({ json: { listing, priceProjection, canManualTakeover: false } });
      if (path === '/api/v1/ozon/listings/0000049' && method === 'PUT') {
        saved = route.request().postDataJSON();
        return route.fulfill({ json: { listing: { ...listing, rowVersion: 6, revision: 6, data: saved } } });
      }
      return route.fallback();
    });

    await page.goto('/listing/ozon?view=manual');
    await page.getByRole('button', { name: '打开工作台' }).click();
    const drawer = page.getByRole('dialog', { name: /0000049/ });
    await expect(drawer.getByText('历史价格已按人民币 CNY 重新计算', { exact: true })).toBeVisible();
    const price = drawer.getByRole('spinbutton', { name: '上架价' });
    await expect(price).toHaveValue('675');
    await expect(price.locator('xpath=ancestor::div[contains(@class,"ant-form-item")][1]')).toContainText('CNY');
    const save = drawer.getByRole('button', { name: '保存草稿' });
    await expect(save).toBeEnabled();
    await save.click();
    await expect.poll(() => saved).toBeTruthy();
    expect(saved.currency).toBe('CNY');
    expect(saved.offers[0]).toMatchObject({ offerId: '0000049-01', price: 675, oldPrice: 1350, minPrice: 337.5 });
  });

  test.skip('手动价格投影不可用时不把 RUB 原值冒充 CNY 并阻止保存', async ({ page }) => {
    const listing = {
      ...editableListing,
      status: 'PUBLISHED',
      data: {
        ...editableListing.data,
        currency: 'RUB',
        offers: [{
          variantId: '13213213-2132-4132-8132-132132132132', variantCode: '01', offerId: '0000049-01',
          barcode: '', modelGroup: '0000049', price: 7425, stock: 8,
          descriptionRu: 'Описание', attributes: [], media: []
        }]
      }
    };
    await page.route(/\/api\/v1\/ozon\/.*/, async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (path === '/api/v1/ozon/system') return route.fulfill({ json: readyReadiness });
      if (path === '/api/v1/ozon/categories') return route.fulfill({ json: { items: [presetCategory] } });
      if (path === '/api/v1/ozon/listings' && method === 'GET') return route.fulfill({ json: { items: [listing], total: 1, page: 1, pageSize: 100 } });
      if (path === '/api/v1/ozon/listings/0000049' && method === 'GET') return route.fulfill({ json: {
        listing,
        priceProjection: { status: 'UNAVAILABLE', sourceCurrency: 'RUB', targetCurrency: 'CNY', pendingSave: false, offers: [], reason: '冻结定价版本不存在' },
        canManualTakeover: false
      } });
      return route.fallback();
    });

    await page.goto('/listing/ozon?view=manual');
    await page.getByRole('button', { name: '打开工作台' }).click();
    const drawer = page.getByRole('dialog', { name: /0000049/ });
    await expect(drawer.getByText('账户币种价格暂不可用', { exact: true })).toBeVisible();
    await expect(drawer.getByText(/冻结定价版本不存在/)).toBeVisible();
    await expect(drawer.getByRole('spinbutton', { name: '上架价' })).toHaveValue('');
    await expect(drawer.getByRole('spinbutton', { name: '上架价' })).not.toHaveValue('7425');
    await expect(drawer.getByRole('button', { name: '保存草稿' })).toBeDisabled();
  });

  test('自动任务只读核对冻结店铺币种价格且不依赖共享草稿', async ({ page }) => {
    const job = {
      ...successfulJob,
      id: '12912912-9129-4129-8129-129129129120', sku: '0000129',
      storeId: readyStoreA.id, storeAlias: readyStoreA.storeAlias,
      publicationId: 'publication-0000129', revision: 2,
      payload: { mode: 'MULTISTORE_PUBLICATION', revision: 2 }
    };
    const frozenListing = {
      ...editableListing,
      sku: job.sku, productName: '自动冻结币种测试商品', status: 'PUBLISHED', revision: 2, rowVersion: 2,
      generatedVersionId: 'generated-0000129-r2',
      data: {
        ...editableListing.data,
        currency: 'RUB', mediaSourceRoot: '',
        offers: [{
          variantId: '12912912-9129-4129-8129-129129129121', variantCode: '01', offerId: '0000129-01',
          barcode: '', modelGroup: '0000129', price: 7425, oldPrice: 14850, minPrice: 3712.5,
          stock: 8, descriptionRu: 'Описание', attributes: [], media: []
        }]
      }
    };
    const writes: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/v1/ozon/') && request.method() !== 'GET') writes.push(`${request.method()} ${path}`);
    });
    await page.route(/\/api\/v1\/ozon\/.*/, async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path === '/api/v1/ozon/system') return route.fulfill({ json: readyReadiness });
      if (path === '/api/v1/ozon/categories') return route.fulfill({ json: { items: [presetCategory] } });
      if (path === '/api/v1/ozon/automation/status') return route.fulfill({ json: { ...readyAutomationStatus, counts: { SUCCEEDED: 1 } } });
      if (path === '/api/v1/ozon/automation/jobs') return route.fulfill({ json: { items: [job], total: 1, page: 1, pageSize: 20 } });
      if (path === `/api/v1/ozon/automation/jobs/${job.id}/listing-snapshot`) {
        expect(url.searchParams.get('storeId')).toBe(job.storeId);
        return route.fulfill({ json: { snapshot: {
          mode: 'AUTO_TASK_SNAPSHOT', readOnly: true, jobId: job.id, publicationId: job.publicationId,
          generatedVersionId: frozenListing.generatedVersionId, sku: job.sku, revision: 2,
          store: { id: job.storeId, storeAlias: job.storeAlias, displayName: 'OZON 主店', accountCurrency: 'CNY', accountCurrencyChanged: false },
          listing: frozenListing,
          pricing: { currency: 'CNY', offers: [{ offerId: '0000129-01', price: 675, oldPrice: 1350, minPrice: 337.5 }] }
        } } });
      }
      if (path === `/api/v1/ozon/automation/jobs/${job.id}`) return route.fulfill({ json: { job } });
      if (path === `/api/v1/ozon/listings/${job.sku}`) return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: '共享草稿不存在' } } });
      return route.fallback();
    });

    await page.goto('/listing/ozon');
    await page.locator('.ozon-automation-console tbody tr').filter({ hasText: job.sku }).getByRole('button', { name: '查看详情' }).click();
    const detail = page.getByRole('dialog', { name: /自动上品详情/ });
    await expect(detail.getByRole('button', { name: '打开上品资料' })).toBeEnabled();
    await detail.getByRole('button', { name: '打开上品资料' }).click();

    const drawer = page.getByRole('dialog', { name: new RegExp(job.sku) });
    await expect(drawer.getByText('账户币种 CNY', { exact: true })).toBeVisible();
    await expect(drawer.getByText('此处为店铺账户上品币种，与 OZON 买家端本地化显示币种无关。', { exact: true })).toBeVisible();
    const price = drawer.getByRole('spinbutton', { name: '上架价' });
    await expect(price).toHaveValue('675');
    await expect(price).toHaveAttribute('readonly');
    await expect(price).toBeEnabled();
    await expect(price.locator('xpath=ancestor::div[contains(@class,"ant-form-item")][1]')).toContainText('CNY');
    await expect(drawer.getByRole('textbox', { name: '俄文商品标题' })).toBeDisabled();
    await expect(drawer.getByRole('button', { name: '保存草稿' })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: '检查共享资料' })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: '选择店铺并提交' })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: '扫描 variants 目录' })).toHaveCount(0);
    expect(writes).toEqual([]);
  });

  test('同 SKU 不同店铺的自动冻结价格和币种不会串用', async ({ page }) => {
    const sku = '0000132';
    const jobCny = { ...successfulJob, id: '13213213-2132-4132-8132-132132132130', sku, storeId: readyStoreA.id, storeAlias: readyStoreA.storeAlias, publicationId: 'publication-132-cny', revision: 2 };
    const jobRub = { ...jobCny, id: '13213213-2132-4132-8132-132132132131', storeId: readyStoreB.id, storeAlias: readyStoreB.storeAlias, publicationId: 'publication-132-rub' };
    const listing = {
      ...editableListing,
      sku, productName: '同 SKU 多店币种测试', status: 'PUBLISHED', revision: 2, rowVersion: 2,
      generatedVersionId: 'generated-0000132-r2',
      data: {
        ...editableListing.data,
        mediaSourceRoot: '',
        offers: [{ variantId: 'offer-132', variantCode: '01', offerId: '0000132-01', barcode: '', modelGroup: sku, price: 999, stock: 1, descriptionRu: 'Описание', attributes: [], media: [] }]
      }
    };
    await page.route(/\/api\/v1\/ozon\/.*/, async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path === '/api/v1/ozon/system') return route.fulfill({ json: readyReadiness });
      if (path === '/api/v1/ozon/categories') return route.fulfill({ json: { items: [presetCategory] } });
      if (path === '/api/v1/ozon/automation/status') return route.fulfill({ json: { ...readyAutomationStatus, counts: { SUCCEEDED: 2 } } });
      if (path === '/api/v1/ozon/automation/jobs') return route.fulfill({ json: { items: [jobCny, jobRub], total: 2, page: 1, pageSize: 20 } });
      for (const [job, currency, price] of [[jobCny, 'CNY', 675], [jobRub, 'RUB', 7425]] as const) {
        if (path === `/api/v1/ozon/automation/jobs/${job.id}`) return route.fulfill({ json: { job } });
        if (path === `/api/v1/ozon/automation/jobs/${job.id}/listing-snapshot`) return route.fulfill({ json: { snapshot: {
          mode: 'AUTO_TASK_SNAPSHOT', readOnly: true, jobId: job.id, publicationId: job.publicationId,
          generatedVersionId: listing.generatedVersionId, sku, revision: 2,
          store: { id: job.storeId, storeAlias: job.storeAlias, displayName: currency === 'CNY' ? '人民币店' : '卢布店', accountCurrency: currency, accountCurrencyChanged: false },
          listing,
          pricing: { currency, offers: [{ offerId: '0000132-01', price }] }
        } } });
      }
      if (path === `/api/v1/ozon/listings/${sku}`) return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } });
      return route.fallback();
    });

    await page.goto(`/listing/ozon?job=${jobCny.id}&store=${jobCny.storeId}&listing=${sku}`);
    let drawer = page.getByRole('dialog', { name: new RegExp(sku) });
    await expect(drawer.getByText('账户币种 CNY', { exact: true })).toBeVisible();
    await expect(drawer.getByRole('spinbutton', { name: '上架价' })).toHaveValue('675');
    await expect(drawer.getByRole('spinbutton', { name: '上架价' }).locator('xpath=ancestor::div[contains(@class,"ant-form-item")][1]')).toContainText('CNY');

    await page.goto(`/listing/ozon?job=${jobRub.id}&store=${jobRub.storeId}&listing=${sku}`);
    drawer = page.getByRole('dialog', { name: new RegExp(sku) });
    await expect(drawer.getByText('账户币种 RUB', { exact: true })).toBeVisible();
    await expect(drawer.getByRole('spinbutton', { name: '上架价' })).toHaveValue('7425');
    await expect(drawer.getByRole('spinbutton', { name: '上架价' }).locator('xpath=ancestor::div[contains(@class,"ant-form-item")][1]')).toContainText('RUB');
    await expect(drawer).not.toContainText('账户币种 CNY');
  });

  test('自动冻结资料不可验证时显示错误且不回退任何价格', async ({ page }) => {
    const job = { ...successfulJob, id: '13313313-3133-4133-8133-133133133133', sku: '0000133', storeId: readyStoreA.id, publicationId: 'publication-133' };
    await page.route(/\/api\/v1\/ozon\/.*/, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/v1/ozon/automation/status') return route.fulfill({ json: { ...readyAutomationStatus, counts: { SUCCEEDED: 1 } } });
      if (path === '/api/v1/ozon/automation/jobs') return route.fulfill({ json: { items: [job], total: 1, page: 1, pageSize: 20 } });
      if (path === `/api/v1/ozon/automation/jobs/${job.id}`) return route.fulfill({ json: { job } });
      if (path === `/api/v1/ozon/automation/jobs/${job.id}/listing-snapshot`) return route.fulfill({
        status: 409,
        json: { error: { code: 'OZON_FROZEN_ARTIFACT_UNAVAILABLE', message: '冻结任务包稳定缺失，禁止回退共享草稿', details: { noFallback: true } } }
      });
      if (path === `/api/v1/ozon/listings/${job.sku}`) return route.fulfill({ json: { listing: { ...editableListing, sku: job.sku }, canManualTakeover: false } });
      return route.fallback();
    });

    await page.goto(`/listing/ozon?job=${job.id}&store=${job.storeId}&listing=${job.sku}`);
    const drawer = page.getByRole('dialog', { name: '加载自动任务冻结资料' });
    await expect(drawer.getByText('自动任务冻结资料加载失败', { exact: true })).toBeVisible();
    await expect(drawer).toContainText('OZON_FROZEN_ARTIFACT_UNAVAILABLE: 冻结任务包稳定缺失，禁止回退共享草稿');
    await expect(drawer.getByRole('spinbutton', { name: '上架价' })).toHaveCount(0);
    await expect(drawer).not.toContainText('675');
    await expect(drawer).not.toContainText('7425');
  });

  test('类目模板保存尺码模式并且 PDF 复合属性不得冒充尺码', async ({ page }) => {
    let requestBody: unknown;
    let orderBody: unknown;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/v1/ozon/categories' && request.method() === 'POST') requestBody = request.postDataJSON();
      if (new URL(request.url()).pathname.endsWith('/attributes-order') && request.method() === 'PUT') orderBody = request.postDataJSON();
    });
    await page.goto('/listing/ozon?view=categories');
    await expect(page.getByText('OZON 中俄双语类目目录')).toBeVisible();
    await expect(page.getByText('128', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '手动新建' }).click();
    const dialog = page.getByRole('dialog', { name: '手动新建 OZON 类目模板' });
    await expect(dialog.getByRole('combobox', { name: '搜索 OZON 中文类目' })).toBeVisible();
    await expect(dialog.getByText('description_category_id')).toHaveCount(0);
    await expect(dialog.getByText('属性快照 JSON')).toHaveCount(0);
    const categorySearch = dialog.getByRole('combobox', { name: '搜索 OZON 中文类目' });
    await categorySearch.fill('运动鞋');
    await expect(page.locator('.ant-select-item-option-content').filter({ hasText: '运动鞋' })).toBeVisible();
    await categorySearch.press('ArrowDown');
    await categorySearch.press('Enter');
    await dialog.getByRole('button', { name: '创建草稿' }).click();
    await expect(dialog).toBeHidden();
    expect(requestBody).toEqual({ catalogEntryId: '15621048:91248' });
    await expect(page.getByText('属性顺序 · 4 项')).toBeVisible();
    await expect(page.locator('.ozon-category-drawer .mono-small')).toHaveText('ozon_15621048_91248');
    const categoryDrawer = page.locator('.ozon-category-drawer');
    await expect(categoryDrawer.getByText('媒体、尺码与合规规则', { exact: true })).toBeVisible();
    const sizeModeField = categoryDrawer.locator('.ant-form-item').filter({ hasText: '尺码模式' }).first();
    await expect(sizeModeField).toContainText('有尺码（按尺码生成 Offer）');
    const sizeAttributeField = categoryDrawer.locator('.ant-form-item').filter({ hasText: 'OZON 尺码属性' }).first();
    await expect(sizeAttributeField).toContainText('俄罗斯尺码');
    await expect(sizeAttributeField).toContainText('#4298');
    await sizeAttributeField.locator('.ant-select-selector').click();
    const sizeOptions = page.locator('.ant-select-dropdown:visible');
    await expect(sizeOptions).toContainText('俄罗斯尺码 / Российский размер · #4298');
    await expect(sizeOptions).not.toContainText('PDF文件名称');
    await expect(sizeOptions).not.toContainText('PDF 文件');
    await page.keyboard.press('Escape');
    const rows = page.locator('.ozon-attribute-order-row');
    await expect(rows.nth(0)).toContainText('品牌');
    await expect(rows.nth(0)).toContainText('Бренд');
    await rows.filter({ hasText: 'PDF文件名称' }).getByRole('button', { name: '置顶 PDF文件名称' }).click();
    await expect(rows.nth(0)).toContainText('PDF文件名称');
    const requiredFirst = page.getByRole('button', { name: '必填置顶' });
    await expect(requiredFirst).toBeEnabled();
    await requiredFirst.click();
    await expect(rows.nth(0)).toContainText('品牌');
    await expect(rows.nth(1)).toContainText('俄罗斯尺码');
    await expect(requiredFirst).toBeDisabled();
    await page.getByRole('button', { name: '保存草稿' }).click();
    await expect.poll(() => orderBody).toEqual({
      rowVersion: 1,
      defaultVideoUploadMode: 'COMPRESSED_COPY',
      sizing: { sizeMode: 'sized', sizeAttributeKey: '4298:0' },
      attributeKeys: ['10:0', '4298:0', '8789:8788', '8790:8788']
    });
    await expect(page.getByText('草稿已保存')).toBeVisible();
  });

});
