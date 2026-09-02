import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PurchaseRepository, type ReserveLocalImportInput } from './purchases.js';

const connectionString = process.env.DATABASE_URL;
const schema = `local_imports_test_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let isolated: Pool;
let purchases: PurchaseRepository;
let isolatedConnectionString: string;
const recordedPddUrl = 'https://mobile.yangkeduo.com/goods.html?goods_id=744279810472&_oak_rcto=YWLIj0YF-r4bXgRGk8JiJHm2_C_KbSK_qAUMFq7NvhrNwgoYROT3MC0P&_oc_trace_mark=199&_oc_adinfo=eyJwYWdlX3NuIjoxMDAyOCwic2NlbmVfaWQiOjR9&_oak_gallery_token=28ec92fac59d1bf8ceac88b8f5421ab4&_oak_gallery=https%3A%2F%2Fimg.pddpic.com%2Fmms-material-img%2F2025-05-08%2Ff977a8d8-fbe6-48d5-81c6-b52927f6cb5e.jpeg&_oc_refer_ad=1&page_from=205&thumb_url=https%3A%2F%2Fimg.pddpic.com%2Fmms-material-img%2F2025-05-08%2Ff977a8d8-fbe6-48d5-81c6-b52927f6cb5e.jpeg%3FimageMogr2%2Fthumbnail%2F400x%257CimageView2%2F2%2Fw%2F400%2Fq%2F80&refer_page_name=opt&refer_page_id=10028_1788168285865_8ngcf07f2o&refer_page_sn=10028&uin=TNHGCRQT22VZQNT6RCHZOO22D4_GEXDA';

const input = (idempotencyKey: string, urls = ['https://example.com/local/red', 'https://example.com/local/blue'], platform = 'PDD'): ReserveLocalImportInput => ({
  idempotencyKey, previewHash: 'a'.repeat(64),
  sourceConfigSnapshot: { stageId: 'E000', inputQueueRoot: '/tmp/source', configHash: 'source-hash' },
  targetConfigSnapshot: { stageId: 'E000', candidateRoot: '/tmp/candidate', configHash: 'target-hash' },
  purchase: { productName: '本地多颜色产品', purchasePrice: '28.5', courierFee: '2', currency: 'CNY', providerUrl: urls[0]! },
  providerUrls: urls,
  sources: urls.map((url, index) => ({
    platform, relativePath: `${platform}/color-${index + 1}`, normalizedPathKey: `${platform.toLowerCase()}/color-${index + 1}`,
    isPrimary: index === 0, externalSku: `external-${index + 1}`, informationFileRelativePath: index === 0 ? 'productInformation-sku.json' : undefined,
    informationFileSha256: index === 0 ? 'b'.repeat(64) : undefined, providerUrl: url,
    targetSubdirectory: `color-${index + 1}`, copyManifest: { files: [{ relativePath: 'image.png', sha256: 'c'.repeat(64), sizeBytes: 4 }] }
  }))
});

describe.runIf(Boolean(connectionString))('local import PostgreSQL integration', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const isolatedUrl = new URL(connectionString!);
    isolatedUrl.searchParams.set('options', `-c search_path=${schema},public`);
    isolatedConnectionString = isolatedUrl.toString();
    isolated = new Pool({ connectionString: isolatedConnectionString, max: 1 });
    purchases = new PurchaseRepository(isolatedConnectionString);
    const snapshotRoot = process.platform === 'win32' ? 'C:\\MerchRouteTests\\local-import-downloads' : '/srv/merchroute-tests/local-import-downloads';
    await purchases.initialize({ code: 'E006', displayName: '测试下载', webhookUrl: 'http://127.0.0.1:5678/webhook/test', parentOutputDir: snapshotRoot, enabled: true, isDefault: true });
  });

  afterAll(async () => {
    await purchases?.close();
    await isolated?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('adds the nullable non-negative retail_price column without a default backfill', async () => {
    const column = await isolated.query(`SELECT is_nullable,column_default,numeric_precision,numeric_scale
      FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='procurement_versions' AND column_name='retail_price'`);
    expect(column.rows[0]).toEqual({ is_nullable: 'YES', column_default: null, numeric_precision: 14, numeric_scale: 4 });
    const migration = await isolated.query(`SELECT id FROM purchase_schema_migrations WHERE id='016_procurement_retail_price'`);
    expect(migration.rows).toEqual([{ id: '016_procurement_retail_price' }]);
    const constraint = await isolated.query(`SELECT pg_get_constraintdef(oid) definition FROM pg_constraint
      WHERE conrelid='procurement_versions'::regclass AND conname='procurement_versions_retail_price_nonnegative'`);
    expect(constraint.rows[0]?.definition).toContain('retail_price >=');
  });

  it('installs the product entry-origin migration and indexes', async () => {
    const migration = await isolated.query(`SELECT id FROM purchase_schema_migrations WHERE id='017_product_entry_origins'`);
    const columns = await isolated.query(`SELECT column_name,is_nullable FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='product_entry_origins' ORDER BY ordinal_position`);
    const indexes = await isolated.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes
      WHERE schemaname=current_schema() AND tablename='product_entry_origins' ORDER BY indexname`);
    expect(migration.rows).toEqual([{ id: '017_product_entry_origins' }]);
    expect(columns.rows).toEqual(expect.arrayContaining([
      { column_name: 'sku', is_nullable: 'NO' },
      { column_name: 'method_key', is_nullable: 'NO' },
      { column_name: 'source_type', is_nullable: 'NO' },
      { column_name: 'recorded_at', is_nullable: 'NO' }
    ]));
    expect(indexes.rows.map((row) => row.indexname)).toEqual(expect.arrayContaining([
      'product_entry_origins_method_recorded', 'product_entry_origins_source'
    ]));
  });

  it('creates one SKU for multiple sources and URLs without a download workflow, and replays idempotently', async () => {
    const first = await purchases.reserveLocalImport(input('local-once'));
    const replay = await purchases.reserveLocalImport(input('local-once'));
    expect(first.created).toBe(true);
    expect(first.import).toMatchObject({ status: 'COPYING', sku: '0000001', sourcePlatform: 'PDD', importWorkflowLabel: '本地导入-PDD' });
    expect(first.import.sources).toHaveLength(2);
    expect(replay).toMatchObject({ created: false, import: { id: first.import.id, sku: '0000001' } });
    expect(await purchases.listLocalImportSourceRegistrations(['pdd/color-1', 'pdd/color-2', 'pdd/missing'])).toEqual([
      { normalizedPathKey: 'pdd/color-1', sourceRoot: '/tmp/source', status: 'COPYING' },
      { normalizedPathKey: 'pdd/color-2', sourceRoot: '/tmp/source', status: 'COPYING' }
    ]);
    const procurement = await isolated.query('SELECT download_workflow_code,provider_url FROM procurement_versions WHERE sku=$1', ['0000001']);
    expect(procurement.rows[0]).toEqual({ download_workflow_code: null, provider_url: 'https://example.com/local/red' });
    const urls = await isolated.query('SELECT provider_url_key,sku FROM purchase_provider_urls ORDER BY provider_url_key');
    expect(urls.rows).toEqual([
      { provider_url_key: 'https://example.com/local/blue', sku: '0000001' },
      { provider_url_key: 'https://example.com/local/red', sku: '0000001' }
    ]);
    expect((await isolated.query<{ count: string }>('SELECT COUNT(*)::text count FROM download_jobs')).rows[0]!.count).toBe('0');
    expect((await isolated.query('SELECT method_key,method_label,platform,source_type,source_id FROM product_entry_origins WHERE sku=$1', ['0000001'])).rows).toEqual([
      { method_key: 'LOCAL_IMAGE_IMPORT:PDD', method_label: '本地图片导入-PDD', platform: 'PDD', source_type: 'LOCAL_IMPORT', source_id: first.import.id }
    ]);
  });

  it('skips an entire conflicting import without creating a product or media source', async () => {
    const before = await isolated.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM products');
    const conflict = await purchases.reserveLocalImport(input('local-conflict', ['https://example.com/local/red', 'https://example.com/local/green']));
    const after = await isolated.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM products');
    expect(conflict.import).toMatchObject({ status: 'SKIPPED_DUPLICATE', duplicateSku: '0000001', sku: undefined, sources: [] });
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });

  it('keeps the SKU when copy fails and retries only the media state', async () => {
    const failed = await purchases.failLocalImport((await purchases.reserveLocalImport(input('local-retry', ['https://example.com/local/retry']))).import.id, 'COPY_FAILED', 'disk busy');
    expect(failed).toMatchObject({ status: 'COPY_FAILED_RETRYABLE', sku: '0000002', retryCount: 1 });
    expect(await purchases.listLocalImportSourceRegistrations(['pdd/color-1'])).toEqual(expect.arrayContaining([
      expect.objectContaining({ normalizedPathKey: 'pdd/color-1', sourceRoot: '/tmp/source', status: 'COPY_FAILED_RETRYABLE' })
    ]));
    const copying = await purchases.markLocalImportCopying(failed.id);
    const completed = await purchases.completeLocalImport(failed.id, '/tmp/candidate/0000002-local');
    expect(copying).toMatchObject({ status: 'COPYING', sku: '0000002' });
    expect(completed).toMatchObject({ status: 'IMPORTED', sku: '0000002', retryCount: 1 });
    expect(await purchases.listLocalImportSourceRegistrations(['pdd/color-1'])).toEqual(expect.arrayContaining([
      expect.objectContaining({ normalizedPathKey: 'pdd/color-1', sourceRoot: '/tmp/source', status: 'IMPORTED' })
    ]));
    const products = await isolated.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM products');
    expect(products.rows[0]!.count).toBe('2');
  });

  it('filters and paginates all import outcomes by SKU, product, date, platform and status', async () => {
    const imported1688 = await purchases.reserveLocalImport(input('local-1688', ['https://example.com/local/1688'], '1688'));
    await purchases.completeLocalImport(imported1688.import.id, '/tmp/candidate/0000003-local');

    const all = await purchases.listLocalImports({ page: 1, pageSize: 10 });
    expect(all.total).toBe(4);
    expect(all.items.map((item) => item.status)).toEqual(expect.arrayContaining(['COPYING', 'IMPORTED', 'SKIPPED_DUPLICATE']));
    expect(all.facets.platforms).toEqual(expect.arrayContaining([
      { value: '1688', count: 1 },
      { value: 'PDD', count: 3 }
    ]));
    expect((await purchases.listLocalImports({ query: '0000001', page: 1, pageSize: 10 })).total).toBe(2);
    expect((await purchases.listLocalImports({ query: '本地多颜色产品', page: 1, pageSize: 10 })).total).toBe(4);
    expect((await purchases.listLocalImports({ platform: '1688', status: 'IMPORTED', page: 1, pageSize: 10 })).items)
      .toEqual([expect.objectContaining({ id: imported1688.import.id, importWorkflowLabel: '本地导入-1688' })]);
    expect((await purchases.listLocalImports({
      createdFrom: '2000-01-01T00:00:00.000Z', createdTo: '2100-01-01T00:00:00.000Z', page: 1, pageSize: 10
    })).total).toBe(4);
    expect((await purchases.listLocalImports({ page: 1, pageSize: 2 })).items).toHaveLength(2);
  });

  it('creates a new procurement version while preserving local-import identity, sources and the real workflow value', async () => {
    const first = (await purchases.listLocalImports({ query: '0000001', status: 'COPYING', page: 1, pageSize: 10 })).items[0]!;
    const updated = await purchases.updateLocalImportPurchase(first.id, {
      productName: '本地多颜色产品-已编辑', purchasePrice: '31.25', retailPrice: '342', courierFee: '3', currency: 'RUB',
      providerUrl: 'https://example.com/local/red-edited', grossWeightGrams: '300', lengthCm: '23', widthCm: '13', heightCm: '8'
    });
    expect(updated).toMatchObject({
      id: first.id, sku: '0000001', sourcePlatform: 'PDD', importWorkflowLabel: '本地导入-PDD',
      purchase: { productName: '本地多颜色产品-已编辑', procurement: { versionNo: 2, downloadWorkflowCode: undefined, purchasePrice: '31.2500', retailPrice: '342.0000', currency: 'CNY' } }
    });
    expect(updated.sources).toHaveLength(2);
    expect((await isolated.query<{ count: string }>('SELECT COUNT(*)::text count FROM procurement_versions WHERE sku=$1', ['0000001'])).rows[0]!.count).toBe('2');
    expect((await isolated.query('SELECT version_no,purchase_price,retail_price,currency FROM procurement_versions WHERE sku=$1 ORDER BY version_no', ['0000001'])).rows).toEqual([
      { version_no: 1, purchase_price: '28.5000', retail_price: null, currency: 'CNY' },
      { version_no: 2, purchase_price: '31.2500', retail_price: '342.0000', currency: 'CNY' }
    ]);
    expect((await isolated.query<{ count: string }>('SELECT COUNT(*)::text count FROM download_jobs WHERE sku=$1', ['0000001'])).rows[0]!.count).toBe('0');
    const duplicate = (await purchases.listLocalImports({ status: 'SKIPPED_DUPLICATE', page: 1, pageSize: 10 })).items[0]!;
    await expect(purchases.updateLocalImportPurchase(duplicate.id, {
      productName: '禁止编辑', purchasePrice: '1', currency: 'CNY', providerUrl: 'https://example.com/local/forbidden'
    })).rejects.toMatchObject({ code: 'LOCAL_IMPORT_NOT_EDITABLE' });
  });

  it('keeps legacy rows with an unknown platform queryable', async () => {
    const legacy = await purchases.reserveLocalImport(input('local-unknown', ['https://example.com/local/unknown']));
    await isolated.query('UPDATE local_imports SET source_platform=NULL,import_workflow_label=NULL WHERE id=$1', [legacy.import.id]);
    const result = await purchases.listLocalImports({ query: legacy.import.sku, page: 1, pageSize: 10 });
    expect(result.items[0]).toMatchObject({ id: legacy.import.id, sourcePlatform: undefined, importWorkflowLabel: undefined });
  });

  it('keeps local imports out of the URL-download list without changing shared product lookup', async () => {
    const urlPurchase = await purchases.createPurchase({
      productName: 'URL下载来源产品', purchasePrice: '19.8', courierFee: '2', currency: 'CNY',
      providerUrl: recordedPddUrl, downloadWorkflowCode: 'E006'
    });
    await purchases.enqueueDownload(urlPurchase.sku, 'E006');

    expect((await purchases.listPurchases({ query: '0000001' })).items).toEqual([
      expect.objectContaining({ sku: '0000001' })
    ]);
    expect(await purchases.listPurchases({ query: '0000001', source: 'URL_DOWNLOAD' })).toMatchObject({ items: [], total: 0 });

    const filtered = await purchases.listPurchases({
      page: 1, pageSize: 10, query: 'URL下载来源产品', source: 'URL_DOWNLOAD',
      status: 'QUEUED', workflowCode: 'E006',
      createdFrom: '2000-01-01T00:00:00.000Z', createdTo: '2100-01-01T00:00:00.000Z'
    });
    expect(filtered).toMatchObject({ total: 1, page: 1, pageSize: 10 });
    expect(filtered.items).toEqual([expect.objectContaining({ sku: urlPurchase.sku, productName: 'URL下载来源产品' })]);

    const byRecordedUrl = await purchases.listPurchases({
      page: 1, pageSize: 10, query: `  ${recordedPddUrl}  `, source: 'URL_DOWNLOAD'
    });
    expect(byRecordedUrl).toMatchObject({ total: 1 });
    expect(byRecordedUrl.items).toEqual([expect.objectContaining({ sku: urlPurchase.sku })]);
    const byPartialUrl = await purchases.listPurchases({
      page: 1, pageSize: 10, query: 'https://mobile.yangkeduo.com/goods.html?goods_id=744279810472'
    });
    expect(byPartialUrl).toMatchObject({ items: [], total: 0 });

    const duplicate = await purchases.reserveLocalImport(input('local-duplicate-url-download', [recordedPddUrl]));
    expect(duplicate.import).toMatchObject({ status: 'SKIPPED_DUPLICATE', duplicateSku: urlPurchase.sku, sku: undefined });
    expect((await purchases.listPurchases({ query: urlPurchase.sku, source: 'URL_DOWNLOAD' })).items).toEqual([
      expect.objectContaining({ sku: urlPurchase.sku })
    ]);
    await expect(purchases.listPurchases({ source: 'LOCAL_IMPORT' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect((await isolated.query('SELECT retail_price FROM procurement_versions WHERE sku=$1', [urlPurchase.sku])).rows).toEqual([{ retail_price: null }]);
  });

  it('queries every product by entry method and product creation date, with dynamic facets and resolved media folders', async () => {
    const urlProduct = (await purchases.listPurchases({ query: 'URL下载来源产品', page: 1, pageSize: 10 })).items[0]!;
    const urlOutput = process.platform === 'win32' ? 'C:\\MerchRouteTests\\downloads\\url-e006' : '/srv/merchroute-tests/downloads/url-e006';
    await isolated.query(`UPDATE download_jobs SET status='SUCCEEDED',output_dir=$2,finished_at='2026-08-25T03:00:00.000Z' WHERE sku=$1`, [urlProduct.sku, urlOutput]);
    await isolated.query(`UPDATE products SET created_at='2026-08-20T02:00:00.000Z' WHERE sku='0000003'`);
    await isolated.query(`UPDATE products SET created_at='2026-08-25T02:00:00.000Z' WHERE sku=$1`, [urlProduct.sku]);

    const all = await purchases.listPurchases({ page: 1, pageSize: 100, sort: 'RECORDED_DESC' });
    const local1688 = all.items.find((item) => item.sku === '0000003');
    const e006 = all.items.find((item) => item.sku === urlProduct.sku);
    expect(local1688).toMatchObject({
      localMediaFolder: '/tmp/candidate/0000003-local',
      entryOrigin: { methodKey: 'LOCAL_IMAGE_IMPORT:1688', label: '本地图片导入-1688', platform: '1688', sourceType: 'LOCAL_IMPORT' }
    });
    expect(new Date(local1688!.entryOrigin.recordedAt).toISOString()).toBe('2026-08-20T02:00:00.000Z');
    expect(e006).toMatchObject({
      localMediaFolder: urlOutput,
      entryOrigin: { methodKey: 'URL_DOWNLOAD:E006', label: 'PDD下载E006', platform: 'PDD', workflowCode: 'E006', sourceType: 'URL_DOWNLOAD' }
    });
    expect(new Date(e006!.entryOrigin.recordedAt).toISOString()).toBe('2026-08-25T02:00:00.000Z');
    expect(all.items.indexOf(e006!)).toBeLessThan(all.items.indexOf(local1688!));
    expect(all.facets.entryMethods).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'LOCAL_IMAGE_IMPORT:1688', label: '本地图片导入-1688', sourceType: 'LOCAL_IMPORT' }),
      expect.objectContaining({ value: 'URL_DOWNLOAD:E006', label: 'PDD下载E006', sourceType: 'URL_DOWNLOAD' })
    ]));

    const byMethod = await purchases.listPurchases({ entryMethodKey: 'LOCAL_IMAGE_IMPORT:1688', page: 1, pageSize: 10 });
    expect(byMethod.items.map((item) => item.sku)).toEqual(['0000003']);
    const byDate = await purchases.listPurchases({
      createdFrom: '2026-08-25T00:00:00.000Z', createdTo: '2026-08-26T00:00:00.000Z', page: 1, pageSize: 10, sort: 'RECORDED_DESC'
    });
    expect(byDate.items.map((item) => item.sku)).toContain(urlProduct.sku);
    expect(byDate.items.map((item) => item.sku)).not.toContain('0000003');
    await expect(purchases.listPurchases({ entryMethodKey: 'x'.repeat(201) })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(purchases.listPurchases({ sort: 'UPDATED_ASC' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('persists a RUB retail price with a forced CNY purchase currency while pricing ignores retailPrice', async () => {
    const rubInput = input('local-rub-price', ['https://example.com/local/rub-price'], 'WB');
    rubInput.purchase = { ...rubInput.purchase, purchasePrice: '115.3333', retailPrice: '1384', currency: 'RUB' };

    const created = await purchases.reserveLocalImport(rubInput);
    const stored = await isolated.query('SELECT purchase_price,retail_price,currency FROM procurement_versions WHERE sku=$1', [created.import.sku]);
    const pricing = await purchases.findPricingProducts({ kind: 'SKU', sku: created.import.sku! });

    expect(stored.rows).toEqual([{ purchase_price: '115.3333', retail_price: '1384.0000', currency: 'CNY' }]);
    expect(pricing[0]?.procurement).toMatchObject({ purchasePrice: '115.3333', currency: 'CNY' });
    expect(pricing[0]?.procurement).not.toHaveProperty('retailPrice');
  });

  it('backfills local-import, E006 and E007 origins for an existing database', async () => {
    const downloadRoot = process.platform === 'win32' ? 'C:\\MerchRouteTests\\local-import-downloads' : '/srv/merchroute-tests/local-import-downloads';
    await purchases.saveWorkflow({
      code: 'E007', displayName: '1688下载E007', webhookUrl: 'http://127.0.0.1:5678/webhook/e007',
      parentOutputDir: downloadRoot, enabled: true, isDefault: false
    });
    const e007 = await purchases.createPurchase({
      productName: '1688 回填产品', purchasePrice: '21', currency: 'CNY',
      providerUrl: 'https://example.com/e007-backfill', downloadWorkflowCode: 'E007'
    });
    await isolated.query(`DELETE FROM product_entry_origins`);
    await isolated.query(`DELETE FROM purchase_schema_migrations WHERE id='017_product_entry_origins'`);
    await purchases.close();
    purchases = new PurchaseRepository(isolatedConnectionString);
    await purchases.initialize();

    const origins = await isolated.query(`SELECT p.product_name,o.method_key,o.method_label,o.platform,o.workflow_code,o.source_type
      FROM product_entry_origins o JOIN products p ON p.sku=o.sku
      WHERE p.product_name IN('本地多颜色产品','URL下载来源产品','1688 回填产品')
      ORDER BY p.product_name,o.method_key`);
    expect(origins.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ method_key: 'LOCAL_IMAGE_IMPORT:1688', method_label: '本地图片导入-1688', platform: '1688', workflow_code: null, source_type: 'LOCAL_IMPORT' }),
      expect.objectContaining({ method_key: 'URL_DOWNLOAD:E006', method_label: 'PDD下载E006', platform: 'PDD', workflow_code: 'E006', source_type: 'URL_DOWNLOAD' }),
      { product_name: '1688 回填产品', method_key: 'URL_DOWNLOAD:E007', method_label: '1688下载E007', platform: '1688', workflow_code: 'E007', source_type: 'URL_DOWNLOAD' }
    ]));
    expect((await purchases.listPurchases({ query: e007.sku, entryMethodKey: 'URL_DOWNLOAD:E007' })).items[0]).toMatchObject({
      sku: e007.sku, entryOrigin: { label: '1688下载E007', platform: '1688', sourceType: 'URL_DOWNLOAD' }
    });
  });
});
