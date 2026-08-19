import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PurchaseRepository } from './purchases.js';
import { StateStore } from './store.js';
import { ProductIdentityService } from '../services/product-identity/index.js';

const connectionString = process.env.DATABASE_URL;
const schema = `product_identity_test_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let purchases: PurchaseRepository;
let identity: ProductIdentityService;
let store: StateStore;
let appData = '';

const purchaseInput = (productName: string, sequence: number) => ({
  productName,
  purchasePrice: '10',
  courierFee: '2',
  currency: 'CNY',
  providerUrl: `https://example.com/product-${sequence}`
});

describe.runIf(Boolean(connectionString))('product identity PostgreSQL integration', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const isolatedUrl = new URL(connectionString!);
    isolatedUrl.searchParams.set('options', `-c search_path=${schema},public`);
    purchases = new PurchaseRepository(isolatedUrl.toString());
    await purchases.initialize({
      code: 'E006', displayName: 'PDD下载', webhookUrl: 'http://127.0.0.1:5678/webhook/test',
      parentOutputDir: 'G:/01_MerchRoute/03-pddProductMedia', timeoutMs: 900_000, enabled: true, isDefault: true
    });
    await purchases.saveWorkflow({
      code: 'E007', displayName: '1688下载', webhookUrl: 'http://127.0.0.1:5678/webhook/test-1688',
      parentOutputDir: 'G:/01_MerchRoute/03_productMediaDownload', timeoutMs: 900_000, enabled: true, isDefault: false
    });
    for (let sequence = 1; sequence <= 10; sequence += 1) await purchases.createPurchase(purchaseInput(`占位产品${sequence}`, sequence));
    const target = await purchases.createPurchase(purchaseInput('网面跑步鞋', 11));
    expect(target.sku).toBe('0000011');
    appData = await mkdtemp(path.join(os.tmpdir(), 'pixroute-product-identity-'));
    store = new StateStore(appData);
    await store.initialize();
    identity = new ProductIdentityService(purchases, store);
  }, 30_000);

  afterAll(async () => {
    await purchases?.close();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
    if (appData) await rm(appData, { recursive: true, force: true });
  });

  it('keeps the seven-digit SKU in the E006 download payload and resolves Windows/macOS path formats', async () => {
    const job = await purchases.enqueueDownload('0000011', 'E006');
    expect(job.requestBody).toMatchObject({ SKU: '0000011', productName: '网面跑步鞋' });
    const claimed = await purchases.claimNextJob();
    expect(claimed?.id).toBe(job.id);
    const windowsOutput = 'G:\\01_MerchRoute\\03-pddProductMedia\\0000011-网面跑步鞋-R1';
    await purchases.completeJob(job.id, { success: true, outputDir: windowsOutput }, claimed!.leaseToken);

    await expect(purchases.findProductIdentityByDownloadOutputDir(windowsOutput)).resolves.toMatchObject({
      sku: '0000011',
      productName: '网面跑步鞋',
      variants: expect.arrayContaining([expect.objectContaining({ name: '默认变体' })])
    });
    await expect(purchases.findProductIdentityByDownloadOutputDir('G:/01_MerchRoute/03-pddProductMedia/0000011-网面跑步鞋-R1/')).resolves.toMatchObject({
      sku: '0000011',
      productName: '网面跑步鞋',
      variants: expect.arrayContaining([expect.objectContaining({ name: '默认变体' })])
    });

    const e007 = await purchases.enqueueDownload('0000011', 'E007');
    expect(e007.requestBody).toMatchObject({ SKU: '0000011', productName: '网面跑步鞋', parentOutputDir: 'G:/01_MerchRoute/03_productMediaDownload' });
    const e007Claim = await purchases.claimNextJob();
    await purchases.completeJob(e007.id, { success: true, outputDir: '/Volumes/data/0000011-网面跑步鞋-R1' }, e007Claim!.leaseToken);
  });

  it('uses SKU prefix before name matching and reports duplicate longest-name matches as ambiguous', async () => {
    await expect(identity.resolveTask({ taskId: 'sku-prefix', stageId: 'E001', sourceFolder: '/Volumes/data/0000011-旧目录名', sourceFolderName: '0000011-旧目录名' })).resolves.toMatchObject({ status: 'RESOLVED', sku: '0000011', productName: '网面跑步鞋', source: 'SKU_PREFIX' });
    await expect(identity.resolveTask({ taskId: 'sku-prefix-no-separator', stageId: 'E001', sourceFolder: '/Volumes/data/0000011旧目录名', sourceFolderName: '0000011旧目录名' })).resolves.toMatchObject({ status: 'RESOLVED', sku: '0000011', source: 'SKU_PREFIX' });
    await expect(identity.resolveTask({ taskId: 'name-prefix-no-separator', stageId: 'E001', sourceFolder: '/Volumes/data/网面跑步鞋_R1', sourceFolderName: '网面跑步鞋_R1' })).resolves.toMatchObject({ status: 'RESOLVED', sku: '0000011', source: 'PRODUCT_NAME_PREFIX' });
    await expect(identity.resolveTask({ taskId: 'name-prefix', stageId: 'E002', sourceFolder: '/Volumes/data/网面跑步鞋-20260716', sourceFolderName: '网面跑步鞋-20260716' })).resolves.toMatchObject({ status: 'RESOLVED', sku: '0000011', source: 'PRODUCT_NAME_PREFIX' });

    await purchases.createPurchase(purchaseInput('网面跑步鞋', 12));
    await expect(identity.resolveTask({ taskId: 'ambiguous', stageId: 'E003', sourceFolder: '/Volumes/data/网面跑步鞋-套图', sourceFolderName: '网面跑步鞋-套图' })).resolves.toMatchObject({
      status: 'AMBIGUOUS',
      candidates: expect.arrayContaining([
        expect.objectContaining({
          sku: '0000011',
          productName: '网面跑步鞋',
          variants: expect.arrayContaining([expect.objectContaining({ name: '默认变体' })])
        })
      ])
    });
    await expect(identity.resolveTask({ taskId: 'missing', stageId: 'E003', sourceFolder: '/Volumes/data/完全无匹配', sourceFolderName: '完全无匹配' })).resolves.toMatchObject({ status: 'UNRESOLVED' });
  });

  it('persists manual SKU confirmation and locks reassignment during packaging', async () => {
    const task = { taskId: 'manual-task', stageId: 'E001', sourceFolder: '/Volumes/data/unknown', sourceFolderName: 'unknown' };
    await expect(identity.assignTask(task, '0000011')).resolves.toMatchObject({ status: 'RESOLVED', sku: '0000011', source: 'USER_CONFIRMED' });
    expect(store.read().reviews.find((item) => item.taskId === task.taskId)).toMatchObject({ productSku: '0000011', productNameSnapshot: '网面跑步鞋', productIdentitySource: 'USER_CONFIRMED' });
    await store.update((db) => { db.pendingSubmissions.push({ id: 'packing', taskId: task.taskId, sourceStageId: 'E001', targetStageId: 'E002', selectedRelativePaths: [], n8nTaskParameters: { SKU: '0000011', productName: '网面跑步鞋' }, conflictPolicy: 'skip', status: 'PACKAGING', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); });
    await expect(identity.assignTask(task, '0000011')).rejects.toMatchObject({ code: 'TASK_LOCKED' });
  });

  it('re-reads the current database product name instead of trusting a saved snapshot', async () => {
    await purchases.updatePurchase('0000011', purchaseInput('网面跑步鞋-数据库新名称', 13));
    await expect(identity.requirePendingIdentity({ id: 'pending-rename', productSku: '0000011' })).resolves.toMatchObject({
      sku: '0000011',
      productName: '网面跑步鞋-数据库新名称',
      variants: expect.arrayContaining([expect.objectContaining({ name: '默认变体' })])
    });
    expect(identity.inject({ SKU: '9999999', productName: '客户端篡改', custom: '保留' }, { sku: '0000011', productName: '网面跑步鞋-数据库新名称' })).toEqual({ SKU: '0000011', productName: '网面跑步鞋-数据库新名称', custom: '保留' });
    await expect(identity.requirePendingIdentity({ id: 'deleted-product', productSku: '9999999' })).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
  });

  it('persists unique WB color identities and backfills only unambiguous exact legacy names', async () => {
    const black = { colorKey: 'a'.repeat(64), nameRu: 'Черный', nameZh: '黑色' };
    const white = { colorKey: 'b'.repeat(64), nameRu: 'Белый', nameZh: '白色' };
    const grayPinkA = { colorKey: 'c'.repeat(64), nameRu: 'серовато-розовый', nameZh: '灰粉色' };
    const grayPinkB = { colorKey: 'd'.repeat(64), nameRu: 'пепельно-розовый', nameZh: '灰粉色' };
    const ozonBlack = { itemKey: 'colors:1494:61577', dictionaryId: 1494, valueId: 61577, nameRu: 'черный', nameZh: '黑色', source: 'AUTO_EXACT_RU' as const };
    const [created] = await purchases.ensureColoredProductVariants('0000011', [{ name: '黑色', wbColor: black, ozonColor: ozonBlack }]);
    expect(created).toMatchObject({ name: '黑色', wbColor: black, ozonColor: ozonBlack });
    await expect(purchases.ensureColoredProductVariants('0000011', [{ name: '黑色', wbColor: black }, { name: '黑色副本', wbColor: black }])).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await purchases.ensureProductVariants('0000011', ['Белый', '灰粉色']);
    await expect(purchases.backfillProductVariantColors([black, white, grayPinkA, grayPinkB])).resolves.toBe(1);
    const variants = await purchases.listProductVariants('0000011');
    expect(variants.find((variant) => variant.name === 'Белый')).toMatchObject({ wbColor: white });
    expect(variants.find((variant) => variant.name === '灰粉色')?.wbColor).toBeUndefined();
    await purchases.ensureColoredProductVariants('0000011', [{ name: '黑色', wbColor: black, clearOzonColor: true }]);
    expect((await purchases.listProductVariants('0000011')).find((variant) => variant.name === '黑色')?.ozonColor).toBeUndefined();
  });
});
