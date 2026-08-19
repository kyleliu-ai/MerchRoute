import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ozonPresetInputSchema, stableOzonOfferId } from '@n8n-media-review/shared';
import { registerOzonRoutes } from '../routes/ozon.js';
import { OzonPublishingService } from '../services/ozon-publishing/index.js';
import { OzonStoreRepository } from './ozon-stores.js';
import { OzonRepository } from './ozon.js';

const connectionString = process.env.DATABASE_URL;
const schema = `ozon_test_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let repository: OzonRepository;
let isolatedConnectionString: string;

describe.runIf(Boolean(connectionString))('OZON repository PostgreSQL integration', () => {
  afterEach(() => vi.restoreAllMocks());

  beforeAll(async () => {
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${schema}.products (sku CHAR(7) PRIMARY KEY, product_name TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL)`);
    await admin.query(`CREATE TABLE ${schema}.product_variants (
      id UUID PRIMARY KEY,sku CHAR(7) NOT NULL,name TEXT NOT NULL,normalized_name TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await admin.query(`INSERT INTO ${schema}.products(sku,product_name,created_at) VALUES('0000010','测试商品','2026-07-20T02:00:00.000Z')`);
    const isolatedUrl = new URL(connectionString!);
    isolatedUrl.searchParams.set('options', `-c search_path=${schema},public`);
    isolatedConnectionString = isolatedUrl.toString();
    repository = new OzonRepository(isolatedConnectionString);
    const concurrent = new OzonRepository(isolatedConnectionString);
    await Promise.all([repository.initialize(), concurrent.initialize()]);
    await concurrent.close();
  });

  afterAll(async () => {
    await repository?.close();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('migrates an isolated namespace and enforces versions, offer identity, dependencies and mappings', async () => {
    const tableRows = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'ozon_%' ORDER BY table_name`,
      [schema]
    );
    const tableNames = tableRows.rows.map((row) => row.table_name);
    expect(tableNames).toHaveLength(16);
    expect(tableNames).toEqual(expect.arrayContaining([
      'ozon_category_template_versions',
      'ozon_category_templates',
      'ozon_catalog_entries',
      'ozon_catalog_dictionary_values',
      'ozon_catalog_sync_runs',
      'ozon_listing_drafts',
      'ozon_listing_presets',
      'ozon_listing_versions',
      'ozon_media_deliveries',
      'ozon_platform_status_refresh_leases',
      'ozon_product_mappings',
      'ozon_publish_events',
      'ozon_publish_jobs',
      'ozon_publish_slots',
      'ozon_schema_migrations',
      'ozon_system_settings'
    ]));
    const legacyEventBindings = await admin.query<{ column_name: string; is_nullable: string }>(`
      SELECT column_name,is_nullable FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='ozon_publish_events'
        AND column_name IN ('store_id','publication_id')
      ORDER BY column_name`, [schema]);
    expect(legacyEventBindings.rows).toEqual([
      { column_name: 'publication_id', is_nullable: 'YES' },
      { column_name: 'store_id', is_nullable: 'YES' }
    ]);
    const migration = await admin.query(`SELECT id FROM ${schema}.ozon_schema_migrations`);
    expect(migration.rows).toEqual(expect.arrayContaining([
      { id: '001_initial' },
      { id: '002_local_category_catalog' },
      { id: '003_ozon_field_dictionaries' },
      { id: '004_ozon_job_coordination' },
      { id: '005_ozon_task_directory_and_variant_links' },
      { id: '006_ozon_sku_model_identity' },
      { id: '007_ozon_platform_type_identity' },
      { id: '008_ozon_frontend_sku_links' },
      { id: '009_ozon_management_and_preset_activation' },
      { id: '010_ozon_platform_status_reconciliation' },
      { id: '011_ozon_title_translation_workflow' },
      { id: '012_ozon_network_recovery_runtime_lease' },
      { id: '016_ozon_listing_management_source' }
    ]));

    const catalogRun = await repository.beginCatalogRun('MANUAL');
    expect(catalogRun.created).toBe(true);
    const concurrentCatalogRun = await repository.beginCatalogRun('MANUAL');
    expect(concurrentCatalogRun).toMatchObject({ created: false, run: { runId: catalogRun.run.runId } });
    await repository.completeCatalogRun(catalogRun.run.runId, [{
      descriptionCategoryId: 17028922,
      typeId: 970642857,
      categoryNameZh: '运动鞋',
      typeNameZh: '休闲运动鞋',
      categoryNameRu: 'Обувь',
      typeNameRu: 'Кроссовки',
      pathZh: ['鞋靴', '运动鞋', '休闲运动鞋'],
      pathRu: ['Обувь', 'Кроссовки'],
      displayPathZh: '鞋靴 → 运动鞋 → 休闲运动鞋',
      displayPathRu: 'Обувь → Кроссовки'
    }], [{
      directory: 'countries',
      attributeId: 4389,
      dictionaryId: 1935,
      valueId: 9001,
      nameRu: 'Китай',
      nameZh: '中国',
      position: 0
    }], '/tmp/ozon-catalog.json', `sha256:${'a'.repeat(64)}`, 2);
    await expect(repository.searchCatalogEntries('运动鞋')).resolves.toEqual([
      expect.objectContaining({ catalogEntryId: '17028922:970642857', displayPathZh: '鞋靴 → 运动鞋 → 休闲运动鞋' })
    ]);
    await expect(repository.getCatalogEntry('17028922:970642857')).resolves.toMatchObject({ typeNameRu: 'Кроссовки' });
    await expect(repository.catalogOverview()).resolves.toMatchObject({
      entryCount: 1,
      chineseMissingCount: 2,
      dictionaryCounts: { countries: 1, seasons: 0, kinds: 0, colors: 0 }
    });
    await expect(repository.searchCatalogDictionary('countries', { dictionaryId: 1935 })).resolves.toEqual([
      expect.objectContaining({ valueId: 9001, nameZh: '中国', nameRu: 'Китай' })
    ]);

    const categoryInput = {
      categoryKey: 'adult_sneakers',
      nameRu: 'Кроссовки',
      nameZh: '运动鞋',
      descriptionCategoryId: 17028922,
      typeId: 970642857,
      attributes: [
        { id: 10, name: 'Бренд', type: 'String', required: true },
        { id: 9048, name: 'Название модели', type: 'String', required: false },
        { id: 8229, name: 'Тип', type: 'Dictionary', required: false },
        { id: 20, name: 'Размер', type: 'Dictionary', required: true, complexId: 100 }
      ],
      confirmedBy: 'integration-test'
    };
    await repository.createCategory(categoryInput);
    const category = await repository.publishCategory(categoryInput.categoryKey, 'integration-test');
    expect(category.publishedVersion?.versionNo).toBe(1);
    const reordered = await repository.saveCategoryAttributeOrder(category.categoryKey, {
      rowVersion: category.rowVersion,
      attributeKeys: ['20:100', '10:0', '9048:0', '8229:0']
    });
    expect(reordered.draftVersion).toMatchObject({
      versionNo: 2,
      snapshot: { attributes: [{ id: 20, complexId: 100 }, { id: 10, complexId: 0 }, { id: 9048, complexId: 0 }, { id: 8229, complexId: 0 }] }
    });
    expect(reordered.publishedVersion?.snapshot.attributes.map((attribute) => attribute.id)).toEqual([10, 9048, 8229, 20]);
    await expect(repository.saveCategoryAttributeOrder(category.categoryKey, {
      rowVersion: category.rowVersion,
      attributeKeys: ['10:0', '20:100', '9048:0', '8229:0']
    })).rejects.toMatchObject({ code: 'TASK_LOCKED', statusCode: 409 });

    const initializedVariantId = randomUUID();
    const initialized = await repository.createListing(
      { sku: '0000011', productName: 'OZON 初始化测试商品' },
      undefined,
      {
        brand: '无品牌',
        sharedAttributes: [{ attributeId: 8229, complexId: 0, values: [{ dictionaryValueId: category.typeId }] }],
        offers: [{
          variantId: initializedVariantId,
          productVariantId: initializedVariantId,
          productVariantName: '初始化变体',
          variantCode: '01',
          offerId: stableOzonOfferId('0000011', '01'),
          price: 385.33,
          oldPrice: 770.65,
          minPrice: 192.66,
          stock: 18,
          attributes: [],
          media: []
        }]
      }
    );
    expect(initialized.data).toMatchObject({
      brand: '无品牌',
      offers: [{ modelGroup: '0000011', price: 385.33, oldPrice: 770.65, minPrice: 192.66, stock: 18 }]
    });
    expect(initialized.managementSource).toBe('MANUAL');
    const repeatedInitialization = await repository.createListing(
      { sku: '0000011', productName: 'OZON 初始化测试商品' },
      undefined,
      { brand: '不应覆盖', offers: [] }
    );
    expect(repeatedInitialization.data.brand).toBe('无品牌');
    expect(repeatedInitialization.data.offers).toHaveLength(1);

    const insertOnlyVariantId = randomUUID();
    const insertOnlyListing = await repository.createListingIfAbsent(
      { sku: '0000098', productName: 'OZON 原子创建测试商品' },
      undefined,
      {
        brand: '无品牌',
        offers: [{
          variantId: insertOnlyVariantId,
          productVariantId: insertOnlyVariantId,
          productVariantName: '原子创建变体',
          variantCode: '01',
          offerId: stableOzonOfferId('0000098', '01'),
          price: 1,
          stock: 0,
          attributes: [],
          media: []
        }]
      }
    );
    expect(insertOnlyListing).toMatchObject({
      sku: '0000098', managementSource: 'AUTO', status: 'DRAFT', rowVersion: 1, revision: 1
    });
    await expect(repository.createListingIfAbsent(
      { sku: '0000098', productName: '不应覆盖的并发草稿' },
      undefined,
      { brand: '不应覆盖' }
    )).rejects.toMatchObject({
      code: 'TASK_LOCKED',
      statusCode: 409,
      details: { sku: '0000098', reasonCode: 'OZON_LISTING_CREATED_CONCURRENTLY' }
    });
    await expect(repository.getListing('0000098')).resolves.toMatchObject({
      productName: 'OZON 原子创建测试商品',
      managementSource: 'AUTO',
      data: { brand: '无品牌' }
    });
    await expect(repository.listListings({ source: 'MANUAL' })).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ sku: '0000011', managementSource: 'MANUAL' })])
    });
    await expect(repository.listListings({ source: 'AUTO' })).resolves.toMatchObject({
      items: [expect.objectContaining({ sku: '0000098', managementSource: 'AUTO' })]
    });

    const managedResolution = {
      source: 'PROCUREMENT' as const,
      effectiveGrossWeightGrams: 650.5,
      procurementGrossWeightGrams: 650.5,
      presetGrossWeightGrams: 700,
      procurementVersionId: '22222222-2222-4222-8222-222222222222',
      procurementVersionNo: 8,
      procurementCapturedAt: '2026-08-07T01:02:03.000Z'
    };
    const managedPresetSnapshot = {
      presetId: '33333333-3333-4333-8333-333333333333',
      presetName: 'OZON 毛重联动预设',
      presetRowVersion: 3,
      capturedAt: '2026-08-07T01:02:03.000Z',
      definition: ozonPresetInputSchema.parse({
        name: 'OZON 毛重联动预设',
        categoryKey: category.categoryKey,
        pricingTemplateId: '44444444-4444-4444-8444-444444444444',
        shippingTemplateId: '55555555-5555-4555-8555-555555555555',
        shippingServiceCode: 'CEL_RFBS_ECONOMY',
        dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 700, weightUnit: 'g' }
      })
    };
    const managedPricingResolution = {
      targetCurrency: 'CNY' as const,
      pricingTemplateId: managedPresetSnapshot.definition.pricingTemplateId,
      pricingTemplateVersionId: '77777777-7777-4777-8777-777777777777',
      pricingTemplateVersionNo: 5,
      shippingTemplateId: managedPresetSnapshot.definition.shippingTemplateId,
      shippingTemplateVersionId: '88888888-8888-4888-8888-888888888888',
      shippingTemplateVersionNo: 3,
      shippingServiceCode: managedPresetSnapshot.definition.shippingServiceCode,
      optionId: 'frozen-cny-option',
      capturedAt: '2026-08-07T01:02:03.000Z'
    };
    const managedInitialization = {
      status: 'COMPLETE' as const,
      initializedAt: '2026-08-07T01:02:03.000Z',
      issues: [],
      grossWeightResolution: managedResolution,
      presetSnapshot: managedPresetSnapshot,
      pricingResolution: managedPricingResolution
    };
    const managedVariantId = randomUUID();
    let managedListing = await repository.createListing(
      { sku: '0000091', productName: 'OZON 毛重联动测试商品' },
      undefined,
      {
        dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 650.5, weightUnit: 'g' },
        initialization: managedInitialization,
        offers: [{
          variantId: managedVariantId,
          productVariantId: managedVariantId,
          productVariantName: '毛重联动变体',
          variantCode: '01',
          offerId: stableOzonOfferId('0000091', '01'),
          price: 1,
          stock: 0,
          attributes: [],
          media: []
        }]
      } as any
    );
    expect(managedListing.data).toMatchObject({
      dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 650.5, weightUnit: 'g' },
      initialization: {
        grossWeightResolution: managedResolution,
        presetSnapshot: managedPresetSnapshot,
        pricingResolution: managedPricingResolution
      }
    });
    await expect(repository.createListing(
      { sku: '0000094', productName: 'OZON 无效毛重审计测试商品' },
      undefined,
      {
        dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 700, weightUnit: 'g' },
        initialization: {
          ...managedInitialization,
          grossWeightResolution: { ...managedResolution, effectiveGrossWeightGrams: 700 }
        }
      } as any
    )).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });

    await expect(repository.updateListing(managedListing.sku, {
      ...managedListing.data,
      rowVersion: managedListing.rowVersion,
      initialization: {
        ...managedListing.data.initialization!,
        grossWeightResolution: {
          ...managedResolution,
          effectiveGrossWeightGrams: 999,
          procurementGrossWeightGrams: 999
        }
      }
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });
    await expect(repository.updateListing(managedListing.sku, {
      ...managedListing.data,
      rowVersion: managedListing.rowVersion,
      initialization: {
        ...managedListing.data.initialization!,
        presetSnapshot: { ...managedPresetSnapshot, presetName: '客户端伪造预设' }
      }
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });
    await expect(repository.updateListing(managedListing.sku, {
      ...managedListing.data,
      rowVersion: managedListing.rowVersion,
      initialization: {
        ...managedListing.data.initialization!,
        pricingResolution: { ...managedPricingResolution, optionId: 'client-forged-option' }
      }
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });
    const clientInitialization = { ...managedListing.data.initialization } as Record<string, unknown>;
    delete clientInitialization.grossWeightResolution;
    delete clientInitialization.presetSnapshot;
    delete clientInitialization.pricingResolution;
    managedListing = await repository.updateListing(managedListing.sku, {
      ...managedListing.data,
      rowVersion: managedListing.rowVersion,
      initialization: clientInitialization as any,
      dimensions: {
        ...managedListing.data.dimensions!,
        length: 310,
        width: 205,
        height: 125,
        dimensionUnit: 'mm'
      }
    });
    expect(managedListing.data).toMatchObject({
      dimensions: { length: 310, width: 205, height: 125, dimensionUnit: 'mm', weight: 650.5, weightUnit: 'g' },
      initialization: {
        grossWeightResolution: managedResolution,
        presetSnapshot: managedPresetSnapshot,
        pricingResolution: managedPricingResolution
      }
    });
    await expect(repository.updateListing(managedListing.sku, {
      ...managedListing.data,
      rowVersion: managedListing.rowVersion,
      dimensions: { ...managedListing.data.dimensions!, weight: 651 }
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });
    await expect(repository.updateListing(managedListing.sku, {
      ...managedListing.data,
      rowVersion: managedListing.rowVersion,
      dimensions: { ...managedListing.data.dimensions!, weightUnit: 'kg' }
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });

    const refreshedResolution = {
      ...managedResolution,
      effectiveGrossWeightGrams: 720,
      procurementGrossWeightGrams: 720,
      procurementVersionId: '66666666-6666-4666-8666-666666666666',
      procurementVersionNo: 9,
      procurementCapturedAt: '2026-08-07T02:03:04.000Z'
    };
    const refreshedPresetSnapshot = {
      ...managedPresetSnapshot,
      presetRowVersion: 4,
      capturedAt: '2026-08-07T02:03:04.000Z'
    };
    const grossWeightRefreshVariantId = randomUUID();
    let grossWeightRefreshListing = await repository.createListing(
      { sku: '0000095', productName: 'OZON 毛重联动刷新测试商品' },
      undefined,
      {
        dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 650.5, weightUnit: 'g' },
        initialization: managedInitialization,
        offers: [{
          variantId: grossWeightRefreshVariantId,
          productVariantId: grossWeightRefreshVariantId,
          productVariantName: '毛重刷新变体',
          variantCode: '01',
          offerId: stableOzonOfferId('0000095', '01'),
          price: 1,
          stock: 0,
          attributes: [],
          media: []
        }]
      } as any
    );
    const validRefreshInput = {
      ...grossWeightRefreshListing.data,
      rowVersion: grossWeightRefreshListing.rowVersion,
      dimensions: { ...grossWeightRefreshListing.data.dimensions!, weight: 720, weightUnit: 'g' as const },
      initialization: {
        ...grossWeightRefreshListing.data.initialization!,
        grossWeightResolution: refreshedResolution,
        presetSnapshot: refreshedPresetSnapshot
      }
    };
    await expect(repository.updateListing(grossWeightRefreshListing.sku, validRefreshInput))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });

    const incompleteRefreshInitialization = {
      ...grossWeightRefreshListing.data.initialization!,
      grossWeightResolution: refreshedResolution
    } as Record<string, unknown>;
    delete incompleteRefreshInitialization.presetSnapshot;
    await expect(repository.updateListing(grossWeightRefreshListing.sku, {
      ...validRefreshInput,
      initialization: incompleteRefreshInitialization as any
    }, { allowGrossWeightRefresh: true }))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });

    grossWeightRefreshListing = await repository.updateListing(
      grossWeightRefreshListing.sku,
      validRefreshInput,
      { allowGrossWeightRefresh: true }
    );
    expect(grossWeightRefreshListing.data).toMatchObject({
      dimensions: { weight: 720, weightUnit: 'g' },
      initialization: {
        grossWeightResolution: refreshedResolution,
        presetSnapshot: refreshedPresetSnapshot
      }
    });

    const bypassResolution = {
      ...refreshedResolution,
      effectiveGrossWeightGrams: 730,
      procurementGrossWeightGrams: 730,
      procurementVersionId: '77777777-7777-4777-8777-777777777777',
      procurementVersionNo: 10,
      procurementCapturedAt: '2026-08-07T03:04:05.000Z'
    };
    await expect(repository.updateListing(grossWeightRefreshListing.sku, {
      ...grossWeightRefreshListing.data,
      rowVersion: grossWeightRefreshListing.rowVersion,
      dimensions: { ...grossWeightRefreshListing.data.dimensions!, weight: 729, weightUnit: 'g' },
      initialization: {
        ...grossWeightRefreshListing.data.initialization!,
        grossWeightResolution: bypassResolution,
        presetSnapshot: {
          ...refreshedPresetSnapshot,
          presetRowVersion: 5,
          capturedAt: '2026-08-07T03:04:05.000Z'
        }
      }
    }, { allowGrossWeightRefresh: true }))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });
    await admin.query(`DELETE FROM ${schema}.ozon_listing_drafts WHERE sku=$1`, [grossWeightRefreshListing.sku]);

    const fallbackResolution = {
      ...managedResolution,
      source: 'PRESET_FALLBACK' as const,
      effectiveGrossWeightGrams: 700,
      procurementGrossWeightGrams: null
    };
    const fallbackListing = await repository.createListing(
      { sku: '0000092', productName: 'OZON 预设毛重兜底测试商品' },
      undefined,
      {
        dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 700, weightUnit: 'g' },
        initialization: { ...managedInitialization, grossWeightResolution: fallbackResolution },
        offers: [integrationSharedOffer('0000092', '预设毛重兜底变体')]
      } as any
    );
    expect(fallbackListing.data.initialization).toMatchObject({ grossWeightResolution: fallbackResolution });

    let historicalListing = await repository.createListing(
      { sku: '0000093', productName: 'OZON 历史毛重草稿测试商品' },
      undefined,
      {
        dimensions: { length: 12, width: 8, height: 4, dimensionUnit: 'in', weight: 2, weightUnit: 'lb' },
        offers: [integrationSharedOffer('0000093', '历史毛重变体')]
      }
    );
    historicalListing = await repository.updateListing(historicalListing.sku, {
      ...historicalListing.data,
      rowVersion: historicalListing.rowVersion,
      dimensions: { length: 40, width: 30, height: 20, dimensionUnit: 'cm', weight: 650.5, weightUnit: 'g' },
      initialization: managedInitialization
    }, { allowPricingResolutionRefresh: true });
    expect(historicalListing.data.initialization).not.toHaveProperty('grossWeightResolution');
    expect(historicalListing.data.dimensions).toMatchObject({ weight: 650.5, weightUnit: 'g' });
    historicalListing = await repository.updateListing(historicalListing.sku, {
      ...historicalListing.data,
      rowVersion: historicalListing.rowVersion,
      initialization: managedInitialization
    }, { allowGrossWeightInitialization: true });
    expect(historicalListing.data.initialization).toMatchObject({ grossWeightResolution: managedResolution });

    await repository.createJob({
      sku: managedListing.sku,
      source: 'MANUAL',
      revision: managedListing.revision,
      payload: {},
      state: 'SUCCEEDED'
    });
    const managedVersionsBeforeTamper = await admin.query<{ count: string }>(`
      SELECT COUNT(*)::text count FROM ${schema}.ozon_listing_versions WHERE sku=$1`,
    [managedListing.sku]);
    await admin.query(`
      UPDATE ${schema}.ozon_listing_drafts
      SET data=jsonb_set(data,'{dimensions,weight}','999'::jsonb)
      WHERE sku=$1`,
    [managedListing.sku]);
    await expect(repository.reserveSubmissionRevision(managedListing.sku, managedListing.rowVersion))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });
    const managedVersionsAfterTamper = await admin.query<{ count: string }>(`
      SELECT COUNT(*)::text count FROM ${schema}.ozon_listing_versions WHERE sku=$1`,
    [managedListing.sku]);
    expect(managedVersionsAfterTamper.rows[0]?.count).toBe(managedVersionsBeforeTamper.rows[0]?.count);

    await admin.query(`
      UPDATE ${schema}.ozon_listing_drafts
      SET data=jsonb_set(data,'{initialization,grossWeightResolution,source}','"PROCUREMENT"'::jsonb)
      WHERE sku=$1`,
    [fallbackListing.sku]);
    await expect(repository.reserveSubmissionRevision(fallbackListing.sku, fallbackListing.rowVersion))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });

    const variantId = randomUUID();
    let listing = await repository.createListing(
      { sku: '0000010', productName: 'OZON 集成测试商品' },
      undefined,
      { offers: [integrationSharedOffer('0000010', '集成测试变体', variantId)] }
    );
    const offerId = stableOzonOfferId(listing.sku, '01');
    const imageAsset = {
      assetId: 'image-01', relativePath: 'variants/shared/01.png', kind: 'image' as const, mimeType: 'image/png',
      sizeBytes: 100, sha256: 'a'.repeat(64), modifiedAt: '2026-07-27T00:00:00.000Z', validationStatus: 'VALID' as const
    };
    const videoAsset = {
      assetId: 'video-01', relativePath: 'variants/shared/main.mp4', kind: 'video' as const, mimeType: 'video/mp4',
      sizeBytes: 200, sha256: 'b'.repeat(64), modifiedAt: '2026-07-27T00:00:00.000Z', validationStatus: 'VALID' as const
    };
    const draft = {
      rowVersion: listing.rowVersion,
      categoryKey: category.categoryKey,
      categoryVersionId: category.publishedVersion!.id,
      fulfillmentMode: 'FBS',
      warehouseId: '10001',
      currency: 'RUB',
      vat: '0.2',
      titleRu: 'Тестовый товар',
      descriptionRu: 'Описание товара',
      brand: 'MerchRoute',
      dimensions: { length: 300, width: 200, height: 120, dimensionUnit: 'mm', weight: 700, weightUnit: 'g' },
      purchaseMeasurements: {
        procurementVersionId: '11111111-1111-4111-8111-111111111111',
        procurementVersionNo: 7,
        capturedAt: '2026-08-05T03:00:00.000Z',
        productHeightCm: '16',
        productDepthCm: '8.5',
        productWidthCm: '24',
        netWeightGrams: '750'
      },
      sharedAttributes: [
        { attributeId: 10, complexId: 0, values: [{ value: 'MerchRoute' }] },
        { attributeId: 5299, complexId: 0, values: [{ value: '16' }] },
        { attributeId: 6573, complexId: 0, values: [{ value: '8.5' }] },
        { attributeId: 5355, complexId: 0, values: [{ value: '24' }] },
        { attributeId: 4383, complexId: 0, values: [{ value: '750' }] },
        { attributeId: 23249, complexId: 0, values: [{ value: '6' }] }
      ],
      offers: [{
        variantId,
        productVariantId: variantId,
        productVariantName: '集成测试变体',
        variantCode: '01',
        offerId,
        price: 2_990,
        stock: 10,
        attributes: [{ attributeId: 20, complexId: 100, values: [{ dictionaryValueId: 40 }] }],
        media: [
          { assetId: imageAsset.assetId, relativePath: imageAsset.relativePath, kind: 'image' as const, sortOrder: 0, isPrimary: true },
          { assetId: videoAsset.assetId, relativePath: videoAsset.relativePath, kind: 'video' as const, sortOrder: 1, isPrimary: false }
        ]
      }],
      mediaAssets: [imageAsset, videoAsset],
      mediaSourceRoot: '/tmp/ozon-media'
    };
    listing = await repository.updateListing(listing.sku, draft);
    expect(listing).toMatchObject({ rowVersion: 2, revision: 2, status: 'READY' });
    expect(listing.data.sharedAttributes).toEqual(expect.arrayContaining([
      { attributeId: 9048, complexId: 0, values: [{ value: listing.sku }] },
      { attributeId: 8229, complexId: 0, values: [{ dictionaryValueId: category.typeId }] },
      { attributeId: 5299, complexId: 0, values: [{ value: '16' }] },
      { attributeId: 6573, complexId: 0, values: [{ value: '8.5' }] },
      { attributeId: 5355, complexId: 0, values: [{ value: '24' }] },
      { attributeId: 4383, complexId: 0, values: [{ value: '750' }] },
      { attributeId: 23249, complexId: 0, values: [{ value: '6' }] }
    ]));
    expect(listing.data.purchaseMeasurements).toEqual({
      procurementVersionId: '11111111-1111-4111-8111-111111111111',
      procurementVersionNo: 7,
      capturedAt: '2026-08-05T03:00:00.000Z',
      productHeightCm: '16',
      productDepthCm: '8.5',
      productWidthCm: '24',
      netWeightGrams: '750'
    });
    const persistedPurchaseProjection = await admin.query<{ data: { purchaseMeasurements?: unknown; sharedAttributes?: Array<{ attributeId: number; values: unknown[] }> } }>(`
      SELECT data FROM ${schema}.ozon_listing_drafts WHERE sku=$1`, [listing.sku]);
    expect(persistedPurchaseProjection.rows[0]?.data.purchaseMeasurements).toEqual(listing.data.purchaseMeasurements);
    expect(persistedPurchaseProjection.rows[0]?.data.sharedAttributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ attributeId: 5299 }),
      expect.objectContaining({ attributeId: 6573 }),
      expect.objectContaining({ attributeId: 5355 }),
      expect.objectContaining({ attributeId: 4383 }),
      expect.objectContaining({ attributeId: 23249, values: [{ value: '6' }] })
    ]));
    expect(listing.data.offers).toEqual([
      expect.objectContaining({ modelGroup: listing.sku })
    ]);
    const beforeRejectedDescription = listing;
    await expect(repository.updateListing(listing.sku, {
      ...listing.data,
      rowVersion: listing.rowVersion,
      descriptionRu: 'Общее описание товара без лишних символов.',
      offers: listing.data.offers.map((candidate) => ({
        ...candidate,
        descriptionRu: 'с выраженной фактурой под荔枝纹.',
        descriptionSource: {
          type: 'E003', workflowCode: 'E003', executionId: 87829,
          fileName: '0000061.txt', sha256: 'c'.repeat(64), productVariantId: candidate.variantId
        }
      }))
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    listing = await repository.getListing(listing.sku);
    expect(listing).toMatchObject({
      rowVersion: beforeRejectedDescription.rowVersion,
      revision: beforeRejectedDescription.revision,
      data: beforeRejectedDescription.data
    });
    const historicalWarning = {
      code: 'OZON_DESCRIPTION_CJK_REMOVED' as const,
      fieldPath: 'descriptionRu',
      removedFragments: ['历史片段'],
      beforeSha256: 'a'.repeat(64),
      afterSha256: 'b'.repeat(64)
    };
    const unchangedDescription = 'Общее описание товара без лишних символов.';
    const appendedVariantId = randomUUID();
    listing = await repository.updateListing(listing.sku, {
      ...listing.data,
      rowVersion: listing.rowVersion,
      descriptionRu: unchangedDescription,
      descriptionWarnings: [historicalWarning]
    });
    expect(listing.data.descriptionRu).toBe(unchangedDescription);
    expect(listing.data.descriptionWarnings).toEqual([historicalWarning]);
    const api = Fastify();
    const publishing = new OzonPublishingService(repository, {} as any, api.log);
    await registerOzonRoutes(api, {
      ozon: repository,
      ozonPublishing: publishing,
      ozonAutoPublishing: {},
      ozonCatalog: {},
      pricing: {},
      shipping: {},
      config: { get: () => ({ stages: [] }) }
    } as any);
    try {
      const maliciousSave = await api.inject({
        method: 'PUT',
        url: `/api/v1/ozon/listings/${listing.sku}`,
        payload: {
          ...listing.data,
          categoryVersionId: undefined,
          rowVersion: listing.rowVersion,
          sharedAttributes: listing.data.sharedAttributes.map((attribute) => (
            attribute.attributeId === 9048
              ? { ...attribute, values: [{ value: '客户端伪造型号' }] }
              : attribute.attributeId === 8229
                ? { ...attribute, values: [{ value: listing.sku }] }
              : attribute
          )),
          offers: listing.data.offers.map((offer) => ({ ...offer, modelGroup: '客户端伪造分组' }))
        }
      });
      const listingBeforeMaliciousSave = listing;
      expect(maliciousSave.statusCode).toBe(409);
      expect(maliciousSave.json()).toMatchObject({ statusCode: 409, error: 'Conflict' });
      listing = await repository.getListing(listing.sku);
      expect(listing).toMatchObject(listingBeforeMaliciousSave);
    } finally {
      await api.close();
    }
    await expect(repository.listListings({ purchaseCreatedFrom: '2026-07-20T00:00:00.000Z', purchaseCreatedTo: '2026-07-21T00:00:00.000Z' })).resolves.toMatchObject({ total: 1 });
    await expect(repository.listListings({ purchaseCreatedFrom: '2026-07-21T00:00:00.000Z' })).resolves.toMatchObject({ total: 0 });
    await expect(repository.updateListing(listing.sku, draft)).rejects.toMatchObject({ code: 'TASK_LOCKED', statusCode: 409 });
    await expect(repository.updateListing(listing.sku, {
      ...draft,
      rowVersion: listing.rowVersion,
      offers: [{ ...draft.offers[0], offerId: `${offerId}-changed` }]
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });
    listing = await repository.updateListing(listing.sku, {
      ...draft,
      rowVersion: listing.rowVersion,
      offers: [...draft.offers, {
        ...draft.offers[0],
        variantId: appendedVariantId,
        productVariantId: appendedVariantId,
        productVariantName: '集成测试新增变体',
        variantCode: '02',
        offerId: stableOzonOfferId(listing.sku, '02')
      }]
    });
    expect(listing.data.offers).toHaveLength(2);
    expect(listing.data.offers.map((offer) => offer.media.map((asset) => asset.assetId))).toEqual([
      [imageAsset.assetId, videoAsset.assetId],
      [imageAsset.assetId, videoAsset.assetId]
    ]);

    const canonicalSku = '0000017';
    const canonicalVariantId = randomUUID();
    let canonicalListing = await repository.createListing(
      { sku: canonicalSku, productName: '无需迁移的商品' },
      undefined,
      { offers: [integrationSharedOffer(canonicalSku, '无需迁移变体', canonicalVariantId)] }
    );
    canonicalListing = await repository.updateListing(canonicalSku, {
      rowVersion: canonicalListing.rowVersion,
      categoryKey: category.categoryKey,
      categoryVersionId: category.publishedVersion!.id,
      fulfillmentMode: 'FBS',
      warehouseId: '',
      currency: 'RUB',
      vat: '0.2',
      titleRu: '',
      descriptionRu: '',
      brand: '',
      sharedAttributes: [{ attributeId: 9048, complexId: 0, values: [{ value: canonicalSku }] }],
      offers: [{
        variantId: canonicalVariantId,
        productVariantId: canonicalVariantId,
        productVariantName: '无需迁移变体',
        variantCode: '01',
        offerId: stableOzonOfferId(canonicalSku, '01'),
        barcode: '',
        modelGroup: canonicalSku,
        price: 1,
        stock: 0,
        attributes: [],
        media: []
      }],
      mediaAssets: [],
      mediaSourceRoot: ''
    });
    const canonicalBeforeMigration = {
      rowVersion: canonicalListing.rowVersion,
      revision: canonicalListing.revision
    };
    const historicalSnapshotsBefore = await admin.query(`
      SELECT id,revision,snapshot
      FROM ${schema}.ozon_listing_versions
      WHERE sku=$1
      ORDER BY revision`, [listing.sku]);
    const legacyRow = await admin.query<{ data: any; row_version: number; revision: number }>(`
      SELECT data,row_version,revision
      FROM ${schema}.ozon_listing_drafts
      WHERE sku=$1`, [listing.sku]);
    const legacyData = structuredClone(legacyRow.rows[0]!.data);
    legacyData.sharedAttributes = legacyData.sharedAttributes.map((attribute: any) => (
      attribute.attributeId === 9048
        ? { ...attribute, values: [{ value: `Тестовый товар ${listing.sku}` }] }
        : attribute
    ));
    legacyData.offers = legacyData.offers.map((offer: any) => ({
      ...offer,
      modelGroup: `${listing.sku}-model`
    }));
    await admin.query(`UPDATE ${schema}.ozon_listing_drafts SET data=$2::jsonb WHERE sku=$1`, [
      listing.sku,
      JSON.stringify(legacyData)
    ]);
    await admin.query(`DELETE FROM ${schema}.ozon_schema_migrations WHERE id='006_ozon_sku_model_identity'`);
    const modelIdentityMigrationReplay = new OzonRepository(isolatedConnectionString);
    await modelIdentityMigrationReplay.initialize();
    await modelIdentityMigrationReplay.close();

    const migratedListing = await repository.getListing(listing.sku);
    expect(migratedListing).toMatchObject({
      rowVersion: legacyRow.rows[0]!.row_version + 1,
      revision: legacyRow.rows[0]!.revision + 1
    });
    expect(migratedListing.data.sharedAttributes).toEqual(expect.arrayContaining([
      { attributeId: 9048, complexId: 0, values: [{ value: listing.sku }] }
    ]));
    expect(migratedListing.data.offers.every((offer) => offer.modelGroup === listing.sku)).toBe(true);
    const historicalSnapshotsAfter = await admin.query(`
      SELECT id,revision,snapshot
      FROM ${schema}.ozon_listing_versions
      WHERE sku=$1 AND revision<=$2
      ORDER BY revision`, [listing.sku, legacyRow.rows[0]!.revision]);
    expect(historicalSnapshotsAfter.rows).toEqual(historicalSnapshotsBefore.rows);
    const migratedSnapshots = await admin.query<{ count: string }>(`
      SELECT COUNT(*) count
      FROM ${schema}.ozon_listing_versions
      WHERE sku=$1`, [listing.sku]);
    expect(Number(migratedSnapshots.rows[0]!.count)).toBe(historicalSnapshotsBefore.rows.length + 1);
    await expect(repository.getListing(canonicalSku)).resolves.toMatchObject(canonicalBeforeMigration);

    await admin.query(`DELETE FROM ${schema}.ozon_schema_migrations WHERE id='006_ozon_sku_model_identity'`);
    const idempotentReplay = new OzonRepository(isolatedConnectionString);
    await idempotentReplay.initialize();
    await idempotentReplay.close();
    await expect(repository.getListing(listing.sku)).resolves.toMatchObject({
      rowVersion: migratedListing.rowVersion,
      revision: migratedListing.revision
    });
    await expect(repository.getListing(canonicalSku)).resolves.toMatchObject(canonicalBeforeMigration);
    const idempotentSnapshots = await admin.query<{ count: string }>(`
      SELECT COUNT(*) count
      FROM ${schema}.ozon_listing_versions
      WHERE sku=$1`, [listing.sku]);
    expect(Number(idempotentSnapshots.rows[0]!.count)).toBe(Number(migratedSnapshots.rows[0]!.count));

    const typeMigrationRow = await admin.query<{ data: any; row_version: number; revision: number }>(`
      SELECT data,row_version,revision
      FROM ${schema}.ozon_listing_drafts
      WHERE sku=$1`, [listing.sku]);
    const typeSnapshotsBefore = await admin.query(`
      SELECT id,revision,snapshot
      FROM ${schema}.ozon_listing_versions
      WHERE sku=$1
      ORDER BY revision`, [listing.sku]);
    const legacyTypeData = structuredClone(typeMigrationRow.rows[0]!.data);
    legacyTypeData.sharedAttributes = legacyTypeData.sharedAttributes.map((attribute: any) => (
      attribute.attributeId === 8229
        ? { attributeId: 8229, complexId: 0, values: [{ value: listing.sku }] }
        : attribute
    ));
    await admin.query(`UPDATE ${schema}.ozon_listing_drafts SET data=$2::jsonb WHERE sku=$1`, [
      listing.sku,
      JSON.stringify(legacyTypeData)
    ]);
    await admin.query(`DELETE FROM ${schema}.ozon_schema_migrations WHERE id='007_ozon_platform_type_identity'`);
    const typeIdentityMigrationReplay = new OzonRepository(isolatedConnectionString);
    await typeIdentityMigrationReplay.initialize();
    await typeIdentityMigrationReplay.close();

    const typeMigratedListing = await repository.getListing(listing.sku);
    expect(typeMigratedListing).toMatchObject({
      rowVersion: typeMigrationRow.rows[0]!.row_version + 1,
      revision: typeMigrationRow.rows[0]!.revision + 1
    });
    expect(typeMigratedListing.data.sharedAttributes).toEqual(expect.arrayContaining([
      { attributeId: 8229, complexId: 0, values: [{ dictionaryValueId: category.typeId }] }
    ]));
    expect(typeMigratedListing.data.sharedAttributes.find((attribute) => attribute.attributeId === 8229)?.values[0]).not.toHaveProperty('value');
    const typeHistoricalSnapshotsAfter = await admin.query(`
      SELECT id,revision,snapshot
      FROM ${schema}.ozon_listing_versions
      WHERE sku=$1 AND revision<=$2
      ORDER BY revision`, [listing.sku, typeMigrationRow.rows[0]!.revision]);
    expect(typeHistoricalSnapshotsAfter.rows).toEqual(typeSnapshotsBefore.rows);
    const typeMigratedSnapshots = await admin.query<{ count: string }>(`
      SELECT COUNT(*) count
      FROM ${schema}.ozon_listing_versions
      WHERE sku=$1`, [listing.sku]);
    expect(Number(typeMigratedSnapshots.rows[0]!.count)).toBe(typeSnapshotsBefore.rows.length + 1);
    await expect(repository.getListing(canonicalSku)).resolves.toMatchObject(canonicalBeforeMigration);

    await admin.query(`DELETE FROM ${schema}.ozon_schema_migrations WHERE id='007_ozon_platform_type_identity'`);
    const idempotentTypeReplay = new OzonRepository(isolatedConnectionString);
    await idempotentTypeReplay.initialize();
    await idempotentTypeReplay.close();
    await expect(repository.getListing(listing.sku)).resolves.toMatchObject({
      rowVersion: typeMigratedListing.rowVersion,
      revision: typeMigratedListing.revision
    });
    const idempotentTypeSnapshots = await admin.query<{ count: string }>(`
      SELECT COUNT(*) count
      FROM ${schema}.ozon_listing_versions
      WHERE sku=$1`, [listing.sku]);
    expect(Number(idempotentTypeSnapshots.rows[0]!.count)).toBe(Number(typeMigratedSnapshots.rows[0]!.count));
    listing = typeMigratedListing;

    const preset = await repository.createPreset({
      name: 'OZON 默认预设',
      categoryKey: category.categoryKey,
      pricingTemplateId: randomUUID(),
      shippingTemplateId: randomUUID(),
      shippingServiceCode: 'CEL_RFBS_ECONOMY',
      vat: '0.2',
      defaultStock: 10,
      dimensions: { length: 300, width: 200, height: 120, dimensionUnit: 'mm', weight: 700, weightUnit: 'g' }
    });
    expect(await repository.getPreset(preset.id)).toMatchObject({
      id: preset.id,
      titleTranslation: { workflowId: 'HDh0ZNLK2ps5qasR', language: '俄文', maxLength: 200 },
      sizes: [{ value: '', stock: 10 }]
    });
    const waitingPreset = await repository.createPreset({
      name: '非默认自动预设',
      categoryKey: category.categoryKey,
      pricingTemplateId: randomUUID(),
      shippingTemplateId: randomUUID(),
      shippingServiceCode: 'CEL_RFBS_ECONOMY',
      vat: '0.2',
      defaultStock: 10,
      dimensions: { length: 300, width: 200, height: 120, dimensionUnit: 'mm', weight: 700, weightUnit: 'g' }
    });
    expect(waitingPreset).toMatchObject({ name: '非默认自动预设' });

    // Exercise the real store-owned schema migrations before admitting an
    // automatic preparation. A hand-written partial ozon_stores table would
    // hide the store/publication columns and split active-task indexes owned by
    // migrations 013/017/018.
    const storeRepository = new OzonStoreRepository(isolatedConnectionString);
    await storeRepository.initialize();
    const migratedDefaultStore = await storeRepository.getStore('default');
    const automaticStore = await storeRepository.updateStore(migratedDefaultStore.id, {
      displayName: 'Integration automatic store',
      autoPublishEnabled: true,
      autoPublishMode: 'CREATE_ONLY',
      defaultPresetId: preset.id,
      warehouseId: 'integration-warehouse',
      warehouseName: 'Integration warehouse',
      fulfillmentMode: 'FBS',
      accountCurrency: 'RUB',
      maxDailyStyles: 100,
      rowVersion: migratedDefaultStore.rowVersion
    });
    const automaticStoreId = automaticStore.id;
    // This repository-only fixture injects a proven multistore admission below;
    // enable the row directly instead of manufacturing a credential vault and
    // remote preflight result that belong to OzonStoreRepository tests.
    await admin.query(`UPDATE ${schema}.ozon_stores SET enabled=true WHERE id=$1`, [automaticStoreId]);
    await storeRepository.close();
    let automaticAdmissionEnabled = true;
    let automaticAdmissionMode: 'CREATE_ONLY' | 'COMPATIBLE_UPSERT' = 'CREATE_ONLY';
    let automaticActivatedAt = '2026-01-01T00:00:00.000Z';
    const enqueueAutomaticJob = repository.enqueueAutomaticJob.bind(repository);
    vi.spyOn(repository, 'enqueueAutomaticJob').mockImplementation((input) => enqueueAutomaticJob({
      ...input,
      ...(automaticAdmissionEnabled ? {
        multistoreAdmission: {
          storeId: automaticStoreId,
          presetId: preset.id,
          activatedAt: automaticActivatedAt,
          autoPublishMode: automaticAdmissionMode
        }
      } : {})
    }));
    await admin.query(`UPDATE ${schema}.ozon_listing_presets
      SET definition=jsonb_set(definition,'{titleTranslation,workflowId}',to_jsonb($2::text),true)
      WHERE id=$1`, [preset.id, 'W2lSSXE3NUaLW1tD']);
    await admin.query(`UPDATE ${schema}.ozon_listing_presets
      SET definition=jsonb_set(definition,'{titleTranslation,workflowId}',to_jsonb($2::text),true)
      WHERE id=$1`, [waitingPreset.id, 'custom-ozon-title-workflow']);
    await admin.query(`DELETE FROM ${schema}.ozon_schema_migrations WHERE id='011_ozon_title_translation_workflow'`);
    const titleMigrationReplay = new OzonRepository(isolatedConnectionString);
    await titleMigrationReplay.initialize();
    expect(await titleMigrationReplay.getPreset(preset.id)).toMatchObject({
      titleTranslation: { workflowId: 'HDh0ZNLK2ps5qasR', maxLength: 200 }
    });
    expect(await titleMigrationReplay.getPreset(waitingPreset.id)).toMatchObject({
      titleTranslation: { workflowId: 'custom-ozon-title-workflow', maxLength: 200 }
    });
    const titleMigration = await admin.query<{ count: string }>(`
      SELECT COUNT(*)::text count FROM ${schema}.ozon_schema_migrations
      WHERE id='011_ozon_title_translation_workflow'`);
    expect(titleMigration.rows[0]?.count).toBe('1');
    await titleMigrationReplay.close();

    const gatedSku = '0000015';
    const disabledDelivery = {
      sourceStageId: 'E005',
      submissionId: 'disabled-images',
      variantId: '',
      deliveredAt: new Date().toISOString()
    };
    await expect(repository.enqueueAutomaticJob({ sku: gatedSku, media: disabledDelivery, mediaReady: false })).resolves.toEqual({
      job: undefined,
      becameRunnable: false,
      deferred: false
    });
    await expect(repository.findActiveJobBySku(gatedSku)).resolves.toBeUndefined();
    const ignoredWhileDisabled = await admin.query(`
      SELECT job_id,payload FROM ${schema}.ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4`,
    [gatedSku, disabledDelivery.sourceStageId, disabledDelivery.submissionId, disabledDelivery.variantId]);
    expect(ignoredWhileDisabled.rows).toEqual([
      expect.objectContaining({
        job_id: null,
        payload: expect.objectContaining({
          autoPublishDecision: 'IGNORED',
          autoPublishIgnoredReason: 'SYSTEM_DISABLED',
          autoPublishIgnoredAt: expect.any(String)
        })
      })
    ]);

    const restartedWhileDisabled = new OzonRepository(isolatedConnectionString);
    await restartedWhileDisabled.initialize();
    await expect(restartedWhileDisabled.enqueueAutomaticJob({ sku: gatedSku, media: disabledDelivery, mediaReady: false })).resolves.toEqual({
      job: undefined,
      becameRunnable: false,
      deferred: false
    });
    await restartedWhileDisabled.close();
    await expect(repository.findActiveJobBySku(gatedSku)).resolves.toBeUndefined();

    const manualGateSku = '0000016';
    const manualGateSignature = `sha256:${'d'.repeat(64)}`;
    const manualWhileDisabled = await repository.createManualJob({
      sku: manualGateSku,
      payload: { productJsonPath: '/tmp/manual-disabled.json', revision: 1 },
      revision: 1,
      directoryStage: 'INBOX',
      workRelPath: `inbox/${manualGateSku}`,
      directorySignature: manualGateSignature,
      state: 'READY'
    });
    await expect(repository.findInboxRoundJob(manualGateSku, 1, manualGateSignature)).resolves.toMatchObject({
      id: manualWhileDisabled.job.id,
      revision: 1,
      directoryStage: 'INBOX',
      directorySignature: manualGateSignature
    });
    await expect(repository.findInboxRoundJob('0000017', 1, manualGateSignature)).resolves.toBeUndefined();
    const manualGateBeforeDelivery = await repository.getJob(manualWhileDisabled.job.id);
    const deliveryBesideManual = {
      sourceStageId: 'E004',
      submissionId: 'disabled-beside-manual',
      variantId: '',
      deliveredAt: new Date().toISOString()
    };
    await expect(repository.enqueueAutomaticJob({ sku: manualGateSku, media: deliveryBesideManual, mediaReady: false })).resolves.toEqual({
      job: undefined,
      becameRunnable: false,
      deferred: false
    });
    await expect(repository.getJob(manualWhileDisabled.job.id)).resolves.toMatchObject({
      state: manualGateBeforeDelivery.state,
      rowVersion: manualGateBeforeDelivery.rowVersion,
      payload: manualGateBeforeDelivery.payload
    });
    const ignoredBesideManual = await admin.query(`
      SELECT job_id,payload FROM ${schema}.ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4`,
    [manualGateSku, deliveryBesideManual.sourceStageId, deliveryBesideManual.submissionId, deliveryBesideManual.variantId]);
    expect(ignoredBesideManual.rows).toEqual([
      expect.objectContaining({
        job_id: null,
        payload: expect.objectContaining({ autoPublishIgnoredReason: 'SYSTEM_DISABLED' })
      })
    ]);

    const enableSystem = async (enabled: boolean) => {
      const current = await repository.getSettings();
      return repository.updateSettings({
        rowVersion: current.rowVersion,
        enabled,
        rootDirectory: current.rootDirectory,
        taskApiWebhookUrl: current.taskApiWebhookUrl,
        adminApiWebhookUrl: current.adminApiWebhookUrl,
        preflightWebhookUrl: current.preflightWebhookUrl,
        imageUploaderWorkflowId: current.imageUploaderWorkflowId,
        storeGatewayWorkflowId: current.storeGatewayWorkflowId,
        imageUploadConcurrency: current.imageUploadConcurrency,
        videoUploadConcurrency: current.videoUploadConcurrency,
        videoPrewarmEnabled: current.videoPrewarmEnabled
      });
    };
    await enableSystem(true);
    await expect(repository.enqueueAutomaticJob({ sku: gatedSku, media: disabledDelivery, mediaReady: false })).resolves.toEqual({
      job: undefined,
      becameRunnable: false,
      deferred: false
    });
    await expect(repository.findActiveJobBySku(gatedSku)).resolves.toBeUndefined();

    const enabledDelivery = {
      sourceStageId: 'E005',
      submissionId: 'enabled-images',
      variantId: '',
      deliveredAt: new Date().toISOString()
    };
    const enabledResult = await repository.enqueueAutomaticJob({ sku: gatedSku, media: enabledDelivery, mediaReady: false });
    const enabledJob = enabledResult.job!;
    expect(enabledResult).toMatchObject({
      becameRunnable: false,
      job: {
        sku: gatedSku,
        source: 'AUTO',
        state: 'WAITING_MEDIA',
        payload: {
          presetId: preset.id,
          presetBinding: {
            schemaVersion: 1,
            presetId: preset.id,
            presetName: preset.name,
            activationStartedAt: expect.any(String),
            boundAt: expect.any(String),
            definitionHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            definition: expect.objectContaining({ autoPublishEnabled: true, isDefault: false })
          }
        }
      }
    });
    const presetBeforePolicyEdit = await repository.getPreset(preset.id);
    const presetDefinitionBeforePolicyEdit: Record<string, unknown> = { ...presetBeforePolicyEdit };
    for (const key of ['id', 'rowVersion', 'createdAt', 'updatedAt']) delete presetDefinitionBeforePolicyEdit[key];
    const editedPreset = await repository.updatePreset(preset.id, {
      ...presetDefinitionBeforePolicyEdit,
      defaultStock: presetBeforePolicyEdit.defaultStock + 1,
      rowVersion: presetBeforePolicyEdit.rowVersion
    });
    expect(editedPreset.defaultStock).toBe(11);
    await expect(repository.getJob(enabledJob.id)).resolves.toMatchObject({
      payload: {
        presetBinding: {
          presetId: preset.id,
          definition: expect.objectContaining({ defaultStock: 10 })
        }
      }
    });

    await enableSystem(false);
    const jobBeforeDisabledDelivery = await repository.getJob(enabledJob.id);
    const disabledWhileActive = {
      sourceStageId: 'E004',
      submissionId: 'disabled-video',
      variantId: '',
      deliveredAt: new Date().toISOString()
    };
    await expect(repository.enqueueAutomaticJob({ sku: gatedSku, media: disabledWhileActive, mediaReady: false })).resolves.toEqual({
      job: undefined,
      becameRunnable: false,
      deferred: false
    });
    await expect(repository.getJob(enabledJob.id)).resolves.toMatchObject({
      rowVersion: jobBeforeDisabledDelivery.rowVersion,
      payload: jobBeforeDisabledDelivery.payload
    });
    const ignoredWhileActive = await admin.query(`
      SELECT job_id,payload FROM ${schema}.ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4`,
    [gatedSku, disabledWhileActive.sourceStageId, disabledWhileActive.submissionId, disabledWhileActive.variantId]);
    expect(ignoredWhileActive.rows).toEqual([
      expect.objectContaining({
        job_id: null,
        payload: expect.objectContaining({ autoPublishIgnoredReason: 'SYSTEM_DISABLED' })
      })
    ]);

    await enableSystem(true);
    await expect(repository.enqueueAutomaticJob({ sku: gatedSku, media: disabledWhileActive, mediaReady: false })).resolves.toEqual({
      job: undefined,
      becameRunnable: false,
      deferred: false
    });
    const reenabledDelivery = {
      sourceStageId: 'E004',
      submissionId: 'reenabled-video',
      variantId: '',
      deliveredAt: new Date().toISOString()
    };
    const mergedAfterReenableResult = await repository.enqueueAutomaticJob({ sku: gatedSku, media: reenabledDelivery, mediaReady: false });
    const mergedAfterReenable = mergedAfterReenableResult.job!;
    expect(mergedAfterReenableResult.becameRunnable).toBe(false);
    expect(mergedAfterReenable).toMatchObject({ id: enabledJob.id, source: 'AUTO', state: 'WAITING_MEDIA' });
    expect((mergedAfterReenable.payload!.mediaDeliveries as unknown[])).toHaveLength(2);
    const mediaIncomplete = await repository.transitionJob(mergedAfterReenable.id, {
      rowVersion: mergedAfterReenable.rowVersion,
      state: 'WAITING_MEDIA',
      eventType: 'MEDIA_INCOMPLETE',
      message: '集成测试等待媒体',
      errorCode: 'MEDIA_INCOMPLETE',
      errorMessage: '集成测试等待视频',
      nextAttemptAt: new Date(Date.now() + 60_000).toISOString()
    });
    await expect(repository.savePreflight({ credentialReady: true, status: 'READY' }))
      .rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 410 });
    const duplicateAfterReady = await repository.enqueueAutomaticJob({
      sku: gatedSku,
      media: reenabledDelivery,
      mediaReady: true
    });
    expect(duplicateAfterReady).toMatchObject({
      becameRunnable: false,
      job: {
        id: mediaIncomplete.id,
        state: 'WAITING_MEDIA',
        rowVersion: mediaIncomplete.rowVersion,
        lastErrorCode: 'MEDIA_INCOMPLETE'
      }
    });
    const awakenedByMedia = await repository.enqueueAutomaticJob({
      sku: gatedSku,
      mediaReady: true,
      media: {
        sourceStageId: 'E005',
        submissionId: 'wake-waiting-media',
        variantId: '',
        deliveredAt: new Date().toISOString()
      }
    });
    expect(awakenedByMedia).toMatchObject({
      becameRunnable: true,
      job: {
        id: mediaIncomplete.id,
        state: 'READY'
      }
    });
    expect(awakenedByMedia.job).not.toHaveProperty('lastErrorCode');
    expect(awakenedByMedia.job).not.toHaveProperty('lastErrorMessage');
    expect(awakenedByMedia.job).not.toHaveProperty('nextAttemptAt');
    await expect(repository.deleteCategory(category.categoryKey)).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });

    const listingOfferIds = listing.data.offers.map((offer) => offer.offerId);
    const job = await repository.createJob({
      sku: listing.sku,
      source: 'MANUAL',
      offerId,
      offerIds: listingOfferIds,
      revision: listing.revision,
      payload: { revision: listing.revision, offerIds: listingOfferIds },
      state: 'READY'
    });
    await expect(repository.listJobs({ purchaseCreatedFrom: '2026-07-20T00:00:00.000Z', purchaseCreatedTo: '2026-07-21T00:00:00.000Z' })).resolves.toMatchObject({ total: 1 });
    await expect(repository.listJobs({ purchaseCreatedFrom: '2026-07-21T00:00:00.000Z' })).resolves.toMatchObject({ total: 0 });
    await expect(repository.listJobs({ purchaseCreatedFrom: 'invalid-date' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(repository.listJobs({ purchaseCreatedFrom: '2026-07-21T00:00:00.000Z', purchaseCreatedTo: '2026-07-20T00:00:00.000Z' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    const manualJobs = await repository.listManualJobsForSku(listing.sku, { pageSize: 100 });
    expect(manualJobs.items).toEqual([expect.objectContaining({ id: job.id, source: 'MANUAL' })]);
    const automaticJobs = await repository.listJobs({ source: 'AUTO', pageSize: 100 });
    expect(automaticJobs.items.every((item) => item.source === 'AUTO')).toBe(true);
    expect(automaticJobs.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: job.id })]));
    const update = await repository.recordN8nUpdate(job.id, {
      rowVersion: job.rowVersion,
      state: 'SUCCEEDED',
      eventType: 'PUBLISH_SUCCEEDED',
      message: '平台状态已读回',
      productMappings: listingOfferIds.map((currentOfferId, index) => ({
        offerId: currentOfferId,
        ozonProductId: String(900001 + index),
        ozonSku: String(1000001 + index),
        warehouseId: '10001',
        platformStatus: 'PUBLISHED'
      })),
      lastAppliedRevision: listing.revision,
      platformStatus: 'PUBLISHED',
      stageStates: { import: 'SUCCEEDED', moderation: 'SUCCEEDED', images: 'SUCCEEDED', price: 'SUCCEEDED', stock: 'SUCCEEDED' }
    });
    expect(update.mapping).toMatchObject({
      storeAlias: 'default',
      offerId,
      sku: listing.sku,
      ozonProductId: '900001',
      status: 'PUBLISHED'
    });
    expect(update.mappings).toHaveLength(2);
    await expect(repository.getProductMapping('default', offerId)).resolves.toMatchObject({ ozonSku: '1000001' });
    await expect(repository.hasProductMappingForSku('default', listing.sku)).resolves.toBe(true);
    await expect(repository.getJob(job.id)).resolves.toMatchObject({
      state: 'SUCCEEDED',
      ozonProductUrl: 'https://www.ozon.ru/product/1000001/',
      offerIds: listingOfferIds,
      ozonProductLinks: [
        { offerId: listingOfferIds[0], ozonProductId: '900001', ozonSku: '1000001', url: 'https://www.ozon.ru/product/1000001/' },
        { offerId: listingOfferIds[1], ozonProductId: '900002', ozonSku: '1000002', url: 'https://www.ozon.ru/product/1000002/' }
      ],
      events: [
        expect.objectContaining({ eventType: 'JOB_CREATED' }),
        expect.objectContaining({ eventType: 'PUBLISH_SUCCEEDED' })
      ]
    });
    const originalMapping = (await admin.query(`SELECT status,status_snapshot FROM ${schema}.ozon_product_mappings
      WHERE store_alias='default' AND offer_id=$1`, [listingOfferIds[0]])).rows[0];
    await admin.query(`UPDATE ${schema}.ozon_product_mappings SET
      status='NOT_FOR_SALE',status_snapshot=$2::jsonb,last_verified_at=NOW(),updated_at=NOW()
      WHERE store_alias='default' AND offer_id=$1`, [listingOfferIds[0], JSON.stringify({
      displayState: 'NOT_FOR_SALE', businessState: 'NEEDS_ATTENTION', visible: false,
      statusName: 'Не продается', statusDescription: 'Не продается'
    })]);
    await expect(repository.getJob(job.id)).resolves.toMatchObject({
      ozonProductLinks: [
        expect.objectContaining({ offerId: listingOfferIds[0], displayState: 'NOT_FOR_SALE', platformMessage: 'Не продается' }),
        expect.objectContaining({ offerId: listingOfferIds[1] })
      ]
    });
    await expect(repository.listManualJobsForSku(listing.sku, { pageSize: 100 })).resolves.toMatchObject({
      items: [expect.objectContaining({
        id: job.id,
        ozonProductLinks: [
          expect.objectContaining({ offerId: listingOfferIds[0], displayState: 'NOT_FOR_SALE' }),
          expect.objectContaining({ offerId: listingOfferIds[1] })
        ]
      })]
    });
    await admin.query(`UPDATE ${schema}.ozon_product_mappings SET status=$2,status_snapshot=$3::jsonb,updated_at=NOW()
      WHERE store_alias='default' AND offer_id=$1`, [listingOfferIds[0], originalMapping.status, JSON.stringify(originalMapping.status_snapshot || {})]);
    await expect(repository.listListings({ query: listing.sku })).resolves.toMatchObject({
      items: [expect.objectContaining({
        ozonProductLinks: [
          expect.objectContaining({ offerId: listingOfferIds[0], ozonProductId: '900001', ozonSku: '1000001', url: 'https://www.ozon.ru/product/1000001/', lastVerifiedAt: expect.any(String) }),
          expect.objectContaining({ offerId: listingOfferIds[1], ozonProductId: '900002', ozonSku: '1000002', url: 'https://www.ozon.ru/product/1000002/', lastVerifiedAt: expect.any(String) })
        ]
      })]
    });
    const beforeNextRound = await repository.getListing(listing.sku);
    const nextRound = await repository.reserveSubmissionRevision(listing.sku, beforeNextRound.rowVersion);
    expect(nextRound.revision).toBe(beforeNextRound.revision + 1);
    expect(nextRound.data.offers.map((offer) => offer.offerId)).toEqual(beforeNextRound.data.offers.map((offer) => offer.offerId));

    automaticAdmissionMode = 'COMPATIBLE_UPSERT';
    const compatibleMissingVariantId = randomUUID();
    await admin.query(`INSERT INTO ${schema}.product_variants(id,sku,name,normalized_name,sort_order)
      VALUES($1,$2,'兼容追加新变体','兼容追加新变体',99)`, [compatibleMissingVariantId, listing.sku]);

    const automaticResult = await repository.enqueueAutomaticJob({
      sku: listing.sku,
      mediaReady: false,
      media: { sourceStageId: 'E005', submissionId: 'images-1', variantId: compatibleMissingVariantId, deliveredAt: new Date().toISOString() }
    });
    const automatic = automaticResult.job!;
    const mergedResult = await repository.enqueueAutomaticJob({
      sku: listing.sku,
      mediaReady: false,
      media: { sourceStageId: 'E004', submissionId: 'video-1', variantId: compatibleMissingVariantId, deliveredAt: new Date().toISOString() }
    });
    const merged = mergedResult.job!;
    expect(automaticResult.becameRunnable).toBe(false);
    expect(mergedResult.becameRunnable).toBe(false);
    expect(automatic).toMatchObject({ source: 'AUTO', state: 'WAITING_MEDIA' });
    expect(merged).toMatchObject({ id: automatic.id, payload: { mediaDeliveries: expect.any(Array) } });
    expect((merged.payload!.mediaDeliveries as unknown[])).toHaveLength(2);
    const readyBackoffAt = new Date(Date.now() + 60_000).toISOString();
    const scheduled = await repository.transitionJob(merged.id, {
      rowVersion: merged.rowVersion,
      state: 'READY',
      eventType: 'RETRY_SCHEDULED',
      message: '集成测试重试',
      jobPayload: { productJsonPath: '/tmp/product.json' },
      nextAttemptAt: readyBackoffAt,
      errorCode: 'VERIFY_FAILED',
      errorMessage: '集成测试根错误必须保留',
      incrementRetry: true
    });
    expect(scheduled).toMatchObject({
      retryCount: 1,
      payload: { productJsonGenerated: true },
      lastErrorCode: 'VERIFY_FAILED',
      lastErrorMessage: '集成测试根错误必须保留',
      nextAttemptAt: readyBackoffAt
    });
    expect(scheduled.payload).not.toHaveProperty('productJsonPath');
    await expect(repository.listRunnableAutomaticJobs()).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ id: scheduled.id })]));

    const readyDelivery = {
      sourceStageId: 'E005',
      submissionId: 'images-ready-future-backoff',
      variantId: compatibleMissingVariantId,
      deliveredAt: new Date().toISOString()
    };
    const readyMerge = await repository.enqueueAutomaticJob({ sku: listing.sku, media: readyDelivery, mediaReady: true });
    expect(readyMerge).toMatchObject({
      becameRunnable: false,
      deferred: true,
      job: {
        id: scheduled.id,
        state: 'READY',
        rowVersion: scheduled.rowVersion,
        retryCount: scheduled.retryCount,
        lastErrorCode: scheduled.lastErrorCode,
        lastErrorMessage: scheduled.lastErrorMessage,
        nextAttemptAt: readyBackoffAt
      }
    });
    expect((readyMerge.job!.payload!.mediaDeliveries as unknown[])).toHaveLength(2);
    const readyDuplicate = await repository.enqueueAutomaticJob({ sku: listing.sku, media: readyDelivery, mediaReady: true });
    expect(readyDuplicate).toMatchObject({
      becameRunnable: false,
      deferred: true,
      job: { id: scheduled.id, rowVersion: readyMerge.job!.rowVersion }
    });
    expect((readyDuplicate.job!.payload!.mediaDeliveries as unknown[])).toHaveLength(2);

    const attentionBackoffAt = new Date(Date.now() + 120_000).toISOString();
    const attention = await repository.transitionJob(readyDuplicate.job!.id, {
      rowVersion: readyDuplicate.job!.rowVersion,
      state: 'NEEDS_ATTENTION',
      eventType: 'KNOWN_ROOT_ERROR',
      message: '集成测试人工关注',
      errorCode: 'OZON_STATE_MACHINE_FAILED',
      errorMessage: '集成测试人工关注根错误',
      nextAttemptAt: attentionBackoffAt
    });
    const attentionMediaBefore = attention.payload!.media;
    const attentionMerge = await repository.enqueueAutomaticJob({
      sku: listing.sku,
      mediaReady: true,
      media: {
        sourceStageId: 'E004',
        submissionId: 'video-needs-attention',
        variantId: compatibleMissingVariantId,
        deliveredAt: new Date().toISOString()
      }
    });
    expect(attentionMerge).toMatchObject({
      becameRunnable: false,
      deferred: true,
      job: {
        state: 'NEEDS_ATTENTION',
        retryCount: attention.retryCount,
        lastErrorCode: attention.lastErrorCode,
        lastErrorMessage: attention.lastErrorMessage,
        nextAttemptAt: attentionBackoffAt,
        payload: { media: attentionMediaBefore }
      }
    });
    expect((attentionMerge.job!.payload!.mediaDeliveries as unknown[])).toHaveLength(2);

    const remote = await repository.transitionJob(attentionMerge.job!.id, {
      rowVersion: attentionMerge.job!.rowVersion,
      state: 'IMPORTING',
      eventType: 'REMOTE_IMPORT_STARTED',
      message: '集成测试已有远端导入状态',
      importTaskId: 'integration-import-task',
      errorCode: 'REMOTE_ROOT_ERROR',
      errorMessage: '集成测试远端根错误',
      nextAttemptAt: attentionBackoffAt
    });
    const remoteMediaBefore = remote.payload!.media;
    const remoteMerge = await repository.enqueueAutomaticJob({
      sku: listing.sku,
      mediaReady: true,
      media: {
        sourceStageId: 'E005',
        submissionId: 'images-remote-state',
        variantId: compatibleMissingVariantId,
        deliveredAt: new Date().toISOString()
      }
    });
    expect(remoteMerge).toMatchObject({
      becameRunnable: false,
      deferred: true,
      job: {
        state: 'IMPORTING',
        importTaskId: 'integration-import-task',
        lastErrorCode: remote.lastErrorCode,
        lastErrorMessage: remote.lastErrorMessage,
        nextAttemptAt: attentionBackoffAt,
        payload: { media: remoteMediaBefore }
      }
    });
    expect((remoteMerge.job!.payload!.mediaDeliveries as unknown[])).toHaveLength(2);

    await admin.query(`
      UPDATE ${schema}.ozon_publish_jobs
      SET state='WAITING_MEDIA',import_task_id=NULL,lease_owner='ozon-media-integration',lease_token=NULL,
          lease_expires_at=NULL,row_version=row_version+1,updated_at=NOW()
      WHERE id=$1`, [remoteMerge.job!.id]);
    const leased = await repository.getJob(remoteMerge.job!.id);
    const leasedMediaBefore = leased.payload!.media;
    const leasedDelivery = {
      sourceStageId: 'E004' as const,
      submissionId: 'video-active-lease',
      variantId: compatibleMissingVariantId,
      deliveredAt: new Date().toISOString()
    };
    const leasedMerge = await repository.enqueueAutomaticJob({
      sku: listing.sku,
      mediaReady: true,
      media: leasedDelivery
    });
    expect(leasedMerge).toMatchObject({
      becameRunnable: false,
      deferred: true,
      job: {
        state: 'WAITING_MEDIA',
        leaseOwner: 'ozon-media-integration',
        retryCount: leased.retryCount,
        lastErrorCode: leased.lastErrorCode,
        lastErrorMessage: leased.lastErrorMessage,
        nextAttemptAt: attentionBackoffAt,
        payload: { media: leasedMediaBefore }
      }
    });
    expect((leasedMerge.job!.payload!.mediaDeliveries as unknown[])).toHaveLength(2);

    // A preflight media signature is only an observation of the current
    // manifest. It must not permanently freeze a WAITING_MEDIA preparation
    // after a concurrent E004/E005 delivery was deferred by a short lease.
    const leaseRaceSku = '0000084';
    const leaseRaceVariantId = randomUUID();
    const leaseRaceVideo = {
      sourceStageId: 'E004' as const,
      submissionId: 'lease-race-video',
      variantId: leaseRaceVariantId,
      deliveredAt: new Date().toISOString()
    };
    const leaseRaceImages = {
      sourceStageId: 'E005' as const,
      submissionId: 'lease-race-images',
      variantId: leaseRaceVariantId,
      deliveredAt: new Date().toISOString()
    };
    const leaseRaceCreated = await repository.enqueueAutomaticJob({
      sku: leaseRaceSku,
      mediaReady: false,
      media: leaseRaceVideo
    });
    expect(leaseRaceCreated.job).toBeTruthy();
    await admin.query(`
      UPDATE ${schema}.ozon_publish_jobs
      SET lease_owner='ozon-media-integration',lease_expires_at=NOW()+INTERVAL '1 minute',
          row_version=row_version+1,updated_at=NOW()
      WHERE id=$1`, [leaseRaceCreated.job!.id]);
    await expect(repository.enqueueAutomaticJob({
      sku: leaseRaceSku,
      mediaReady: true,
      media: leaseRaceImages
    })).resolves.toMatchObject({
      job: { id: leaseRaceCreated.job!.id },
      deferred: true
    });
    await admin.query(`
      UPDATE ${schema}.ozon_publish_jobs
      SET lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
          payload=payload || '{"mediaSignature":"preflight-only-signature"}'::jsonb,
          row_version=row_version+1,updated_at=NOW()
      WHERE id=$1`, [leaseRaceCreated.job!.id]);
    const reboundAfterLease = await repository.enqueueAutomaticJob({
      sku: leaseRaceSku,
      mediaReady: true,
      media: leaseRaceImages
    });
    expect(reboundAfterLease).toMatchObject({
      job: { id: leaseRaceCreated.job!.id, state: 'READY' },
      becameRunnable: true,
      deferred: false
    });
    expect((await admin.query(`
      SELECT job_id,payload->>'autoPublishDecision' AS decision
      FROM ${schema}.ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4`, [
      leaseRaceSku,
      leaseRaceImages.sourceStageId,
      leaseRaceImages.submissionId,
      leaseRaceImages.variantId
    ])).rows[0]).toEqual({
      job_id: leaseRaceCreated.job!.id,
      decision: 'ACCEPTED'
    });

    automaticAdmissionMode = 'CREATE_ONLY';
    for (const [index, recovery] of [false, true].entries()) {
      const replaySku = `000008${index + 5}`;
      const boundDelivery = {
        sourceStageId: 'E004' as const,
        submissionId: `frozen-bound-${recovery ? 'recovery' : 'ordinary'}`,
        variantId: randomUUID(),
        deliveredAt: new Date().toISOString()
      };
      const createdBound = await repository.enqueueAutomaticJob({
        sku: replaySku,
        media: boundDelivery,
        mediaReady: false
      });
      expect(createdBound.job).toBeTruthy();
      await admin.query(`
        UPDATE ${schema}.ozon_publish_jobs
        SET state='NEEDS_ATTENTION',
            payload=CASE WHEN $2 THEN payload || '{"recovery":{"kind":"PREVIOUSLY_ACCEPTED_VARIANT_MEDIA"}}'::jsonb ELSE payload END,
            last_error_code='TEST_FROZEN',last_error_message='test',row_version=row_version+1,updated_at=NOW()
        WHERE id=$1`, [createdBound.job!.id, recovery]);
      const frozenBefore = await admin.query(`
        SELECT row_version,payload,updated_at::text AS updated_at_exact FROM ${schema}.ozon_publish_jobs WHERE id=$1`,
      [createdBound.job!.id]);
      const deliveryBefore = await admin.query(`
        SELECT job_id,payload,updated_at::text AS updated_at_exact FROM ${schema}.ozon_media_deliveries
        WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4`,
      [replaySku, boundDelivery.sourceStageId, boundDelivery.submissionId, boundDelivery.variantId]);
      const eventCountBefore = await admin.query<{ count: number }>(`
        SELECT COUNT(*)::int AS count FROM ${schema}.ozon_publish_events WHERE job_id=$1`, [createdBound.job!.id]);

      const replayed = await repository.enqueueAutomaticJob({ sku: replaySku, media: boundDelivery, mediaReady: false });
      expect(replayed).toMatchObject({
        job: { id: createdBound.job!.id, state: 'NEEDS_ATTENTION' },
        becameRunnable: false,
        deferred: false
      });
      expect((await admin.query(`
        SELECT row_version,payload,updated_at::text AS updated_at_exact FROM ${schema}.ozon_publish_jobs WHERE id=$1`,
      [createdBound.job!.id])).rows).toEqual(frozenBefore.rows);
      expect((await admin.query(`
        SELECT job_id,payload,updated_at::text AS updated_at_exact FROM ${schema}.ozon_media_deliveries
        WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4`,
      [replaySku, boundDelivery.sourceStageId, boundDelivery.submissionId, boundDelivery.variantId])).rows).toEqual(deliveryBefore.rows);
      expect((await admin.query<{ count: number }>(`
        SELECT COUNT(*)::int AS count FROM ${schema}.ozon_publish_events WHERE job_id=$1`, [createdBound.job!.id])).rows)
        .toEqual(eventCountBefore.rows);

      const childJobId = randomUUID();
      await admin.query(`INSERT INTO ${schema}.ozon_publish_jobs(
        id,sku,state,source,store_alias,store_id,task_kind,created_at,updated_at
      ) VALUES($1,$2,'READY','AUTO','default','00000000-0000-4000-8000-000000000002','STORE_PUBLICATION',
        NOW()+INTERVAL '1 second',NOW()+INTERVAL '1 second')`, [childJobId, replaySku]);
      const replayedWithNewerChild = await repository.enqueueAutomaticJob({
        sku: replaySku,
        media: boundDelivery,
        mediaReady: false
      });
      expect(replayedWithNewerChild).toMatchObject({
        job: { id: createdBound.job!.id, state: 'NEEDS_ATTENTION', taskKind: 'SHARED_PREPARATION' },
        becameRunnable: false,
        deferred: false
      });
      expect((await admin.query(`
        SELECT job_id,payload,updated_at::text AS updated_at_exact FROM ${schema}.ozon_media_deliveries
        WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4`,
      [replaySku, boundDelivery.sourceStageId, boundDelivery.submissionId, boundDelivery.variantId])).rows)
        .toEqual(deliveryBefore.rows);
      await admin.query(`UPDATE ${schema}.ozon_publish_jobs SET state='SUCCEEDED',finished_at=NOW() WHERE id=$1`, [childJobId]);

      const newDelivery = {
        ...boundDelivery,
        submissionId: `${boundDelivery.submissionId}-new`
      };
      await expect(repository.enqueueAutomaticJob({ sku: replaySku, media: newDelivery, mediaReady: false }))
        .resolves.toMatchObject({
          job: { id: createdBound.job!.id, state: 'NEEDS_ATTENTION' },
          becameRunnable: false,
          deferred: true
        });
      const deferredNew = await admin.query(`
        SELECT job_id,payload FROM ${schema}.ozon_media_deliveries
        WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4`,
      [replaySku, newDelivery.sourceStageId, newDelivery.submissionId, newDelivery.variantId]);
      expect(deferredNew.rows[0]).toMatchObject({
        job_id: null,
        payload: {
          autoPublishDecision: 'DEFERRED',
          autoPublishDeferredReason: 'ACTIVE_JOB_FROZEN',
          blockingJobId: createdBound.job!.id
        }
      });
    }
    const lateSku = '0000088';
    const representedVariantId = randomUUID();
    const missingVariantId = randomUUID();
    const frozenJobId = randomUUID();
    await admin.query(`
      INSERT INTO ${schema}.ozon_listing_drafts(sku,product_name_snapshot,status,data)
      VALUES($1,'三变体测试商品','PUBLISHED',$2::jsonb)`, [
      lateSku,
      JSON.stringify({ offers: [{ offerId: `${lateSku}-01`, variantId: representedVariantId, productVariantId: representedVariantId }] })
    ]);
    await admin.query(`
      INSERT INTO ${schema}.ozon_publish_jobs(id,sku,state,source,store_alias,listing_revision)
      VALUES($1,$2,'IMPORTING','AUTO','default',2)`, [frozenJobId, lateSku]);
    const lateDelivery = {
      sourceStageId: 'E005',
      submissionId: 'late-missing-variant-images',
      variantId: missingVariantId,
      deliveredAt: new Date().toISOString()
    };
    // Reproduce the historical 0000105 failure shape: late media was already bound to
    // a frozen one-offer job even though that product variant was absent from its listing.
    await admin.query(`
      INSERT INTO ${schema}.ozon_media_deliveries(
        sku,source_stage_id,submission_id,variant_id,job_id,payload
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [
      lateSku,
      lateDelivery.sourceStageId,
      lateDelivery.submissionId,
      lateDelivery.variantId,
      frozenJobId,
      JSON.stringify(lateDelivery)
    ]);
    expect(await repository.listDeferredAutomaticMediaDeliveries()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sku: lateSku,
        sourceStageId: lateDelivery.sourceStageId,
        submissionId: lateDelivery.submissionId,
        variantId: lateDelivery.variantId
      })
    ]));
    const deferredLate = await repository.enqueueAutomaticJob({ sku: lateSku, media: lateDelivery, mediaReady: false });
    expect(deferredLate).toMatchObject({
      deferred: true,
      becameRunnable: false,
      job: { id: frozenJobId, state: 'IMPORTING' }
    });
    const deferredRow = await admin.query(`
      SELECT job_id,payload,updated_at FROM ${schema}.ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4`,
    [lateSku, lateDelivery.sourceStageId, lateDelivery.submissionId, lateDelivery.variantId]);
    expect(deferredRow.rows[0]).toMatchObject({
      job_id: null,
      payload: expect.objectContaining({ autoPublishDecision: 'DEFERRED', blockingJobId: frozenJobId })
    });
    await enableSystem(false);
    await expect(repository.enqueueAutomaticJob({ sku: lateSku, media: lateDelivery, mediaReady: false })).resolves.toEqual({
      job: undefined,
      becameRunnable: false,
      deferred: true
    });
    await enableSystem(true);
    await repository.enqueueAutomaticJob({ sku: lateSku, media: lateDelivery, mediaReady: false });
    const duplicateDeferredRow = await admin.query(`
      SELECT job_id,payload,updated_at FROM ${schema}.ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4`,
    [lateSku, lateDelivery.sourceStageId, lateDelivery.submissionId, lateDelivery.variantId]);
    expect(duplicateDeferredRow.rows[0]).toMatchObject({
      job_id: null,
      payload: {
        autoPublishDecision: 'DEFERRED',
        autoPublishAcceptanceId: deferredRow.rows[0]?.payload.autoPublishAcceptanceId,
        autoPublishAcceptedAt: deferredRow.rows[0]?.payload.autoPublishAcceptedAt
      }
    });
    expect(new Date(duplicateDeferredRow.rows[0]?.updated_at).getTime())
      .toBeGreaterThanOrEqual(new Date(deferredRow.rows[0]?.updated_at).getTime());
    await admin.query(`UPDATE ${schema}.ozon_publish_jobs SET state='SUCCEEDED',finished_at=NOW() WHERE id=$1`, [frozenJobId]);
    // CREATE_ONLY is a store-publication rule. Once multistore admission has
    // been proven, shared intake must create the next preparation round and
    // defer the mode-specific Offer check to per-store materialization.
    const lateNextRound = await repository.enqueueAutomaticJob({ sku: lateSku, media: lateDelivery, mediaReady: false });
    expect(lateNextRound).toMatchObject({
      deferred: false,
      becameRunnable: false,
      job: { sku: lateSku, source: 'AUTO', state: 'WAITING_MEDIA', taskKind: 'SHARED_PREPARATION' }
    });
    expect(lateNextRound.job?.id).not.toBe(frozenJobId);
    const reboundRow = await admin.query(`
      SELECT job_id,payload FROM ${schema}.ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4`,
    [lateSku, lateDelivery.sourceStageId, lateDelivery.submissionId, lateDelivery.variantId]);
    expect(reboundRow.rows[0]?.job_id).toBe(lateNextRound.job?.id);
    expect(reboundRow.rows[0]?.payload).toMatchObject({
      autoPublishDecision: 'ACCEPTED',
      autoPublishAcceptedAt: expect.any(String),
      autoPublishAcceptedByJobId: lateNextRound.job?.id,
      autoPublishAcceptedPresetId: preset.id,
      autoPublishAcceptedActivationStartedAt: expect.any(String),
      autoPublishAcceptedPresetRowVersion: expect.any(Number),
      autoPublishAcceptedDefinitionHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    });

    // Legacy accepted rows did not carry an explicit decision. Their original AUTO
    // round and frozen preset binding are still sufficient proof, but only while the
    // row remains associated with that historical round.
    await admin.query(`
      UPDATE ${schema}.ozon_media_deliveries
      SET payload=$5::jsonb,updated_at=NOW()
      WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4`,
    [lateSku, lateDelivery.sourceStageId, lateDelivery.submissionId, lateDelivery.variantId, JSON.stringify(lateDelivery)]);
    await admin.query(`
      UPDATE ${schema}.ozon_publish_jobs SET state='SUCCEEDED',finished_at=NOW(),updated_at=NOW()
      WHERE id=$1`, [lateNextRound.job?.id]);
    automaticActivatedAt = new Date(Date.parse(lateDelivery.deliveredAt) + 1_000).toISOString();

    const acceptedReplay = await repository.enqueueAutomaticJob({ sku: lateSku, media: lateDelivery, mediaReady: false });
    expect(acceptedReplay).toMatchObject({
      deferred: false,
      becameRunnable: false,
      job: { sku: lateSku, source: 'AUTO', state: 'WAITING_MEDIA' }
    });
    expect(acceptedReplay.job?.id).not.toBe(lateNextRound.job?.id);
    const acceptedReplayRow = await admin.query(`
      SELECT job_id,payload FROM ${schema}.ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4`,
    [lateSku, lateDelivery.sourceStageId, lateDelivery.submissionId, lateDelivery.variantId]);
    expect(acceptedReplayRow.rows[0]).toMatchObject({
      job_id: acceptedReplay.job?.id,
      payload: {
        autoPublishDecision: 'ACCEPTED',
        autoPublishAcceptedByJobId: lateNextRound.job?.id,
        autoPublishAcceptedActivationStartedAt: expect.any(String)
      }
    });

    await admin.query(`UPDATE ${schema}.ozon_publish_jobs SET state='SUCCEEDED',finished_at=NOW() WHERE id=$1`, [acceptedReplay.job?.id]);
    automaticAdmissionEnabled = false;
    await expect(repository.enqueueAutomaticJob({ sku: lateSku, media: lateDelivery, mediaReady: false })).resolves.toEqual({
      job: undefined,
      becameRunnable: false,
      deferred: true
    });
    const acceptedWhileDisabled = await admin.query(`
      SELECT job_id,payload FROM ${schema}.ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4`,
    [lateSku, lateDelivery.sourceStageId, lateDelivery.submissionId, lateDelivery.variantId]);
    expect(acceptedWhileDisabled.rows[0]).toMatchObject({
      job_id: null,
      payload: {
        autoPublishDecision: 'DEFERRED',
        autoPublishDeferredReason: 'STORE_SETTINGS_REQUIRED',
        autoPublishAcceptedByJobId: lateNextRound.job?.id
      }
    });
    automaticAdmissionEnabled = true;
    automaticActivatedAt = '2026-01-01T00:00:00.000Z';

    const representedSku = '0000089';
    const sizedVariantId = randomUUID();
    const representedTerminalJobId = randomUUID();
    const sizedOfferIds = [`${representedSku}-01`, `${representedSku}-02`];
    await admin.query(`
      INSERT INTO ${schema}.ozon_listing_drafts(sku,product_name_snapshot,status,data)
      VALUES($1,'同变体多规格商品','PUBLISHED',$2::jsonb)`, [
      representedSku,
      JSON.stringify({
        offers: sizedOfferIds.map((offerId) => ({ offerId, variantId: sizedVariantId, productVariantId: sizedVariantId }))
      })
    ]);
    await admin.query(`
      INSERT INTO ${schema}.ozon_publish_jobs(id,sku,state,source,store_alias,listing_revision,finished_at)
      VALUES($1,$2,'SUCCEEDED','AUTO','default',2,NOW())`, [representedTerminalJobId, representedSku]);
    for (const [index, offerId] of sizedOfferIds.entries()) {
      await admin.query(`
        INSERT INTO ${schema}.ozon_product_mappings(
          store_alias,offer_id,sku,ozon_product_id,ozon_sku,last_applied_revision,status
        ) VALUES('default',$1,$2,$3,$4,2,'ON_SALE')`, [
        offerId, representedSku, `730000${index + 1}`, `740000${index + 1}`
      ]);
    }
    const mappedHistoryDelivery = {
      sourceStageId: 'E005',
      submissionId: 'mapped-terminal-history',
      variantId: sizedVariantId,
      deliveredAt: new Date(Date.parse(automaticActivatedAt) + 1_000).toISOString()
    };
    await admin.query(`
      INSERT INTO ${schema}.ozon_media_deliveries(
        sku,source_stage_id,submission_id,variant_id,job_id,payload
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [
      representedSku,
      mappedHistoryDelivery.sourceStageId,
      mappedHistoryDelivery.submissionId,
      mappedHistoryDelivery.variantId,
      representedTerminalJobId,
      JSON.stringify(mappedHistoryDelivery)
    ]);
    const representedPreparation = await repository.enqueueAutomaticJob({
      sku: representedSku, media: mappedHistoryDelivery, mediaReady: true
    });
    expect(representedPreparation).toMatchObject({
      becameRunnable: true,
      deferred: false,
      job: { sku: representedSku, state: 'READY', taskKind: 'SHARED_PREPARATION' }
    });
    const acceptedMappedHistory = await admin.query(`
      SELECT job_id,payload FROM ${schema}.ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4`, [
      representedSku,
      mappedHistoryDelivery.sourceStageId,
      mappedHistoryDelivery.submissionId,
      mappedHistoryDelivery.variantId
    ]);
    expect(acceptedMappedHistory.rows[0]).toMatchObject({
      job_id: representedPreparation.job?.id,
      payload: {
        autoPublishDecision: 'ACCEPTED',
        autoPublishAcceptedByJobId: representedPreparation.job?.id
      }
    });
    expect(await repository.listDeferredAutomaticMediaDeliveries()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        sku: representedSku,
        sourceStageId: mappedHistoryDelivery.sourceStageId,
        submissionId: mappedHistoryDelivery.submissionId,
        variantId: mappedHistoryDelivery.variantId
      })
    ]));
    await expect(repository.findActiveJobBySku(representedSku)).resolves.toMatchObject({
      id: representedPreparation.job?.id,
      taskKind: 'SHARED_PREPARATION'
    });

    await admin.query(`DELETE FROM ${schema}.ozon_product_mappings WHERE store_alias='default' AND offer_id=$1`, [sizedOfferIds[1]]);
    const incompleteHistoryDelivery = {
      ...mappedHistoryDelivery,
      submissionId: 'incomplete-terminal-history',
      deliveredAt: new Date(Date.parse(automaticActivatedAt) + 2_000).toISOString()
    };
    await admin.query(`
      INSERT INTO ${schema}.ozon_media_deliveries(
        sku,source_stage_id,submission_id,variant_id,job_id,payload
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [
      representedSku,
      incompleteHistoryDelivery.sourceStageId,
      incompleteHistoryDelivery.submissionId,
      incompleteHistoryDelivery.variantId,
      representedTerminalJobId,
      JSON.stringify(incompleteHistoryDelivery)
    ]);
    await expect(repository.enqueueAutomaticJob({
      sku: representedSku, media: incompleteHistoryDelivery, mediaReady: true
    })).resolves.toMatchObject({
      job: { id: representedPreparation.job?.id, state: 'READY', taskKind: 'SHARED_PREPARATION' },
      becameRunnable: false,
      deferred: false
    });
    const acceptedIncompleteHistory = await admin.query(`
      SELECT job_id,payload FROM ${schema}.ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4`, [
      representedSku,
      incompleteHistoryDelivery.sourceStageId,
      incompleteHistoryDelivery.submissionId,
      incompleteHistoryDelivery.variantId
    ]);
    expect(acceptedIncompleteHistory.rows[0]).toMatchObject({
      job_id: representedPreparation.job?.id,
      payload: {
        autoPublishDecision: 'ACCEPTED',
        autoPublishAcceptedByJobId: representedPreparation.job?.id
      }
    });

    const expectedLateOfferIds = [`${lateSku}-01`, `${lateSku}-02`, `${lateSku}-03`];
    const submittedLateOfferIds = [`${lateSku}-02`, `${lateSku}-03`];
    const expectedLateSnapshots = expectedLateOfferIds.map((currentOfferId) => ({
      offerId: currentOfferId,
      productVariantId: randomUUID(),
      disposition: submittedLateOfferIds.includes(currentOfferId) ? 'SUBMITTED' : 'PRESERVED_EXISTING',
      price: 100,
      oldPrice: 200,
      minPrice: 90,
      stock: 1,
      descriptionRu: 'Описание варианта.',
      media: { imageCount: 1, videoCount: 1 },
      ...(submittedLateOfferIds.includes(currentOfferId) ? {} : { mapping: { ozonProductId: '7100001', ozonSku: '7200001' } })
    }));
    const offerContractBody = {
      offerContractVersion: 1,
      expectedOfferIds: expectedLateOfferIds,
      submittedOfferIds: submittedLateOfferIds,
      publishOfferIds: submittedLateOfferIds,
      expectedOfferSnapshots: expectedLateSnapshots
    };
    const offerContractHash = `sha256:${createHash('sha256').update(testStableJson(offerContractBody)).digest('hex')}`;
    const frozenScopeJob = await repository.transitionJob(lateNextRound.job!.id, {
      rowVersion: lateNextRound.job!.rowVersion,
      state: 'READY',
      eventType: 'PRODUCT_JSON_GENERATED',
      message: '集成测试冻结双集合合同',
      offerIds: expectedLateOfferIds,
      jobPayload: {
        ...offerContractBody,
        offerContractHash,
        offerIds: expectedLateOfferIds
      }
    });
    await expect(repository.transitionJob(frozenScopeJob.id, {
      rowVersion: frozenScopeJob.rowVersion,
      state: 'READY',
      eventType: 'INVALID_SCOPE_SHRINK',
      message: '不应允许缩小集合',
      offerIds: submittedLateOfferIds
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(repository.transitionJob(frozenScopeJob.id, {
      rowVersion: frozenScopeJob.rowVersion,
      state: 'READY',
      eventType: 'INVALID_PARTIAL_CONTRACT',
      message: '不应允许部分覆盖合同',
      jobPayload: { expectedOfferIds: expectedLateOfferIds }
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(repository.recordN8nUpdate(frozenScopeJob.id, {
      rowVersion: frozenScopeJob.rowVersion,
      state: 'SUCCEEDED',
      eventType: 'INVALID_PARTIAL_SUCCESS',
      message: '不应允许只回写 submitted 映射',
      offerIds: expectedLateOfferIds,
      productMappings: submittedLateOfferIds.map((currentOfferId, index) => ({
        offerId: currentOfferId,
        ozonProductId: String(7300002 + index),
        ozonSku: String(7400002 + index)
      }))
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(repository.recordN8nUpdate(frozenScopeJob.id, {
      rowVersion: frozenScopeJob.rowVersion,
      state: 'SUCCEEDED',
      eventType: 'INVALID_DUPLICATE_MAPPING',
      message: '不应允许跨 Offer 共用平台映射',
      offerIds: expectedLateOfferIds,
      productMappings: expectedLateOfferIds.map((currentOfferId, index) => ({
        offerId: currentOfferId,
        ozonProductId: index < 2 ? '7500001' : '7500003',
        ozonSku: String(7600001 + index)
      }))
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });

    const activeIndexes = await admin.query<{ indexname: string; indexdef: string }>(`
      SELECT indexname,indexdef FROM pg_indexes
      WHERE schemaname=$1 AND indexname IN (
        'ozon_publish_jobs_one_active_per_sku',
        'ozon_publish_jobs_one_active_shared_preparation',
        'ozon_publish_jobs_one_active_publication_per_store_sku'
      ) ORDER BY indexname`, [schema]);
    expect(activeIndexes.rows.map((row) => row.indexname)).toEqual([
      'ozon_publish_jobs_one_active_publication_per_store_sku',
      'ozon_publish_jobs_one_active_shared_preparation'
    ]);
    const sharedPreparationIndex = activeIndexes.rows.find((row) => row.indexname === 'ozon_publish_jobs_one_active_shared_preparation')?.indexdef || '';
    const storePublicationIndex = activeIndexes.rows.find((row) => row.indexname === 'ozon_publish_jobs_one_active_publication_per_store_sku')?.indexdef || '';
    expect(sharedPreparationIndex).toMatch(/UNIQUE INDEX.*\(sku\)/);
    expect(sharedPreparationIndex).toContain('SHARED_PREPARATION');
    expect(storePublicationIndex).toMatch(/UNIQUE INDEX.*\(store_id, sku\)/);
    expect(storePublicationIndex).toContain('STORE_PUBLICATION');
    await admin.query(`
      INSERT INTO ${schema}.ozon_publish_jobs(
        id,sku,state,source,task_kind,store_alias,store_id,credential_binding_mode
      ) VALUES
        ($1,'0000099','READY','AUTO','SHARED_PREPARATION','default',$3,'PURE_LEGACY'),
        ($2,'0000099','WAITING_MEDIA','MANUAL','STORE_PUBLICATION','default',$3,'PURE_LEGACY')`, [
      randomUUID(), randomUUID(), automaticStoreId
    ]);
    await expect(admin.query(`
      INSERT INTO ${schema}.ozon_publish_jobs(
        id,sku,state,source,task_kind,store_alias,store_id,credential_binding_mode
      ) VALUES($1,'0000099','WAITING_MEDIA','AUTO','SHARED_PREPARATION','default',$2,'PURE_LEGACY')`, [
      randomUUID(), automaticStoreId
    ])).rejects.toMatchObject({ code: '23505' });
    await expect(admin.query(`
      INSERT INTO ${schema}.ozon_publish_jobs(
        id,sku,state,source,task_kind,store_alias,store_id,credential_binding_mode
      ) VALUES($1,'0000099','READY','MANUAL','STORE_PUBLICATION','default',$2,'PURE_LEGACY')`, [
      randomUUID(), automaticStoreId
    ])).rejects.toMatchObject({ code: '23505' });
    await admin.query(`DELETE FROM ${schema}.ozon_publish_jobs WHERE sku='0000099'`);

    const backfillKey = { sourceStageId: 'E005', submissionId: 'images-1', variantId: compatibleMissingVariantId };
    await admin.query(`
      DELETE FROM ${schema}.ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4`,
    [listing.sku, backfillKey.sourceStageId, backfillKey.submissionId, backfillKey.variantId]);
    const migrationReplay = new OzonRepository(isolatedConnectionString);
    await migrationReplay.initialize();
    await migrationReplay.close();
    const restoredDelivery = await admin.query(`
      SELECT job_id,payload FROM ${schema}.ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4`,
    [listing.sku, backfillKey.sourceStageId, backfillKey.submissionId, backfillKey.variantId]);
    expect(restoredDelivery.rows).toEqual([
      expect.objectContaining({ job_id: automatic.id, payload: expect.objectContaining(backfillKey) })
    ]);

    const takeoverSku = '0000011';
    const waitingAutoResult = await repository.enqueueAutomaticJob({
      sku: takeoverSku,
      mediaReady: false,
      media: { sourceStageId: 'E005', submissionId: 'takeover-images', variantId: '', deliveredAt: new Date().toISOString() }
    });
    const waitingAuto = waitingAutoResult.job!;
    expect(waitingAutoResult.becameRunnable).toBe(false);
    expect(waitingAuto).toMatchObject({ source: 'AUTO', state: 'WAITING_MEDIA' });
    expect(repository.canManualTakeover(waitingAuto)).toBe(true);
    const takeover = await repository.createManualJob({
      sku: takeoverSku,
      offerId: stableOzonOfferId(takeoverSku, '01'),
      payload: { productJsonPath: '/tmp/manual-product.json', revision: 1 },
      state: 'READY'
    });
    expect(takeover).toMatchObject({
      supersededJobId: waitingAuto.id,
      job: { source: 'MANUAL', state: 'READY' }
    });
    await expect(repository.getJob(waitingAuto.id)).resolves.toMatchObject({
      state: 'CANCELLED',
      finishedAt: expect.any(String),
      payload: { supersededByManualJobId: takeover.job.id },
      events: expect.arrayContaining([
        expect.objectContaining({
          eventType: 'JOB_SUPERSEDED_BY_MANUAL',
          payload: { replacementJobId: takeover.job.id }
        })
      ])
    });
    await expect(repository.getJob(takeover.job.id)).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ eventType: 'JOB_CREATED', payload: { supersededJobId: waitingAuto.id } })
      ])
    });

    const manualBeforeDelivery = await repository.getJob(takeover.job.id);
    await expect(repository.enqueueAutomaticJob({
      sku: takeoverSku,
      mediaReady: true,
      media: { sourceStageId: 'E004', submissionId: 'manual-active-video', variantId: '', deliveredAt: new Date().toISOString() }
    })).resolves.toEqual({ job: undefined, becameRunnable: false, deferred: true });
    await expect(repository.enqueueAutomaticJob({
      sku: takeoverSku,
      mediaReady: true,
      media: { sourceStageId: 'E004', submissionId: 'manual-active-video', variantId: '', deliveredAt: new Date().toISOString() }
    })).resolves.toEqual({ job: undefined, becameRunnable: false, deferred: true });
    await expect(repository.getJob(takeover.job.id)).resolves.toMatchObject({
      rowVersion: manualBeforeDelivery.rowVersion,
      payload: manualBeforeDelivery.payload
    });
    await expect(repository.createManualJob({
      sku: takeoverSku,
      payload: {},
      state: 'READY'
    })).rejects.toMatchObject({
      code: 'TASK_LOCKED',
      statusCode: 409,
      details: {
        sku: takeoverSku,
        jobId: takeover.job.id,
        source: 'MANUAL',
        state: 'READY',
        canManualTakeover: false
      }
    });

    const unsafeSku = '0000012';
    const unsafeAutoResult = await repository.enqueueAutomaticJob({
      sku: unsafeSku,
      mediaReady: false,
      media: { sourceStageId: 'E005', submissionId: 'unsafe-images', variantId: '', deliveredAt: new Date().toISOString() }
    });
    const unsafeAuto = unsafeAutoResult.job!;
    const generatedAuto = await repository.transitionJob(unsafeAuto.id, {
      rowVersion: unsafeAuto.rowVersion,
      state: 'WAITING_MEDIA',
      eventType: 'PRODUCT_JSON_GENERATED',
      message: '已生成 product.json',
      jobPayload: { productJsonPath: '/tmp/unsafe-product.json' }
    });
    expect(repository.canManualTakeover(generatedAuto)).toBe(false);
    await expect(repository.createManualJob({ sku: unsafeSku, payload: {}, state: 'READY' }))
      .rejects.toMatchObject({
        code: 'TASK_LOCKED',
        details: { jobId: unsafeAuto.id, source: 'AUTO', state: 'WAITING_MEDIA', canManualTakeover: false }
      });

    const rollbackSku = '0000013';
    const rollbackAutoResult = await repository.enqueueAutomaticJob({
      sku: rollbackSku,
      mediaReady: false,
      media: { sourceStageId: 'E005', submissionId: 'rollback-images', variantId: '', deliveredAt: new Date().toISOString() }
    });
    const rollbackAuto = rollbackAutoResult.job!;
    const circularPayload: Record<string, unknown> = {};
    circularPayload.self = circularPayload;
    await expect(repository.createManualJob({ sku: rollbackSku, payload: circularPayload, state: 'READY' }))
      .rejects.toThrow();
    const rolledBackAuto = await repository.getJob(rollbackAuto.id);
    expect(rolledBackAuto).toMatchObject({
      state: 'WAITING_MEDIA',
      events: [expect.objectContaining({ eventType: 'JOB_CREATED' })]
    });
    expect(rolledBackAuto).not.toHaveProperty('finishedAt');

    const concurrentSku = '0000014';
    const concurrentAutoResult = await repository.enqueueAutomaticJob({
      sku: concurrentSku,
      mediaReady: false,
      media: { sourceStageId: 'E005', submissionId: 'concurrent-images', variantId: '', deliveredAt: new Date().toISOString() }
    });
    const concurrentAuto = concurrentAutoResult.job!;
    const attempts = await Promise.allSettled([
      repository.createManualJob({ sku: concurrentSku, payload: { attempt: 1 }, state: 'READY' }),
      repository.createManualJob({ sku: concurrentSku, payload: { attempt: 2 }, state: 'READY' })
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(await repository.findActiveJobBySku(concurrentSku)).toMatchObject({ source: 'MANUAL', state: 'READY' });
    await expect(repository.getJob(concurrentAuto.id)).resolves.toMatchObject({
      state: 'CANCELLED',
      events: expect.arrayContaining([expect.objectContaining({ eventType: 'JOB_SUPERSEDED_BY_MANUAL' })])
    });

    const refreshSku = '0000090';
    const refreshOfferId = stableOzonOfferId(refreshSku, '01');
    const refreshVariantId = randomUUID();
    const refreshListing = await repository.createListing(
      { sku: refreshSku, productName: '平台状态刷新集成测试' },
      undefined,
      {
        offers: [{
          variantId: refreshVariantId, productVariantId: refreshVariantId, productVariantName: '默认款',
          variantCode: '01', offerId: refreshOfferId,
          price: 100, stock: 1, attributes: [], media: []
        }]
      }
    );
    const refreshJob = await repository.createJob({
      sku: refreshSku,
      source: 'MANUAL',
      offerIds: [refreshOfferId],
      revision: refreshListing.revision,
      payload: {},
      state: 'READY'
    });
    const lease = await repository.acquirePlatformStatusRefresh(refreshSku, refreshListing.rowVersion);
    expect(lease).toMatchObject({
      listing: { sku: refreshSku },
      job: { id: refreshJob.id },
      offerIds: [refreshOfferId],
      storeAlias: 'default'
    });
    await expect(repository.acquirePlatformStatusRefresh(refreshSku, refreshListing.rowVersion))
      .rejects.toMatchObject({ code: 'OZON_STATUS_REFRESH_IN_PROGRESS', statusCode: 409 });
    await expect(repository.transitionJob(refreshJob.id, {
      rowVersion: refreshJob.rowVersion,
      state: 'IMPORTING',
      eventType: 'SHOULD_BE_BLOCKED',
      message: '刷新期间不能推进'
    })).rejects.toMatchObject({ code: 'OZON_STATUS_REFRESH_IN_PROGRESS', statusCode: 409 });
    await expect(repository.releasePlatformStatusRefresh(lease.leaseToken)).resolves.toBe(true);

    const firstSnapshot = {
      displayState: 'ON_SALE', businessState: 'PUBLISHED', readAt: '2026-08-06T02:00:00.000Z', missingConfirmationCount: 0
    };
    const firstMappingUpdate = await repository.recordN8nUpdate(refreshJob.id, {
      rowVersion: refreshJob.rowVersion,
      state: 'IMPORTING',
      eventType: 'MAPPING_WITH_STATUS_SNAPSHOT',
      message: '保存平台状态快照',
      productMappings: [{
        offerId: refreshOfferId,
        ozonProductId: '909001',
        ozonSku: '9090001',
        platformStatus: 'ON_SALE',
        statusSnapshot: firstSnapshot
      }]
    });
    await expect(repository.getProductMapping('default', refreshOfferId)).resolves.toMatchObject({
      status: 'ON_SALE',
      statusSnapshot: firstSnapshot
    });
    await repository.recordN8nUpdate(refreshJob.id, {
      rowVersion: firstMappingUpdate.job.rowVersion,
      state: 'MODERATING',
      eventType: 'MAPPING_WITHOUT_STATUS_SNAPSHOT',
      message: '旧调用方不传快照时必须保留原快照',
      productMappings: [{
        offerId: refreshOfferId,
        ozonProductId: '909001',
        ozonSku: '9090001',
        platformStatus: 'MODERATING'
      }]
    });
    await expect(repository.getProductMapping('default', refreshOfferId)).resolves.toMatchObject({
      status: 'MODERATING',
      statusSnapshot: firstSnapshot
    });
    const beforeCommitListing = await repository.getListing(refreshSku);
    const beforeCommitJob = await repository.getJob(refreshJob.id);
    const commitLease = await repository.acquirePlatformStatusRefresh(refreshSku, beforeCommitListing.rowVersion);
    const publishedOfferStatus = {
      offerId: refreshOfferId,
      ozonProductId: '909001',
      ozonSku: '9090001',
      displayState: 'ON_SALE',
      businessState: 'PUBLISHED' as const,
      readAt: '2026-08-06T02:30:00.000Z',
      missingConfirmationCount: 0,
      confirmed: true,
      moderateStatus: 'approved',
      validationStatus: 'success',
      isCreated: true,
      visible: true,
      hasPrice: true,
      hasStock: true,
      imageCount: 1
    };
    await expect(repository.commitPlatformStatusRefresh(refreshSku, {
      leaseToken: commitLease.leaseToken,
      listingRowVersion: beforeCommitListing.rowVersion,
      jobRowVersion: beforeCommitJob.rowVersion,
      readAt: '2026-08-06T02:30:00.000Z',
      businessState: 'PUBLISHED',
      offers: [publishedOfferStatus],
      warnings: ['仅测试告警'],
      stageStates: {
        import: 'SUCCESS', moderation: 'SUCCESS', images: 'VERIFIED', video: 'NOT_REQUIRED',
        productVideo: 'NOT_REQUIRED', videoCover: 'NOT_REQUIRED', price: 'VERIFIED', stock: 'VERIFIED'
      },
      jobState: 'SUCCEEDED'
    })).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });
    await expect(repository.releasePlatformStatusRefresh(commitLease.leaseToken)).resolves.toBe(true);

    const safeCommitLease = await repository.acquirePlatformStatusRefresh(refreshSku, beforeCommitListing.rowVersion);
    const committedRefresh = await repository.commitPlatformStatusRefresh(refreshSku, {
      leaseToken: safeCommitLease.leaseToken,
      listingRowVersion: beforeCommitListing.rowVersion,
      jobRowVersion: beforeCommitJob.rowVersion,
      readAt: '2026-08-06T02:30:00.000Z',
      businessState: 'PUBLISHED',
      offers: [publishedOfferStatus],
      warnings: ['仅测试告警'],
      stageStates: beforeCommitJob.stageStates,
      jobState: beforeCommitJob.state,
      ...(beforeCommitJob.lastErrorCode ? { errorCode: beforeCommitJob.lastErrorCode } : {}),
      ...(beforeCommitJob.lastErrorMessage ? { errorMessage: beforeCommitJob.lastErrorMessage } : {})
    });
    expect(committedRefresh).toMatchObject({
      listing: { status: 'PUBLISHED' },
      job: {
        state: beforeCommitJob.state,
        stageStates: beforeCommitJob.stageStates
      }
    });
    await expect(repository.getProductMapping('default', refreshOfferId)).resolves.toMatchObject({
      status: 'ON_SALE',
      lastVerifiedAt: '2026-08-06T02:30:00.000Z',
      statusSnapshot: expect.objectContaining({ displayState: 'ON_SALE', businessState: 'PUBLISHED' })
    });
    const repeatedListing = await repository.getListing(refreshSku);
    const repeatedJob = await repository.getJob(refreshJob.id);
    const repeatedLease = await repository.acquirePlatformStatusRefresh(refreshSku, repeatedListing.rowVersion);
    const repeatedRefresh = await repository.commitPlatformStatusRefresh(refreshSku, {
      leaseToken: repeatedLease.leaseToken,
      listingRowVersion: repeatedListing.rowVersion,
      jobRowVersion: repeatedJob.rowVersion,
      readAt: '2026-08-06T02:45:00.000Z',
      businessState: 'PUBLISHED',
      offers: [{
        offerId: refreshOfferId,
        ozonProductId: '909001',
        ozonSku: '9090001',
        displayState: 'ON_SALE',
        businessState: 'PUBLISHED',
        readAt: '2026-08-06T02:45:00.000Z',
        missingConfirmationCount: 0,
        confirmed: true,
        moderateStatus: 'approved',
        validationStatus: 'success',
        isCreated: true,
        visible: true,
        hasPrice: true,
        hasStock: true,
        imageCount: 1
      }],
      warnings: [],
      stageStates: {
        import: 'SUCCESS', moderation: 'SUCCESS', images: 'VERIFIED', video: 'NOT_REQUIRED',
        productVideo: 'NOT_REQUIRED', videoCover: 'NOT_REQUIRED', price: 'VERIFIED', stock: 'VERIFIED'
      }
    });
    expect(repeatedRefresh.changed).toBe(false);
    await expect(repository.getProductMapping('default', refreshOfferId)).resolves.toMatchObject({
      lastVerifiedAt: '2026-08-06T02:45:00.000Z'
    });
  }, 30_000);

  it('does not create a new preparation job when reconciliation replays a FANNED_OUT delivery', async () => {
    const sku = '0000098';
    const delivery = {
      sourceStageId: 'E005' as const,
      submissionId: 'late-images-already-in-frozen-publication',
      variantId: randomUUID(),
      deliveredAt: '2026-08-11T07:26:00.004Z'
    };
    await admin.query(`
      INSERT INTO ${schema}.ozon_media_deliveries(
        sku,source_stage_id,submission_id,variant_id,job_id,payload
      ) VALUES($1,$2,$3,$4,NULL,$5::jsonb)`, [
      sku,
      delivery.sourceStageId,
      delivery.submissionId,
      delivery.variantId,
      JSON.stringify({
        ...delivery,
        autoPublishDecision: 'FANNED_OUT',
        publicationIds: [randomUUID(), randomUUID()],
        storeIds: [randomUUID(), randomUUID()]
      })
    ]);
    const jobsBefore = await admin.query<{ count: number }>(`
      SELECT COUNT(*)::int AS count FROM ${schema}.ozon_publish_jobs WHERE sku=$1`, [sku]);

    await expect(repository.enqueueAutomaticJob({ sku, media: delivery, mediaReady: true })).resolves.toEqual({
      job: undefined,
      becameRunnable: false,
      deferred: false
    });

    expect(await repository.listDeferredAutomaticMediaDeliveries()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        sku,
        sourceStageId: delivery.sourceStageId,
        submissionId: delivery.submissionId,
        variantId: delivery.variantId
      })
    ]));
    const jobsAfter = await admin.query<{ count: number }>(`
      SELECT COUNT(*)::int AS count FROM ${schema}.ozon_publish_jobs WHERE sku=$1`, [sku]);
    expect(jobsAfter.rows).toEqual(jobsBefore.rows);
  });

  it('keeps 20+ terminal history rows from starving due runtime work and preserves history ordering', async () => {
    const terminalIds = Array.from({ length: 25 }, () => randomUUID());
    await admin.query(`
      INSERT INTO ${schema}.ozon_publish_jobs(
        id,sku,state,source,store_alias,created_at,updated_at,finished_at
      )
      SELECT id,'9199999','SUCCEEDED','AUTO','default',
             NOW()+INTERVAL '1 hour'-make_interval(secs=>position),
             NOW()+INTERVAL '1 hour'-make_interval(secs=>position),
             NOW()+INTERVAL '1 hour'-make_interval(secs=>position)
      FROM unnest($1::uuid[]) WITH ORDINALITY AS terminal(id,position)`,
    [terminalIds]);

    const oldestRuntimeId = randomUUID();
    const readyRuntimeId = randomUUID();
    const submittingRuntimeId = randomUUID();
    const importingRuntimeId = randomUUID();
    const localReadyId = randomUUID();
    const futureDueId = randomUUID();
    const leasedId = randomUUID();
    const offsetLeasedId = randomUUID();
    const unsupportedActiveId = randomUUID();
    const futureLease = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const futureOffsetLease = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
    await admin.query(`
      INSERT INTO ${schema}.ozon_publish_jobs(
        id,sku,state,source,store_alias,payload,directory_stage,work_rel_path,
        next_attempt_at,created_at,updated_at
      ) VALUES
        ($1,'9100001','MODERATING','MANUAL','default','{}'::jsonb,'PROCESSING','processing/9100001__r1',NULL,NOW()-INTERVAL '3 hours',NOW()-INTERVAL '3 hours'),
        ($2,'9100002','READY','AUTO','default','{}'::jsonb,'PROCESSING','processing\\9100002__r1',NULL,NOW()-INTERVAL '2 hours',NOW()-INTERVAL '2 hours'),
        ($3,'9100003','SUBMITTING','AUTO','default','{}'::jsonb,'PROCESSING','processing/9100003__r1',NULL,NOW()-INTERVAL '90 minutes',NOW()-INTERVAL '90 minutes'),
        ($4,'9100004','IMPORTING','AUTO','default','{}'::jsonb,'PROCESSING','processing/9100004__r1',NULL,NOW()-INTERVAL '1 hour',NOW()-INTERVAL '1 hour'),
        ($5,'9100005','READY','AUTO','default','{}'::jsonb,'INBOX','inbox/9100005',NULL,NOW()-INTERVAL '4 hours',NOW()-INTERVAL '4 hours'),
        ($6,'9100006','MODERATING','AUTO','default','{}'::jsonb,'PROCESSING','processing/9100006__r1',NOW()+INTERVAL '1 hour',NOW()-INTERVAL '5 hours',NOW()-INTERVAL '5 hours'),
        ($7,'9100007','MODERATING','AUTO','default',$10::jsonb,'PROCESSING','processing/9100007__r1',NULL,NOW()-INTERVAL '6 hours',NOW()-INTERVAL '6 hours'),
        ($8,'9100008','MODERATING','AUTO','default',$11::jsonb,'PROCESSING','processing/9100008__r1',NULL,NOW()-INTERVAL '6 hours 30 minutes',NOW()-INTERVAL '6 hours 30 minutes'),
        ($9,'9100009','UPDATING_STOCK','AUTO','default','{}'::jsonb,'PROCESSING','processing/9100009__r1',NULL,NOW()-INTERVAL '7 hours',NOW()-INTERVAL '7 hours')`,
    [
      oldestRuntimeId, readyRuntimeId, submittingRuntimeId, importingRuntimeId, localReadyId,
      futureDueId, leasedId, offsetLeasedId, unsupportedActiveId,
      JSON.stringify({ finalVerificationLeaseUntil: futureLease }),
      JSON.stringify({ finalVerificationLeaseUntil: futureOffsetLease })
    ]);

    const runtime = await repository.listRuntimeJobs({ page: 1, pageSize: 20, query: '910000' });
    expect(runtime).toMatchObject({ total: 6, page: 1, pageSize: 20 });
    expect(runtime.items.map((job) => job.id)).toEqual([
      unsupportedActiveId,
      oldestRuntimeId,
      readyRuntimeId,
      submittingRuntimeId,
      importingRuntimeId,
      localReadyId
    ]);
    expect(runtime.items.map((job) => job.source)).toEqual(['AUTO', 'MANUAL', 'AUTO', 'AUTO', 'AUTO', 'AUTO']);
    expect(runtime.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: futureDueId }),
      expect.objectContaining({ id: leasedId }),
      expect.objectContaining({ id: offsetLeasedId }),
      expect.objectContaining({ id: unsupportedActiveId })
    ]));
    const disabledManagementRuntime = await repository.listRuntimeJobs({ page: 1, pageSize: 20, query: '910000', remoteOnly: true });
    expect(disabledManagementRuntime.items.map((job) => job.id)).toEqual([
      unsupportedActiveId,
      oldestRuntimeId,
      readyRuntimeId,
      submittingRuntimeId,
      importingRuntimeId
    ]);

    await admin.query(`UPDATE ${schema}.ozon_publish_jobs
      SET next_attempt_at=NOW()+INTERVAL '1 day'
      WHERE id<>ALL($1::uuid[])
        AND state IN ('READY','UPLOADING_MEDIA','SUBMITTING','IMPORTING','VERIFYING_IMAGES','UPDATING_PRICE','UPDATING_STOCK','MODERATING')`,
    [[oldestRuntimeId, readyRuntimeId, submittingRuntimeId, importingRuntimeId, localReadyId, futureDueId, leasedId, offsetLeasedId, unsupportedActiveId]]);
    const claimed = await repository.claimRuntimeJob({ leaseOwner: 'ozon-p002:integration', leaseSeconds: 600 });
    expect(claimed).toMatchObject({
      id: unsupportedActiveId,
      leaseOwner: 'ozon-p002:integration',
      rowVersion: 2
    });
    expect(claimed?.leaseToken).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(repository.claimRuntimeJob({ leaseOwner: 'ozon-p002:concurrent', leaseSeconds: 600 })).resolves.toBeUndefined();
    const renewed = await repository.renewRuntimeLease(claimed!.id, {
      leaseOwner: claimed!.leaseOwner!,
      leaseToken: claimed!.leaseToken!,
      rowVersion: claimed!.rowVersion,
      leaseSeconds: 600
    });
    expect(renewed.rowVersion).toBe(claimed!.rowVersion);
    await expect(repository.transitionJob(claimed!.id, {
      rowVersion: claimed!.rowVersion,
      state: 'UPDATING_STOCK',
      eventType: 'STALE_RUNTIME_WRITE',
      message: 'missing lease fencing'
    })).rejects.toMatchObject({ code: 'TASK_LOCKED', statusCode: 409 });
    const waitingAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const waiting = await repository.transitionJob(claimed!.id, {
      rowVersion: claimed!.rowVersion,
      state: 'UPDATING_STOCK',
      eventType: 'NETWORK_RETRY_SCHEDULED',
      message: 'network interrupted',
      leaseOwner: claimed!.leaseOwner!,
      leaseToken: claimed!.leaseToken!,
      nextAttemptAt: waitingAt,
      networkRecovery: {
        schemaVersion: 1,
        status: 'WAITING_NETWORK',
        phase: 'STOCK_WRITE_READBACK',
        resumeState: 'UPDATING_STOCK',
        deliveryState: 'UNKNOWN',
        attempt: 4,
        firstFailureAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        lastFailureAt: new Date().toISOString(),
        nextAttemptAt: waitingAt,
        errorCode: 'ETIMEDOUT',
        errorMessage: 'network interrupted'
      }
    });
    expect(waiting).toMatchObject({ rowVersion: 3, state: 'UPDATING_STOCK', nextAttemptAt: waitingAt });
    expect(waiting.leaseToken).toBeUndefined();
    const nextClaimed = await repository.claimRuntimeJob({ leaseOwner: 'ozon-p002:after-wait', leaseSeconds: 600 });
    expect(nextClaimed?.id).toBe(oldestRuntimeId);
    const released = await repository.releaseRuntimeLease(nextClaimed!.id, {
      leaseOwner: nextClaimed!.leaseOwner!,
      leaseToken: nextClaimed!.leaseToken!,
      rowVersion: nextClaimed!.rowVersion
    });
    expect(released.leaseToken).toBeUndefined();

    const titleRecoverySku = '9200107';
    await expect(repository.enqueueAutomaticJob({
      sku: titleRecoverySku,
      mediaReady: false,
      media: {
        sourceStageId: 'E005',
        submissionId: 'known-title-recovery',
        variantId: '',
        deliveredAt: new Date().toISOString()
      }
    })).resolves.toEqual({ job: undefined, becameRunnable: false, deferred: false });

    // Current automatic intake is store-owned and must not resurrect the old
    // global-default preset fallback. Keep the historical scheduler recovery
    // coverage with an explicit immutable pre-017 job snapshot instead.
    const titleRecoveryPresetId = randomUUID();
    const titleRecoveryPresetName = '历史 OZON 标题恢复预设';
    const titleRecoveryPresetRowVersion = 1;
    const currentTitleRecoveryDefinition = ozonPresetInputSchema.parse({
      name: titleRecoveryPresetName,
      categoryKey: ['ozon', '17028922', '970642857'].join('_'),
      pricingTemplateId: randomUUID(),
      shippingTemplateId: randomUUID(),
      shippingServiceCode: 'CEL_RFBS_ECONOMY',
      dimensions: { length: 30, width: 20, height: 10, dimensionUnit: 'cm', weight: 700, weightUnit: 'g' },
      titleTranslation: { workflowId: 'HDh0ZNLK2ps5qasR', language: '俄文', maxLength: 60 }
    });
    const titleRecoveryDefinition = {
      ...currentTitleRecoveryDefinition,
      autoPublishEnabled: true,
      autoPublishMode: 'CREATE_ONLY' as const,
      fulfillmentMode: 'FBS' as const,
      warehouseId: '10001',
      currency: 'RUB' as const,
      isDefault: true
    };
    const titleRecoveryDefinitionHash = `sha256:${createHash('sha256')
      .update(testStableJson(titleRecoveryDefinition))
      .digest('hex')}`;
    const titleRecoveryJobId = randomUUID();
    const titleRecoveryBoundAt = new Date().toISOString();
    const titleRecoveryPayload = {
      contentPolicyVersion: 'merchroute-ozon-content-v2',
      presetBinding: {
        schemaVersion: 1,
        presetId: titleRecoveryPresetId,
        presetName: titleRecoveryPresetName,
        presetRowVersion: titleRecoveryPresetRowVersion,
        activationStartedAt: titleRecoveryBoundAt,
        boundAt: titleRecoveryBoundAt,
        definition: titleRecoveryDefinition,
        definitionHash: titleRecoveryDefinitionHash
      }
    };
    await admin.query(`
      INSERT INTO ${schema}.ozon_publish_jobs(
        id,sku,state,source,store_alias,payload,stage_states,retry_count,
        last_error_code,last_error_message,directory_stage,work_rel_path,listing_revision
      ) VALUES(
        $1::uuid,$2,'NEEDS_ATTENTION','AUTO','default',$3::jsonb,'{}'::jsonb,4,
        'VERIFY_FAILED','OZON 标题翻译工作流失败（HTTP 502）','INBOX',$4,0
      )`, [titleRecoveryJobId, titleRecoverySku, JSON.stringify(titleRecoveryPayload), `inbox/${titleRecoverySku}`]);
    const titleRecoveryJob = await repository.getJob(titleRecoveryJobId);
    const titleRecoveryLocked = await repository.getJob(titleRecoveryJob.id);
    const titlePreview = await repository.recoverKnownPrePlatformFailure(titleRecoveryJob.id, {
      reason: 'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200',
      rowVersion: titleRecoveryLocked.rowVersion,
      dryRun: true
    });
    expect(titlePreview).toMatchObject({
      status: 'DRY_RUN',
      previous: { jobRowVersion: titleRecoveryLocked.rowVersion },
      proposed: {
        jobState: 'READY',
        retryCount: 0,
        titleTranslationMaxLength: 200,
        presetBindingDefinitionHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
      },
      job: { state: 'NEEDS_ATTENTION', retryCount: 4, rowVersion: titleRecoveryLocked.rowVersion }
    });
    const titleChecks = {
      remoteState: { status: 'NOT_APPLICABLE' as const, offerIds: [], checkedAt: new Date().toISOString() },
      productJson: { status: 'NOT_APPLICABLE' as const, checkedAt: new Date().toISOString() }
    };
    const titleRecovered = await repository.recoverKnownPrePlatformFailure(titleRecoveryJob.id, {
      reason: 'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200',
      rowVersion: titleRecoveryLocked.rowVersion,
      dryRun: false
    }, async () => titleChecks);
    expect(titleRecovered).toMatchObject({
      status: 'RECOVERED',
      checks: titleChecks,
      job: {
        state: 'READY',
        rowVersion: titleRecoveryLocked.rowVersion + 1,
        retryCount: 0,
        payload: {
          presetBinding: {
            definition: { titleTranslation: { maxLength: 200 } },
            definitionHash: titlePreview.proposed.presetBindingDefinitionHash
          },
          knownPrePlatformFailureRecovery: { reason: 'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200', checks: titleChecks }
        }
      }
    });
    expect(titleRecovered.job).not.toHaveProperty('lastErrorCode');
    await expect(repository.recoverKnownPrePlatformFailure(titleRecoveryJob.id, {
      reason: 'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200',
      rowVersion: titleRecoveryLocked.rowVersion,
      dryRun: false
    }, async () => titleChecks)).resolves.toMatchObject({ status: 'ALREADY_RECOVERED' });

    const importRecoverySku = '9200105';
    await admin.query(`INSERT INTO ${schema}.products(sku,created_at) VALUES($1,NOW()) ON CONFLICT(sku) DO NOTHING`, [importRecoverySku]);
    const importRecoveryVariantId = randomUUID();
    let importRecoveryListing = await repository.createListing(
      { sku: importRecoverySku, productName: '已知 URL 故障恢复' },
      undefined,
      { offers: [integrationSharedOffer(importRecoverySku, 'URL 故障恢复变体', importRecoveryVariantId)] }
    );
    const importRecoveryData = {
      ...importRecoveryListing.data,
      offers: [{
        offerId: `${importRecoverySku}-01`,
        modelGroup: importRecoverySku,
        variantCode: '01',
        variantId: importRecoveryVariantId,
        productVariantId: importRecoveryVariantId,
        productVariantName: 'URL 故障恢复变体',
        price: 1,
        stock: 0,
        attributes: [],
        media: []
      }]
    };
    await admin.query(`UPDATE ${schema}.ozon_listing_drafts
      SET data=$2::jsonb,row_version=row_version+1,updated_at=NOW()
      WHERE sku=$1`, [importRecoverySku, JSON.stringify(importRecoveryData)]);
    importRecoveryListing = await repository.getListing(importRecoverySku);
    const importRecoveryId = randomUUID();
    const importRevision = importRecoveryListing.revision;
    const importTaskFolder = `${importRecoverySku}__r${importRevision}`;
    const importSignature = `sha256:${'e'.repeat(64)}`;
    const listingDataSignature = `sha256:${createHash('sha256').update(testStableJson(importRecoveryListing.data)).digest('hex')}`;
    const importPayload = {
      autoPreparedByJobId: importRecoveryId,
      autoPreparedListingRevision: importRevision,
      autoPreparedListingDataSignature: listingDataSignature
    };
    await admin.query(`
      INSERT INTO ${schema}.ozon_publish_jobs(
        id,sku,state,source,store_alias,payload,stage_states,offer_ids,task_id,task_folder,
        work_rel_path,directory_stage,directory_signature,listing_revision,retry_count,last_error_code,last_error_message
      ) VALUES($1::uuid,$2,'NEEDS_ATTENTION','AUTO','default',$3::jsonb,$4::jsonb,$5::jsonb,($1::uuid)::text,$6,$7,'PROCESSING',$8,$9,3,
        'OZON_STATE_MACHINE_FAILED','URL parameter must be a string, got undefined')`,
    [
      importRecoveryId,
      importRecoverySku,
      JSON.stringify(importPayload),
      JSON.stringify({ import: 'PENDING', moderation: 'PENDING', images: 'LOCAL_READY', video: 'LOCAL_READY' }),
      JSON.stringify([`${importRecoverySku}-01`]),
      importTaskFolder,
      `processing/${importTaskFolder}`,
      importSignature,
      importRevision
    ]);
    const updatedImportListing = await admin.query<{ row_version: number }>(`
      UPDATE ${schema}.ozon_listing_drafts
      SET status='NEEDS_ATTENTION',last_task_id=$2,last_error_code='OZON_STATE_MACHINE_FAILED',
          last_error_message='URL parameter must be a string, got undefined',row_version=row_version+1,updated_at=NOW()
      WHERE sku=$1 RETURNING row_version`, [importRecoverySku, importRecoveryId]);
    const importRecoveryJob = await repository.getJob(importRecoveryId);
    const importListingRowVersion = Number(updatedImportListing.rows[0]!.row_version);
    await expect(repository.recoverKnownPrePlatformFailure(importRecoveryId, {
      reason: 'IMPORT_INTENT_URL_MISSING',
      rowVersion: importRecoveryJob.rowVersion,
      listingRowVersion: importListingRowVersion + 1,
      dryRun: true
    })).rejects.toMatchObject({ code: 'TASK_LOCKED' });
    const importPreview = await repository.recoverKnownPrePlatformFailure(importRecoveryId, {
      reason: 'IMPORT_INTENT_URL_MISSING',
      rowVersion: importRecoveryJob.rowVersion,
      listingRowVersion: importListingRowVersion,
      dryRun: true
    });
    expect(importPreview).toMatchObject({
      status: 'DRY_RUN',
      proposed: { jobState: 'SUBMITTING', listingState: 'SUBMITTING', retryCount: 3 },
      job: { id: importRecoveryId, state: 'NEEDS_ATTENTION', rowVersion: importRecoveryJob.rowVersion },
      listing: { sku: importRecoverySku, status: 'NEEDS_ATTENTION', rowVersion: importListingRowVersion }
    });
    const importChecks = {
      remoteState: {
        status: 'CONFIRMED_EMPTY' as const,
        offerIds: [`${importRecoverySku}-01`],
        checkedAt: new Date().toISOString(),
        infoItemCount: 0,
        attributeItemCount: 0
      },
      productJson: { status: 'MATCHED' as const, checkedAt: new Date().toISOString(), expectedSignature: importSignature }
    };
    const beforeImportCommit = vi.fn(async () => importChecks);
    const importRecovered = await repository.recoverKnownPrePlatformFailure(importRecoveryId, {
      reason: 'IMPORT_INTENT_URL_MISSING',
      rowVersion: importRecoveryJob.rowVersion,
      listingRowVersion: importListingRowVersion,
      dryRun: false
    }, beforeImportCommit);
    expect(beforeImportCommit).toHaveBeenCalledWith(expect.objectContaining({ id: importRecoveryId, rowVersion: importRecoveryJob.rowVersion }));
    expect(importRecovered).toMatchObject({
      status: 'RECOVERED',
      checks: importChecks,
      job: {
        id: importRecoveryId,
        state: 'SUBMITTING',
        rowVersion: importRecoveryJob.rowVersion + 1,
        retryCount: 3,
        taskId: importRecoveryId,
        taskFolder: importTaskFolder,
        directorySignature: importSignature,
        stageStates: { import: 'PENDING', moderation: 'PENDING', images: 'LOCAL_READY', video: 'LOCAL_READY' }
      },
      listing: { sku: importRecoverySku, status: 'SUBMITTING', rowVersion: importListingRowVersion + 1 }
    });

    const historicalNetworkId = randomUUID();
    await admin.query(`INSERT INTO ${schema}.ozon_publish_jobs(
      id,sku,state,source,store_alias,payload,directory_stage,work_rel_path,last_error_code,last_error_message,finished_at
    ) VALUES($1,'9100010','NEEDS_ATTENTION','MANUAL','default',$2::jsonb,'INBOX','inbox/9100010','ETIMEDOUT','n8n response timed out',NOW())`,
    [historicalNetworkId, JSON.stringify({ revision: 3, offerIds: ['9100010-01'] })]);
    const historicalCandidates = await repository.listHistoricalNetworkRecoveryCandidates(20);
    expect(historicalCandidates.map((job) => job.id)).toContain(historicalNetworkId);
    const recoveredHistorical = await repository.recoverHistoricalNetworkJob(historicalNetworkId, 1);
    expect(recoveredHistorical).toMatchObject({
      id: historicalNetworkId,
      state: 'READY',
      rowVersion: 2,
      retryCount: 0,
      payload: {
        revision: 3,
        networkRecovery: {
          status: 'WAITING_NETWORK',
          phase: 'HISTORICAL_RECOVERY',
          resumeState: 'READY',
          deliveryState: 'UNKNOWN'
        }
      }
    });
    expect(recoveredHistorical.finishedAt).toBeUndefined();

    const history = await repository.listJobs({ source: 'AUTO', page: 1, pageSize: 20 });
    expect(history.items).toHaveLength(20);
    expect(history.items.every((job) => terminalIds.includes(job.id))).toBe(true);
    for (let index = 1; index < history.items.length; index += 1) {
      expect(Date.parse(history.items[index - 1]!.updatedAt)).toBeGreaterThanOrEqual(
        Date.parse(history.items[index]!.updatedAt)
      );
    }
  });

  it('revalidates AUTO cancellation under row lock and keeps rejected jobs unchanged', async () => {
    const localFailed = await repository.createJob({
      sku: 'cancel-local-failed',
      source: 'AUTO',
      payload: {},
      state: 'FAILED'
    });
    await expect(repository.cancel(localFailed.id, 'AUTO', localFailed.rowVersion)).resolves.toMatchObject({
      id: localFailed.id,
      state: 'CANCELLED',
      rowVersion: localFailed.rowVersion + 1
    });

    const remoteIdJob = await repository.createJob({
      sku: 'cancel-remote-id',
      source: 'AUTO',
      payload: {},
      state: 'FAILED'
    });
    await admin.query(`UPDATE ${schema}.ozon_publish_jobs SET task_id='task-remote' WHERE id=$1`, [remoteIdJob.id]);
    const remoteEventsBefore = await admin.query(
      `SELECT COUNT(*)::int AS count FROM ${schema}.ozon_publish_events WHERE job_id=$1`,
      [remoteIdJob.id]
    );
    await expect(repository.cancel(remoteIdJob.id, 'AUTO', remoteIdJob.rowVersion)).rejects.toMatchObject({
      code: 'TASK_LOCKED',
      statusCode: 409
    });
    await expect(repository.getJob(remoteIdJob.id, 'AUTO')).resolves.toMatchObject({
      state: 'FAILED',
      taskId: 'task-remote',
      rowVersion: remoteIdJob.rowVersion
    });
    const remoteEventsAfter = await admin.query(
      `SELECT COUNT(*)::int AS count FROM ${schema}.ozon_publish_events WHERE job_id=$1`,
      [remoteIdJob.id]
    );
    expect(remoteEventsAfter.rows[0]).toEqual(remoteEventsBefore.rows[0]);

    const processingJob = await repository.createJob({
      sku: 'cancel-processing',
      source: 'AUTO',
      payload: {},
      state: 'READY',
      directoryStage: 'PROCESSING',
      workRelPath: 'processing/cancel-processing__r1'
    });
    await expect(repository.cancel(processingJob.id, 'AUTO', processingJob.rowVersion)).rejects.toMatchObject({
      code: 'TASK_LOCKED',
      statusCode: 409
    });
    await expect(repository.getJob(processingJob.id, 'AUTO')).resolves.toMatchObject({
      state: 'READY',
      directoryStage: 'PROCESSING',
      rowVersion: processingJob.rowVersion
    });

    const remoteStateJob = await repository.createJob({
      sku: 'cancel-remote-state',
      source: 'AUTO',
      payload: {},
      state: 'SUBMITTING'
    });
    await expect(repository.cancel(remoteStateJob.id, 'AUTO', remoteStateJob.rowVersion)).rejects.toMatchObject({
      code: 'TASK_LOCKED',
      statusCode: 409
    });

    const staleJob = await repository.createJob({
      sku: 'cancel-row-version',
      source: 'AUTO',
      payload: {},
      state: 'READY'
    });
    await admin.query(`UPDATE ${schema}.ozon_publish_jobs SET row_version=row_version+1 WHERE id=$1`, [staleJob.id]);
    const staleEventsBefore = await admin.query(
      `SELECT COUNT(*)::int AS count FROM ${schema}.ozon_publish_events WHERE job_id=$1`,
      [staleJob.id]
    );
    const staleSlotsBefore = await admin.query(
      `SELECT slot_key,job_id,lease_token FROM ${schema}.ozon_publish_slots WHERE job_id=$1 ORDER BY slot_key`,
      [staleJob.id]
    );
    await expect(repository.cancel(staleJob.id, 'AUTO', staleJob.rowVersion)).rejects.toMatchObject({
      code: 'TASK_LOCKED',
      statusCode: 409,
      details: {
        expectedRowVersion: staleJob.rowVersion,
        actualRowVersion: staleJob.rowVersion + 1
      }
    });
    await expect(repository.getJob(staleJob.id, 'AUTO')).resolves.toMatchObject({
      state: 'READY',
      rowVersion: staleJob.rowVersion + 1
    });
    const staleEventsAfter = await admin.query(
      `SELECT COUNT(*)::int AS count FROM ${schema}.ozon_publish_events WHERE job_id=$1`,
      [staleJob.id]
    );
    const staleSlotsAfter = await admin.query(
      `SELECT slot_key,job_id,lease_token FROM ${schema}.ozon_publish_slots WHERE job_id=$1 ORDER BY slot_key`,
      [staleJob.id]
    );
    expect(staleEventsAfter.rows).toEqual(staleEventsBefore.rows);
    expect(staleSlotsAfter.rows).toEqual(staleSlotsBefore.rows);

    const leasedJob = await repository.createJob({
      sku: 'cancel-active-lease',
      source: 'AUTO',
      payload: {},
      state: 'READY'
    });
    const runtimeLeaseToken = randomUUID();
    await admin.query(`UPDATE ${schema}.ozon_publish_jobs
      SET lease_owner='cancel-test',lease_token=$2::uuid,lease_expires_at=NOW()+INTERVAL '5 minutes'
      WHERE id=$1`, [leasedJob.id, runtimeLeaseToken]);
    const leasedEventsBefore = await admin.query(
      `SELECT COUNT(*)::int AS count FROM ${schema}.ozon_publish_events WHERE job_id=$1`,
      [leasedJob.id]
    );
    const runtimeLeaseBefore = await admin.query(
      `SELECT lease_owner,lease_token,lease_expires_at FROM ${schema}.ozon_publish_jobs WHERE id=$1`,
      [leasedJob.id]
    );
    const runtimeSlotsBefore = await admin.query(
      `SELECT slot_key,job_id,lease_token FROM ${schema}.ozon_publish_slots WHERE job_id=$1 ORDER BY slot_key`,
      [leasedJob.id]
    );
    await expect(repository.cancel(leasedJob.id, 'AUTO', leasedJob.rowVersion)).rejects.toMatchObject({
      code: 'TASK_LOCKED',
      statusCode: 409
    });
    await expect(repository.getJob(leasedJob.id, 'AUTO')).resolves.toMatchObject({
      state: 'READY',
      rowVersion: leasedJob.rowVersion
    });
    const leasedEventsAfter = await admin.query(
      `SELECT COUNT(*)::int AS count FROM ${schema}.ozon_publish_events WHERE job_id=$1`,
      [leasedJob.id]
    );
    const runtimeLeaseAfter = await admin.query(
      `SELECT lease_owner,lease_token,lease_expires_at FROM ${schema}.ozon_publish_jobs WHERE id=$1`,
      [leasedJob.id]
    );
    const runtimeSlotsAfter = await admin.query(
      `SELECT slot_key,job_id,lease_token FROM ${schema}.ozon_publish_slots WHERE job_id=$1 ORDER BY slot_key`,
      [leasedJob.id]
    );
    expect(leasedEventsAfter.rows).toEqual(leasedEventsBefore.rows);
    expect(runtimeLeaseAfter.rows).toEqual(runtimeLeaseBefore.rows);
    expect(runtimeSlotsAfter.rows).toEqual(runtimeSlotsBefore.rows);

    const refreshLeasedJob = await repository.createJob({
      sku: 'cancel-refresh-lease',
      source: 'AUTO',
      payload: {},
      state: 'READY'
    });
    const refreshLeaseToken = randomUUID();
    await admin.query(`INSERT INTO ${schema}.ozon_platform_status_refresh_leases(
      sku,job_id,lease_token,listing_row_version,job_row_version,lease_expires_at
    ) VALUES($1,$2,$3::uuid,1,$4,NOW()+INTERVAL '5 minutes')`, [
      refreshLeasedJob.sku,
      refreshLeasedJob.id,
      refreshLeaseToken,
      refreshLeasedJob.rowVersion
    ]);
    const refreshEventsBefore = await admin.query(
      `SELECT COUNT(*)::int AS count FROM ${schema}.ozon_publish_events WHERE job_id=$1`,
      [refreshLeasedJob.id]
    );
    await expect(repository.cancel(refreshLeasedJob.id, 'AUTO', refreshLeasedJob.rowVersion)).rejects.toMatchObject({
      code: 'OZON_STATUS_REFRESH_IN_PROGRESS',
      statusCode: 409
    });
    await expect(repository.getJob(refreshLeasedJob.id, 'AUTO')).resolves.toMatchObject({
      state: 'READY',
      rowVersion: refreshLeasedJob.rowVersion
    });
    const refreshEventsAfter = await admin.query(
      `SELECT COUNT(*)::int AS count FROM ${schema}.ozon_publish_events WHERE job_id=$1`,
      [refreshLeasedJob.id]
    );
    const persistedRefreshLease = await admin.query(
      `SELECT job_id,lease_token,job_row_version FROM ${schema}.ozon_platform_status_refresh_leases WHERE sku=$1`,
      [refreshLeasedJob.sku]
    );
    expect(refreshEventsAfter.rows).toEqual(refreshEventsBefore.rows);
    expect(persistedRefreshLease.rows).toEqual([{
      job_id: refreshLeasedJob.id,
      lease_token: refreshLeaseToken,
      job_row_version: refreshLeasedJob.rowVersion
    }]);

    const manualFailed = await repository.createJob({
      sku: 'cancel-manual-failed',
      source: 'MANUAL',
      payload: {},
      state: 'FAILED'
    });
    await expect(repository.cancel(manualFailed.id, 'MANUAL')).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      statusCode: 409
    });
  });

  it('does not claim local READY jobs until task or PROCESSING evidence exists', async () => {
    await admin.query(`UPDATE ${schema}.ozon_publish_jobs
      SET next_attempt_at=NOW()+INTERVAL '1 day'
      WHERE state='READY'`);
    const localOnlyId = randomUUID();
    await admin.query(`
      INSERT INTO ${schema}.ozon_publish_jobs(
        id,sku,state,source,store_alias,payload,directory_stage,work_rel_path,next_attempt_at,created_at,updated_at
      ) VALUES($1,'9300101','READY','AUTO','default','{}'::jsonb,'INBOX','inbox/9300101',NULL,NOW()-INTERVAL '1 hour',NOW()-INTERVAL '1 hour')`,
    [localOnlyId]);
    await expect(repository.claimRuntimeJob({
      leaseOwner: 'ozon-p002:local-ready-rejected',
      leaseSeconds: 60,
      states: ['READY']
    })).resolves.toBeUndefined();

    await admin.query(`UPDATE ${schema}.ozon_publish_jobs SET task_id='remote-task-evidence',updated_at=NOW() WHERE id=$1`, [localOnlyId]);
    const taskClaim = await repository.claimRuntimeJob({
      leaseOwner: 'ozon-p002:task-evidence',
      leaseSeconds: 60,
      states: ['READY']
    });
    expect(taskClaim).toMatchObject({ id: localOnlyId, taskId: 'remote-task-evidence' });
    await repository.releaseRuntimeLease(taskClaim!.id, {
      leaseOwner: taskClaim!.leaseOwner!,
      leaseToken: taskClaim!.leaseToken!,
      rowVersion: taskClaim!.rowVersion
    });
    await admin.query(`UPDATE ${schema}.ozon_publish_jobs SET state='CANCELLED',finished_at=NOW() WHERE id=$1`, [localOnlyId]);

    const processingId = randomUUID();
    await admin.query(`
      INSERT INTO ${schema}.ozon_publish_jobs(
        id,sku,state,source,store_alias,payload,directory_stage,work_rel_path,next_attempt_at,created_at,updated_at
      ) VALUES($1,'9300102','READY','AUTO','default','{}'::jsonb,'PROCESSING','processing/9300102__r1',NULL,NOW(),NOW())`,
    [processingId]);
    const processingClaim = await repository.claimRuntimeJob({
      leaseOwner: 'ozon-p002:processing-evidence',
      leaseSeconds: 60,
      states: ['READY']
    });
    expect(processingClaim).toMatchObject({ id: processingId, directoryStage: 'PROCESSING' });
    await repository.releaseRuntimeLease(processingClaim!.id, {
      leaseOwner: processingClaim!.leaseOwner!,
      leaseToken: processingClaim!.leaseToken!,
      rowVersion: processingClaim!.rowVersion
    });
    await admin.query(`UPDATE ${schema}.ozon_publish_jobs SET state='CANCELLED',finished_at=NOW() WHERE id=$1`, [processingId]);
  });

  it('consumes only compatible-append media delivery quadruples and preserves same-variant history', async () => {
    const sku = '9300201';
    const preservedVariantId = randomUUID();
    const submittedVariantId = randomUUID();
    const preservedOfferId = `${sku}-01`;
    const submittedOfferId = `${sku}-02`;
    const targetImageSubmissionId = 'compatible-target-image';
    const targetVideoSubmissionId = 'compatible-target-video';
    const historicalSubmissionId = 'compatible-history-image';
    await admin.query(`INSERT INTO ${schema}.products(sku,product_name,created_at) VALUES($1,'兼容追加精确消费',NOW())`, [sku]);
    await admin.query(`INSERT INTO ${schema}.product_variants(id,sku,name,normalized_name,sort_order) VALUES
      ($1,$3,'保留变体','保留变体',0),($2,$3,'新增变体','新增变体',1)`, [preservedVariantId, submittedVariantId, sku]);
    await admin.query(`
      INSERT INTO ${schema}.ozon_listing_drafts(sku,product_name_snapshot,status,data)
      VALUES($1,'兼容追加精确消费','PUBLISHED',$2::jsonb)`, [
      sku,
      JSON.stringify({
        offers: [
          { offerId: preservedOfferId, variantId: preservedVariantId, productVariantId: preservedVariantId, media: [] },
          {
            offerId: submittedOfferId,
            variantId: submittedVariantId,
            productVariantId: submittedVariantId,
            media: [{ assetId: 'append-image' }, { assetId: 'append-video' }]
          }
        ],
        mediaAssets: [
          {
            assetId: 'append-image',
            productVariantId: submittedVariantId,
            sourceStageId: 'E005',
            sourceSubmissionId: targetImageSubmissionId
          },
          {
            assetId: 'append-video',
            productVariantId: submittedVariantId,
            sourceStageId: 'E004',
            sourceSubmissionId: targetVideoSubmissionId
          }
        ]
      })
    ]);
    await admin.query(`
      INSERT INTO ${schema}.ozon_product_mappings(
        store_alias,offer_id,sku,ozon_product_id,ozon_sku,last_applied_revision,status
      ) VALUES('default',$1,$2,'8100001','8200001',1,'ON_SALE')`, [preservedOfferId, sku]);
    for (const delivery of [
      { sourceStageId: 'E005', submissionId: targetImageSubmissionId },
      { sourceStageId: 'E004', submissionId: targetVideoSubmissionId },
      { sourceStageId: 'E005', submissionId: historicalSubmissionId }
    ]) {
      await admin.query(`
        INSERT INTO ${schema}.ozon_media_deliveries(sku,source_stage_id,submission_id,variant_id,payload)
        VALUES($1,$2,$3,$4,$5::jsonb)`, [
        sku,
        delivery.sourceStageId,
        delivery.submissionId,
        submittedVariantId,
        JSON.stringify({
          sourceStageId: delivery.sourceStageId,
          submissionId: delivery.submissionId,
          variantId: submittedVariantId,
          autoPublishDecision: 'DEFERRED'
        })
      ]);
    }
    const expectedOfferIds = [preservedOfferId, submittedOfferId];
    const submittedOfferIds = [submittedOfferId];
    const expectedOfferSnapshots = [
      { offerId: preservedOfferId, disposition: 'PRESERVED_EXISTING' },
      { offerId: submittedOfferId, disposition: 'SUBMITTED' }
    ];
    const offerContractBody = {
      offerContractVersion: 1,
      expectedOfferIds,
      submittedOfferIds,
      publishOfferIds: submittedOfferIds,
      expectedOfferSnapshots
    };
    const offerContractHash = integrationPayloadHash(offerContractBody);
    const manualJob = await repository.createJob({
      sku,
      source: 'MANUAL',
      state: 'READY',
      offerIds: expectedOfferIds,
      payload: {
        mode: 'COMPATIBLE_APPEND',
        preservedOfferIds: [preservedOfferId],
        submittedOfferIds,
        ...offerContractBody,
        offerContractHash
      }
    });
    const historicalBefore = await admin.query(`SELECT payload,updated_at FROM ${schema}.ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id='E005' AND submission_id=$2 AND variant_id=$3`,
    [sku, historicalSubmissionId, submittedVariantId]);
    await expect(repository.recordN8nUpdate(manualJob.id, {
      rowVersion: manualJob.rowVersion,
      state: 'SUCCEEDED',
      eventType: 'COMPATIBLE_APPEND_SUCCEEDED',
      message: '兼容追加平台映射已读回',
      offerIds: expectedOfferIds,
      productMappings: [
        { offerId: preservedOfferId, ozonProductId: '8100001', ozonSku: '8200001', platformStatus: 'ON_SALE' },
        { offerId: submittedOfferId, ozonProductId: '8100002', ozonSku: '8200002', platformStatus: 'ON_SALE' }
      ],
      lastAppliedRevision: 2,
      platformStatus: 'ON_SALE'
    })).resolves.toMatchObject({
      job: { id: manualJob.id, state: 'SUCCEEDED' },
      mappings: expect.arrayContaining([
        expect.objectContaining({ offerId: preservedOfferId, ozonProductId: '8100001' }),
        expect.objectContaining({ offerId: submittedOfferId, ozonProductId: '8100002' })
      ])
    });
    const consumedTargets = await admin.query(`SELECT source_stage_id,submission_id,payload
      FROM ${schema}.ozon_media_deliveries
      WHERE sku=$1 AND submission_id=ANY($2::text[]) ORDER BY source_stage_id,submission_id`,
    [sku, [targetImageSubmissionId, targetVideoSubmissionId]]);
    expect(consumedTargets.rows).toHaveLength(2);
    expect(consumedTargets.rows.every((row) => row.payload.autoPublishDecision === 'CONSUMED_REMOTE'
      && row.payload.consumedByManualJobId === manualJob.id
      && testStableJson(row.payload.representedOfferIds) === testStableJson([submittedOfferId]))).toBe(true);
    const historicalAfter = await admin.query(`SELECT payload,updated_at FROM ${schema}.ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id='E005' AND submission_id=$2 AND variant_id=$3`,
    [sku, historicalSubmissionId, submittedVariantId]);
    expect(historicalAfter.rows).toEqual(historicalBefore.rows);
  });

  it('atomically consumes only the AUTO round media quadruples on success and rolls back ownership drift', async () => {
    const sku = '0000113';
    const variantId = randomUUID();
    const legacyVariantId = randomUUID();
    const offerId = `${sku}-01`;
    const legacyOfferId = `${sku}-02`;
    const targetSubmissionId = `auto-target-${randomUUID()}`;
    const legacySubmissionId = `auto-legacy-${randomUUID()}`;
    const deliveredAt = new Date(Date.now() - 60_000).toISOString();
    const acceptedDelivery = (submissionId: string, currentVariantId: string) => ({
      sourceStageId: 'E005',
      submissionId,
      variantId: currentVariantId,
      deliveredAt,
      autoPublishDecision: 'ACCEPTED',
      autoPublishAcceptanceId: 'legacy-auto-acceptance',
      autoPublishAcceptedAt: new Date(Date.now() - 59_000).toISOString(),
      autoPublishAcceptedByJobId: 'legacy-auto-source-job',
      autoPublishAcceptedPresetId: 'preset-integration-auto',
      autoPublishAcceptedPresetRowVersion: 8,
      autoPublishAcceptedSettingsRowVersion: 12,
      autoPublishAcceptedActivationStartedAt: new Date(Date.now() - 120_000).toISOString(),
      autoPublishAcceptedDefinitionHash: `sha256:${'d'.repeat(64)}`
    });
    const targetDelivery = acceptedDelivery(targetSubmissionId, variantId);
    const legacyDelivery = {
      ...acceptedDelivery(legacySubmissionId, legacyVariantId),
      autoPublishDecision: 'DEFERRED'
    };
    const expectedOfferSnapshots = [
      { offerId, productVariantId: variantId, disposition: 'SUBMITTED', stock: 1 },
      { offerId: legacyOfferId, productVariantId: legacyVariantId, disposition: 'SUBMITTED', stock: 1 }
    ];
    const contractBody = {
      offerContractVersion: 1,
      expectedOfferIds: [offerId, legacyOfferId],
      submittedOfferIds: [offerId, legacyOfferId],
      publishOfferIds: [offerId, legacyOfferId],
      expectedOfferSnapshots
    };
    const payload = {
      revision: 1,
      mediaDeliveries: [targetDelivery],
      ...contractBody,
      offerContractHash: integrationPayloadHash(contractBody)
    };
    await admin.query(`INSERT INTO ${schema}.products(sku,product_name,created_at)
      VALUES($1,'AUTO 原子媒体消费',NOW())`, [sku]);
    await admin.query(`INSERT INTO ${schema}.product_variants(id,sku,name,normalized_name,sort_order)
      VALUES($1,$3,'目标变体','目标变体',0),($2,$3,'非目标变体','非目标变体',1)`,
    [variantId, legacyVariantId, sku]);
    await admin.query(`INSERT INTO ${schema}.ozon_listing_drafts(
      sku,product_name_snapshot,status,revision,data
    ) VALUES($1,'AUTO 原子媒体消费','SUBMITTING',1,$2::jsonb)`, [
      sku,
      JSON.stringify({ offers: [
        { offerId, variantId, productVariantId: variantId },
        { offerId: legacyOfferId, variantId: legacyVariantId, productVariantId: legacyVariantId }
      ] })
    ]);
    const job = await repository.createJob({
      sku,
      source: 'AUTO',
      state: 'READY',
      offerIds: [offerId, legacyOfferId],
      revision: 1,
      payload
    });
    for (const delivery of [targetDelivery, legacyDelivery]) {
      await admin.query(`INSERT INTO ${schema}.ozon_media_deliveries(
        sku,source_stage_id,submission_id,variant_id,job_id,payload
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [
        sku,
        delivery.sourceStageId,
        delivery.submissionId,
        delivery.variantId,
        delivery === targetDelivery ? job.id : null,
        JSON.stringify(delivery)
      ]);
    }
    const legacyBefore = await admin.query(`SELECT job_id,payload,updated_at::text AS updated_at
      FROM ${schema}.ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id='E005' AND submission_id=$2 AND variant_id=$3`,
    [sku, legacySubmissionId, legacyVariantId]);

    await expect(repository.recordN8nUpdate(job.id, {
      rowVersion: job.rowVersion,
      state: 'SUCCEEDED',
      eventType: 'AUTO_INTEGRATION_SUCCEEDED',
      message: 'AUTO 平台映射已完整读回',
      offerIds: [offerId, legacyOfferId],
      productMappings: [
        { offerId, ozonProductId: '9100113', ozonSku: '9200113', platformStatus: 'ON_SALE' },
        { offerId: legacyOfferId, ozonProductId: '9100114', ozonSku: '9200114', platformStatus: 'ON_SALE' }
      ],
      lastAppliedRevision: 1,
      platformStatus: 'ON_SALE'
    })).resolves.toMatchObject({ job: { id: job.id, state: 'SUCCEEDED' } });

    const targetAfter = await admin.query(`SELECT job_id,payload
      FROM ${schema}.ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id='E005' AND submission_id=$2 AND variant_id=$3`,
    [sku, targetSubmissionId, variantId]);
    expect(targetAfter.rows).toEqual([expect.objectContaining({
      job_id: job.id,
      payload: expect.objectContaining({
        autoPublishDecision: 'CONSUMED_REMOTE',
        consumedByAutomaticJobId: job.id,
        representedOfferIds: [offerId],
        autoPublishConsumedAt: expect.any(String)
      })
    })]);
    const legacyAfter = await admin.query(`SELECT job_id,payload,updated_at::text AS updated_at
      FROM ${schema}.ozon_media_deliveries
      WHERE sku=$1 AND source_stage_id='E005' AND submission_id=$2 AND variant_id=$3`,
    [sku, legacySubmissionId, legacyVariantId]);
    expect(legacyAfter.rows).toEqual(legacyBefore.rows);
    const consumedEvent = await admin.query(`SELECT event_type,payload FROM ${schema}.ozon_publish_events
      WHERE job_id=$1 AND event_type='AUTO_MEDIA_CONSUMED_REMOTE'`, [job.id]);
    expect(consumedEvent.rows).toEqual([expect.objectContaining({
      event_type: 'AUTO_MEDIA_CONSUMED_REMOTE',
      payload: expect.objectContaining({ publishOfferIds: [offerId, legacyOfferId] })
    })]);

    const driftSubmissionId = `auto-drift-${randomUUID()}`;
    const driftDelivery = acceptedDelivery(driftSubmissionId, variantId);
    const driftJob = await repository.createJob({
      sku,
      source: 'AUTO',
      state: 'READY',
      offerIds: [offerId, legacyOfferId],
      revision: 1,
      payload: { ...payload, mediaDeliveries: [driftDelivery] }
    });
    await admin.query(`INSERT INTO ${schema}.ozon_media_deliveries(
      sku,source_stage_id,submission_id,variant_id,job_id,payload
    ) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [
      sku,
      driftDelivery.sourceStageId,
      driftDelivery.submissionId,
      driftDelivery.variantId,
      job.id,
      JSON.stringify(driftDelivery)
    ]);
    const beforeRejected = await admin.query(`SELECT
      (SELECT jsonb_build_object('state',state,'rowVersion',row_version,'payload',payload)
        FROM ${schema}.ozon_publish_jobs WHERE id=$1) AS job,
      (SELECT jsonb_build_object('status',status,'rowVersion',row_version,'revision',revision)
        FROM ${schema}.ozon_listing_drafts WHERE sku=$2) AS listing,
      (SELECT jsonb_agg(to_jsonb(mapping) ORDER BY mapping.offer_id)
        FROM ${schema}.ozon_product_mappings mapping WHERE sku=$2) AS mappings,
      (SELECT jsonb_build_object('jobId',job_id,'payload',payload,'updatedAt',updated_at::text)
        FROM ${schema}.ozon_media_deliveries
        WHERE sku=$2 AND source_stage_id='E005' AND submission_id=$3 AND variant_id=$4) AS delivery,
      (SELECT COUNT(*)::int FROM ${schema}.ozon_publish_events WHERE job_id=$1) AS event_count`,
    [driftJob.id, sku, driftSubmissionId, variantId]);
    await expect(repository.recordN8nUpdate(driftJob.id, {
      rowVersion: driftJob.rowVersion,
      state: 'SUCCEEDED',
      eventType: 'AUTO_INTEGRATION_DRIFTED',
      message: '该回写必须在任何 mutation 前拒绝',
      offerIds: [offerId, legacyOfferId],
      productMappings: [
        { offerId, ozonProductId: '9100113', ozonSku: '9200113', platformStatus: 'ON_SALE' },
        { offerId: legacyOfferId, ozonProductId: '9100114', ozonSku: '9200114', platformStatus: 'ON_SALE' }
      ],
      lastAppliedRevision: 1,
      platformStatus: 'ON_SALE'
    })).rejects.toMatchObject({ code: 'TASK_LOCKED', statusCode: 409 });
    const afterRejected = await admin.query(`SELECT
      (SELECT jsonb_build_object('state',state,'rowVersion',row_version,'payload',payload)
        FROM ${schema}.ozon_publish_jobs WHERE id=$1) AS job,
      (SELECT jsonb_build_object('status',status,'rowVersion',row_version,'revision',revision)
        FROM ${schema}.ozon_listing_drafts WHERE sku=$2) AS listing,
      (SELECT jsonb_agg(to_jsonb(mapping) ORDER BY mapping.offer_id)
        FROM ${schema}.ozon_product_mappings mapping WHERE sku=$2) AS mappings,
      (SELECT jsonb_build_object('jobId',job_id,'payload',payload,'updatedAt',updated_at::text)
        FROM ${schema}.ozon_media_deliveries
        WHERE sku=$2 AND source_stage_id='E005' AND submission_id=$3 AND variant_id=$4) AS delivery,
      (SELECT COUNT(*)::int FROM ${schema}.ozon_publish_events WHERE job_id=$1) AS event_count`,
    [driftJob.id, sku, driftSubmissionId, variantId]);
    expect(afterRejected.rows).toEqual(beforeRejected.rows);
  });
});

function testStableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(testStableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${testStableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function integrationSharedOffer(sku: string, productVariantName: string, variantId = randomUUID()) {
  return {
    variantId,
    productVariantId: variantId,
    productVariantName,
    variantCode: '01',
    offerId: stableOzonOfferId(sku, '01'),
    price: 1,
    stock: 0,
    attributes: [],
    media: []
  };
}

function integrationPayloadHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(testStableJson(value)).digest('hex')}`;
}
