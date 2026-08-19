import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { createDefaultConfig } from '@n8n-media-review/shared';
import { PurchaseRepository } from '../../apps/server/src/repositories/purchases.js';
import { ShippingRepository } from '../../apps/server/src/repositories/shipping.js';
import { PricingRepository } from '../../apps/server/src/repositories/pricing.js';
import { WbRepository } from '../../apps/server/src/repositories/wb.js';
import { OzonRepository } from '../../apps/server/src/repositories/ozon.js';

export default async function globalSetup(): Promise<void> {
  const root = path.resolve('.e2e-data');
  await rm(root, { recursive: true, force: true });
  dotenv.config({ path: path.resolve('.env') });
  if (!process.env.DATABASE_URL) throw new Error('完整 E2E 需要 PostgreSQL DATABASE_URL，以验证产品身份严格模式');
  const databaseSchema = `pixroute_e2e_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${databaseSchema}`);
  await admin.end();
  const isolatedDatabaseUrl = new URL(process.env.DATABASE_URL);
  isolatedDatabaseUrl.searchParams.set('options', `-c search_path=${databaseSchema},public`);
  const purchases = new PurchaseRepository(isolatedDatabaseUrl.toString());
  await purchases.initialize({ code: 'E006', displayName: '拼多多商品媒体下载', webhookUrl: 'http://localhost:5678/webhook/e2e', parentOutputDir: path.join(root, 'downloads', 'E006'), timeoutMs: 900_000, enabled: true, isDefault: true });
  await purchases.saveWorkflow({ code: 'E007', displayName: '1688产品媒体下载', webhookUrl: 'http://localhost:5678/webhook/1688-product-media-download', parentOutputDir: path.join(root, 'downloads', 'E007'), timeoutMs: 900_000, enabled: true, isDefault: false });
  for (const [index, productName] of ['E2E-测试产品A', 'E2E-预览切换', 'E2E-五视图产品', 'E2E-测试套图A', '布鞋', '老北京布鞋', 'E2E-E001变体分组', 'E2E-E004视频产品'].entries()) {
    const productId = `91000000000000${index + 1}`;
    const is1688 = index % 2 === 1;
    await purchases.createPurchase({
      productName, downloadWorkflowCode: is1688 ? 'E007' : 'E006', purchasePrice: '10', courierFee: '2', currency: 'CNY', grossWeightGrams: '500', lengthCm: '20', widthCm: '10', heightCm: '8',
      providerUrl: is1688 ? `https://detail.1688.com/offer/${productId}.html` : `https://mobile.yangkeduo.com/goods.html?goods_id=${productId}`
    });
  }
  await purchases.createPurchase({ productName: 'E2E-历史错配工作流', downloadWorkflowCode: 'E006', purchasePrice: '12', courierFee: '0', currency: 'CNY', providerUrl: 'https://detail.1688.com/offer/910000000000099.html' });
  await purchases.close();
  const shipping = new ShippingRepository(isolatedDatabaseUrl.toString());
  await shipping.initialize();
  await shipping.close();
  const pricing = new PricingRepository(isolatedDatabaseUrl.toString());
  await pricing.initialize();
  const wbTemplate = (await pricing.listTemplates()).find((item) => item.platformCode === 'WB' && item.publishedVersion)!;
  const wbDetail = await pricing.getTemplate(wbTemplate.id);
  const wbPublished = wbDetail.versions.find((version) => version.status === 'PUBLISHED')!;
  const ozonTemplate = await pricing.createTemplate({ name: 'OZON平台默认定价', platformCode: 'OZON', definition: wbPublished.definition });
  await pricing.publishTemplate(ozonTemplate.id);
  await pricing.close();
  const wb = new WbRepository(isolatedDatabaseUrl.toString());
  await wb.initialize();
  const catalogRun = await wb.beginCatalogRun('MANUAL');
  await wb.completeCatalogRun(
    catalogRun.run.runId,
    [{ parentId: 1, nameRu: 'Цвета', nameZh: '颜色', isVisible: true }],
    [{ subjectId: 105, subjectNameRu: 'Кроссовки', subjectNameZh: '休闲运动鞋', parentId: 1, parentNameRu: 'Обувь', parentNameZh: '鞋类' }],
    [
      { colorKey: '1'.repeat(64), position: 1, nameRu: 'Красный', nameZh: '红色', parentNameRu: 'красный', parentNameZh: '红色' },
      { colorKey: '2'.repeat(64), position: 2, nameRu: 'Белый', nameZh: '白色', parentNameRu: 'белый', parentNameZh: '白色' },
      { colorKey: '3'.repeat(64), position: 3, nameRu: 'Черный', nameZh: '黑色', parentNameRu: 'черный', parentNameZh: '黑色' }
    ],
    [
      { directory: 'countries', valueKey: '15000170', position: 1, wbId: 15000170, nameRu: 'Китай', nameZh: '中国', fullNameRu: 'Китайская Народная Республика', fullNameZh: '中华人民共和国' },
      { directory: 'seasons', valueKey: 'e2e-summer', position: 1, nameRu: 'лето', nameZh: '夏季', fullNameRu: '', fullNameZh: '' },
      { directory: 'kinds', valueKey: 'e2e-female', position: 1, nameRu: 'Женский', nameZh: '女性', fullNameRu: '', fullNameZh: '' }
    ],
    'e2e://wb-catalog-snapshot.json',
    'sha256:e2e'
  );
  await wb.close();
  const ozon = new OzonRepository(isolatedDatabaseUrl.toString());
  await ozon.initialize();
  const ozonCatalogRun = await ozon.beginCatalogRun('MANUAL');
  await ozon.completeCatalogRun(
    ozonCatalogRun.run.runId,
    [{
      descriptionCategoryId: 17001, typeId: 97001,
      categoryNameZh: '箱包', typeNameZh: '手提包', categoryNameRu: 'Сумки', typeNameRu: 'Сумка-тоут',
      pathZh: ['箱包', '手提包'], pathRu: ['Сумки', 'Сумка-тоут']
    }],
    [
      { directory: 'colors', attributeId: 10096, dictionaryId: 1494, valueId: 61577, nameRu: 'Красный', nameZh: '红色', position: 1 },
      { directory: 'colors', attributeId: 10096, dictionaryId: 1494, valueId: 61578, nameRu: 'Белый', nameZh: '白色', position: 2 },
      { directory: 'colors', attributeId: 10096, dictionaryId: 1494, valueId: 972075931, nameRu: 'черный сапфир', nameZh: '黑蓝宝石', position: 3 },
      { directory: 'colors', attributeId: 10096, dictionaryId: 1494, valueId: 61579, nameRu: 'без перевода', nameZh: '', position: 4 }
    ],
    'e2e://ozon-catalog-snapshot.json',
    'sha256:e2e',
    1
  );
  await ozon.close();
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'database-url.txt'), isolatedDatabaseUrl.toString(), 'utf8');
  await writeFile(path.join(root, 'database-schema.txt'), databaseSchema, 'utf8');
  const appData = path.join(root, 'app');
  const roots = path.join(root, 'roots');
  const config = createDefaultConfig('other');
  for (const stage of config.stages) {
    const base = path.join(roots, stage.id);
    if (stage.inputQueueRoot) stage.inputQueueRoot = path.join(base, 'input');
    if (stage.candidateRoot) stage.candidateRoot = path.join(base, 'candidate');
    if (stage.approvedArchiveRoot) stage.approvedArchiveRoot = path.join(base, 'archive');
    if (stage.outputRoot) stage.outputRoot = path.join(base, 'output');
    stage.targets.forEach((target) => { target.targetQueueRoot = path.join(roots, target.targetStageId, 'input'); });
  }
  await mkdir(appData, { recursive: true });
  const directories = config.stages.flatMap((stage) => [stage.inputQueueRoot, stage.candidateRoot, stage.approvedArchiveRoot, stage.outputRoot, ...stage.targets.map((target) => target.targetQueueRoot)]).filter((item): item is string => Boolean(item));
  await Promise.all([...new Set(directories)].map((directory) => mkdir(directory, { recursive: true })));
  await createProduct(config.stages.find((stage) => stage.id === 'E006')!.candidateRoot!, 'E2E-测试产品A', ['主图/image_01.png', '详情图/image_02.png']);
  await createProduct(config.stages.find((stage) => stage.id === 'E006')!.candidateRoot!, 'E2E-预览切换', [
    { relativePath: '预览组/01-portrait.png', width: 180, height: 320 },
    { relativePath: '预览组/02-landscape.png', width: 320, height: 180 },
    { relativePath: '预览组/03-square.png', width: 240, height: 240 },
    { relativePath: '预览组/04-three-four.png', width: 240, height: 320 }
  ]);
  await createProduct(config.stages.find((stage) => stage.id === 'E006')!.candidateRoot!, 'E2E-需要人工关联', ['主图/image_01.png']);
  await createProduct(config.stages.find((stage) => stage.id === 'E001')!.candidateRoot!, 'E2E-E001变体分组', ['01.png', '02.png', '03.png', '04.png', '05.png', '06.png']);
  await createProduct(config.stages.find((stage) => stage.id === 'E002')!.candidateRoot!, 'E2E-五视图产品', ['views/image_01.png', 'views/image_02.png']);
  await writeTaskContext(config.stages.find((stage) => stage.id === 'E002')!.candidateRoot!, 'E2E-五视图产品', '0000003', 'E2E-五视图产品');
  await createProduct(config.stages.find((stage) => stage.id === 'E003')!.candidateRoot!, 'E2E-测试套图A', ['scenePrompt01/image_01.png', 'scenePrompt02/image_02.png']);
  await writeTaskContext(config.stages.find((stage) => stage.id === 'E003')!.candidateRoot!, 'E2E-测试套图A', '0000004', 'E2E-测试套图A');
  await createProduct(config.stages.find((stage) => stage.id === 'E003')!.candidateRoot!, 'E2E-E003排序', ['排序/07.png', '排序/01.png', '排序/04.png']);
  await writeTaskContext(config.stages.find((stage) => stage.id === 'E003')!.candidateRoot!, 'E2E-E003排序', '0000004', 'E2E-测试套图A');
  await createVideoProduct(config.stages.find((stage) => stage.id === 'E004')!.candidateRoot!, 'E2E-E004视频产品', 'videos/main.mp4');
  await writeTaskContext(config.stages.find((stage) => stage.id === 'E004')!.candidateRoot!, 'E2E-E004视频产品', '0000008', 'E2E-E004视频产品');
  await writeFile(path.join(appData, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

type TestImage = string | { relativePath: string; width: number; height: number };

async function createProduct(root: string, name: string, images: TestImage[]): Promise<void> {
  const product = path.join(root, name);
  await mkdir(product, { recursive: true });
  await writeFile(path.join(product, 'product-info.json'), JSON.stringify({ productName: name }, null, 2), 'utf8');
  for (const [index, image] of images.entries()) {
    const relativePath = typeof image === 'string' ? image : image.relativePath;
    const width = typeof image === 'string' ? 96 : image.width;
    const height = typeof image === 'string' ? 96 : image.height;
    const file = path.join(product, ...relativePath.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await sharp({ create: { width, height, channels: 3, background: index ? '#d98b2b' : '#087f8c' } }).png().toFile(file);
  }
}

async function createVideoProduct(root: string, name: string, relativePath: string): Promise<void> {
  const product = path.join(root, name);
  const file = path.join(product, ...relativePath.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(path.join(product, 'product-info.json'), JSON.stringify({ productName: name }, null, 2), 'utf8');
  await writeFile(file, Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex'));
}

async function writeTaskContext(root: string, folderName: string, sku: string, productName: string): Promise<void> {
  await writeFile(path.join(root, folderName, 'task-context.json'), JSON.stringify({ schemaVersion: 1, workflowCode: 'E2E', SKU: sku, productName, variants: '默认变体', sourceSubmissionId: `e2e-${sku}` }, null, 2), 'utf8');
}
