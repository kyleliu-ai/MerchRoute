import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PricingRepository } from './pricing.js';
import { PurchaseRepository } from './purchases.js';
import { ShippingRepository } from './shipping.js';
import { WbPresetRepository } from './wb-presets.js';
import { WbAutoPublishRepository } from './wb-auto-publish.js';
import { WbRepository } from './wb.js';

const connectionString = process.env.DATABASE_URL;
const schema = `wb_preset_test_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let purchases: PurchaseRepository;
let shipping: ShippingRepository;
let pricing: PricingRepository;
let wb: WbRepository;
let presets: WbPresetRepository;
let autoPublish: WbAutoPublishRepository;
let isolatedPool: Pool;

describe.runIf(Boolean(connectionString))('WB preset PostgreSQL repository', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const isolated = new URL(connectionString!);
    isolated.searchParams.set('options', `-c search_path=${schema},public`);
    isolatedPool = new Pool({ connectionString: isolated.toString(), max: 1 });
    purchases = new PurchaseRepository(isolated.toString());
    shipping = new ShippingRepository(isolated.toString());
    pricing = new PricingRepository(isolated.toString());
    wb = new WbRepository(isolated.toString());
    presets = new WbPresetRepository(isolated.toString());
    await purchases.initialize({ code: 'E999', displayName: '测试下载', webhookUrl: 'http://127.0.0.1:5678/webhook/test', parentOutputDir: 'C:\\wb-preset-test', enabled: true, isDefault: true });
    await shipping.initialize();
    await pricing.initialize();
    await wb.initialize();
    await presets.initialize();
    autoPublish = new WbAutoPublishRepository(isolated.toString());
    await autoPublish.initialize();
    const liveSchema = [
      { charcID: 15004139, name: 'ТН ВЭД', charcType: 1 },
      { charcID: 204557, name: 'Пол', charcType: 1 },
      { charcID: 14177449, name: 'Цвет', charcType: 1 }
    ];
    const formConfig = { fields: [
      { fieldId: 'tnved', characteristicId: 15004139, labelRu: 'ТН ВЭД', scope: 'shared', control: 'select', required: true, order: 1 },
      { fieldId: 'gender', characteristicId: 204557, labelRu: 'Пол', scope: 'shared', control: 'select', required: false, order: 2 },
      { fieldId: 'color', characteristicId: 14177449, labelRu: 'Цвет', scope: 'variant', control: 'multi-select', required: false, order: 3 }
    ], sizeMode: 'sized', compliance: { tnvedCharacteristicId: 15004139 } };
    await wb.createCategory('preset_shoes', { nameRu: 'Кроссовки', subjectId: 105, liveSchema, formConfig });
    await wb.publishCategory('preset_shoes', 'qa@example.com');
  });

  afterAll(async () => {
    await Promise.all([autoPublish?.close(), presets?.close(), wb?.close(), pricing?.close(), shipping?.close(), purchases?.close(), isolatedPool?.end()]);
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('keeps defaults store-scoped and enforces optimistic row versions', async () => {
    const definition = {
      name: '默认预设', pricingTemplateId: '7c9d6f4a-8f5c-4c3e-9a80-000000000001', shippingTemplateId: '6d8c5d9a-6ea7-4f28-9ba0-000000000003',
      shippingServiceCode: 'CEL_WB_ECONOMY', packaging: { grossWeightGrams: 750, lengthCm: 30, widthCm: 15, heightCm: 10 },
      categoryKey: 'preset_shoes', discountPercent: 49, clubDiscount: null, tnved: '6404199000',
      sharedCharacteristics: [{ id: 204557, value: ['Женский'] }], variantCharacteristics: [{ id: 14177449, value: ['Черный'] }],
      sizes: [{ techSize: '40', stock: 3 }]
    };
    const dependencies = await presets.resolveDependencies(definition);
    const snapshot = {
      pricingTemplateVersionId: dependencies.pricing!.versionId, pricingTemplateVersionNo: dependencies.pricing!.versionNo,
      shippingTemplateVersionId: dependencies.shipping!.versionId, shippingTemplateVersionNo: dependencies.shipping!.versionNo,
      categoryVersionId: dependencies.category!.versionId, categoryVersionNo: dependencies.category!.versionNo, capturedAt: new Date().toISOString()
    };
    const first = await presets.create(definition, snapshot, true);
    expect(first.isDefault).toBe(false);
    expect(first.autoPublishEnabled).toBe(false);
    expect(first.autoPublishActivatedAt).toBeUndefined();
    expect(first).not.toHaveProperty('videoUploadMode');
    expect(first.sizes[0]?.sizeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.sharedCharacteristics).toEqual([{ id: 204557, value: ['Женский'] }]);
    expect(first.variantCharacteristics).toEqual([{ id: 14177449, value: ['Черный'] }]);
    await expect(presets.get(first.id)).resolves.toMatchObject({
      sharedCharacteristics: [{ id: 204557, value: ['Женский'] }],
      variantCharacteristics: [{ id: 14177449, value: ['Черный'] }]
    });
    const enabled = await presets.update(first.id, { ...first, autoPublishEnabled: true, rowVersion: first.rowVersion }, snapshot, true);
    expect(enabled.autoPublishEnabled).toBe(true);
    expect(enabled.autoPublishActivatedAt).toBeUndefined();
    const second = await presets.create({ ...definition, name: '第二预设' }, snapshot, true);
    expect(second.isDefault).toBe(false);
    const selected = await presets.update(second.id, { ...second, isDefault: true, rowVersion: second.rowVersion }, snapshot, true);
    expect(selected).toMatchObject({ isDefault: false, rowVersion: second.rowVersion + 1 });
    const unchanged = await presets.get(first.id);
    expect(unchanged).toMatchObject({ isDefault: false, autoPublishEnabled: true, rowVersion: enabled.rowVersion });
    expect(unchanged.autoPublishActivatedAt).toBeUndefined();
    await expect(presets.update(second.id, { ...second, name: '过期更新', rowVersion: second.rowVersion }, snapshot, true)).rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
  });

  it('supports CRUD, clone, case-insensitive unique names, and deleting the default without replacement', async () => {
    const definition = {
      name: 'CRUD 验收预设', pricingTemplateId: '7c9d6f4a-8f5c-4c3e-9a80-000000000001', shippingTemplateId: '6d8c5d9a-6ea7-4f28-9ba0-000000000003',
      shippingServiceCode: 'CEL_WB_ECONOMY', packaging: { grossWeightGrams: 650, lengthCm: 28, widthCm: 14, heightCm: 9 },
      categoryKey: 'preset_shoes', discountPercent: 50, clubDiscount: 0, tnved: '6404199000',
      sharedCharacteristics: [{ id: 204557, value: ['Мужской'] }], variantCharacteristics: [{ id: 14177449, value: ['Белый'] }],
      sizes: [{ techSize: '39', wbSize: '39', stock: 5 }]
    };
    const dependencies = await presets.resolveDependencies(definition);
    const snapshot = {
      pricingTemplateVersionId: dependencies.pricing!.versionId, pricingTemplateVersionNo: dependencies.pricing!.versionNo,
      shippingTemplateVersionId: dependencies.shipping!.versionId, shippingTemplateVersionNo: dependencies.shipping!.versionNo,
      categoryVersionId: dependencies.category!.versionId, categoryVersionNo: dependencies.category!.versionNo, capturedAt: new Date().toISOString()
    };
    const created = await presets.create(definition, snapshot, true);
    expect(created.isDefault).toBe(false);
    expect(created).not.toHaveProperty('videoUploadMode');
    await expect(presets.create({ ...definition, name: 'crud 验收预设' }, snapshot, true)).rejects.toMatchObject({ code: 'CONFIG_INVALID', statusCode: 409 });

    const cloned = await presets.clone(created.id, 'CRUD 验收预设 副本', snapshot);
    expect(cloned).toMatchObject({ name: 'CRUD 验收预设 副本', isDefault: false, autoPublishEnabled: false, rowVersion: 1 });
    expect(cloned).not.toHaveProperty('videoUploadMode');
    expect(cloned.sizes[0]?.sizeId).toBe(created.sizes[0]?.sizeId);
    const updated = await presets.update(cloned.id, { ...cloned, brand: 'TestBrand', tnved: '', rowVersion: cloned.rowVersion }, snapshot, true);
    expect(updated).toMatchObject({ brand: 'TestBrand', tnved: '', rowVersion: 2 });
    await expect(presets.get(cloned.id)).resolves.toMatchObject({ tnved: '' });
    await expect(presets.update(cloned.id, { ...cloned, brand: 'stale', rowVersion: cloned.rowVersion }, snapshot, true)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const selected = await presets.setDefault(updated.id, updated.rowVersion);
    expect(selected).toMatchObject({ isDefault: true, rowVersion: 3 });
    await expect(presets.delete(selected.id, updated.rowVersion)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const deleted = await presets.delete(selected.id, selected.rowVersion);
    expect(deleted).toMatchObject({ id: selected.id, wasDefault: true });
    expect(await presets.getDefault()).toBeUndefined();
    await presets.delete(created.id, created.rowVersion);

    await presets.putTranslation('cache:test', 'hash-1', { contentTranslate: 'Первый' });
    await expect(presets.getTranslation('cache:test')).resolves.toEqual({ contentTranslate: 'Первый' });
    await presets.putTranslation('cache:test', 'hash-1', { contentTranslate: 'Второй' });
    await expect(presets.getTranslation('cache:test')).resolves.toEqual({ contentTranslate: 'Второй' });
  });

  it('creates automatic drafts with the manual-edit lock in the same insert', async () => {
    await isolatedPool.query("INSERT INTO products(sku,product_name) VALUES('0000097','自动草稿恢复测试')");
    const category = await wb.getPublishedCategory('preset_shoes');
    await expect(presets.createInitializedListing({
      sku: '0000097', categoryKey: 'preset_shoes', categoryVersionId: category.id, data: { variants: [] }, automatic: true,
      operationRef: 'automation:test-run'
    })).resolves.toBe(true);
    const row = await isolatedPool.query<{ auto_publish_locked: boolean; latest_operation_source: string; latest_operation_ref: string }>(
      "SELECT auto_publish_locked,latest_operation_source,latest_operation_ref FROM wb_listing_drafts WHERE sku='0000097'"
    );
    expect(row.rows[0]).toMatchObject({ auto_publish_locked: true, latest_operation_source: 'AUTOMATION', latest_operation_ref: 'automation:test-run' });
    await expect(presets.patchMissingListing({
      sku: '0000097', draftVersion: 1, patch: { titleRu: 'Ручной заголовок' }, initialization: { issues: [] }
    })).rejects.toMatchObject({ code: 'TASK_LOCKED', statusCode: 409 });
    await expect(presets.patchMissingListing({
      sku: '0000097', draftVersion: 1, patch: { titleRu: 'Автоматический заголовок' }, initialization: { issues: [] },
      automatic: true, operationRef: 'automation:test-run'
    })).resolves.toBeUndefined();
    await expect(wb.getListing('0000097')).resolves.toMatchObject({
      latestOperationSource: 'AUTOMATION', latestOperationRef: 'automation:test-run', titleRu: 'Автоматический заголовок'
    });
  });

  it('allows a generated automatic draft to be rebuilt from a frozen store-scoped automation publication', async () => {
    await isolatedPool.query("INSERT INTO products(sku,product_name) VALUES('0000096','多店不同预设测试')");
    const category = await wb.getPublishedCategory('preset_shoes');
    const preset = await isolatedPool.query<{ id: string }>('SELECT id::text FROM wb_listing_presets ORDER BY created_at LIMIT 1');
    const presetId = preset.rows[0]!.id;
    const deliveredAt = new Date(Date.now() - 60_000).toISOString();
    const autoBinding = {
      schemaVersion: 2,
      presetId,
      presetName: '并发生成预设',
      presetRowVersion: 1,
      boundAt: deliveredAt,
      activationStartedAt: deliveredAt,
      definitionHash: `sha256:${'d'.repeat(64)}`,
      presetSnapshot: { autoPublishEnabled: true },
      dependencySnapshot: {}
    };
    const firstJob = await autoPublish.enqueueDelivery({
      sku: '0000096', stageId: 'E005', submissionId: 'generation-owner-first', deliveredAt,
      preset: { id: presetId, name: '并发生成预设', rowVersion: 1, snapshot: { autoPublishEnabled: true } },
      binding: autoBinding, materialPresetDefinitionHash: `sha256:${'e'.repeat(64)}`,
      debounceUntil: deliveredAt, operationMode: 'COMPATIBLE_UPSERT'
    });
    const secondStoreId = randomUUID();
    await isolatedPool.query(`INSERT INTO wb_stores(id,store_alias,display_name)
      VALUES($1,'preset-race-second','预设竞态第二店') ON CONFLICT(id) DO NOTHING`, [secondStoreId]);
    const secondJob = await autoPublish.enqueueDelivery({
      storeId: secondStoreId,
      sku: '0000096', stageId: 'E005', submissionId: 'generation-owner-second', deliveredAt,
      preset: { id: presetId, name: '并发生成预设', rowVersion: 1, snapshot: { autoPublishEnabled: true } },
      binding: autoBinding, materialPresetDefinitionHash: `sha256:${'e'.repeat(64)}`,
      debounceUntil: deliveredAt, operationMode: 'COMPATIBLE_UPSERT'
    });
    expect(firstJob).toBeDefined();
    expect(secondJob).toBeDefined();
    await presets.createInitializedListing({
      sku: '0000096', categoryKey: 'preset_shoes', categoryVersionId: category.id,
      data: { variants: [] }, automatic: true, operationRef: `automation:${firstJob!.runId}`
    });
    const generatedVersionId = randomUUID();
    await isolatedPool.query(`INSERT INTO wb_listing_versions(
      id,sku,revision,status,category_version_id,product_json,media_manifest,generated_at,material_preset_definition_hash)
      VALUES($1,'0000096',1,'GENERATED',$2,'{}'::jsonb,'{}'::jsonb,NOW(),$3)`, [
      generatedVersionId, category.id, `sha256:${'a'.repeat(64)}`
    ]);
    await isolatedPool.query(`UPDATE wb_listing_drafts SET status='GENERATED',generated_version_id=$2,
      auto_publish_locked=true,n8n_task_id=NULL WHERE sku=$1`, ['0000096', generatedVersionId]);

    const rebuildInput = {
      sku: '0000096', categoryKey: 'preset_shoes', categoryVersionId: category.id,
      data: { variants: [], initialization: { presetName: '第二店预设' } },
      operationRef: `automation:${secondJob!.runId}`, allowGeneratedStoreFanout: true
    };
    const firstClaim = await autoPublish.claimGenerationLease(firstJob!);
    expect(firstClaim).toMatchObject({ acquired: true });
    await expect(presets.replaceInitializedListing(rebuildInput)).rejects.toMatchObject({
      code: 'AUTOMATION_BUSY', statusCode: 409,
      details: expect.objectContaining({ manualDraft: false, ownerRunId: firstJob!.runId })
    });

    const materializedVersionId = randomUUID();
    const materializationHash = `sha256:${'b'.repeat(64)}`;
    await isolatedPool.query(`INSERT INTO wb_listing_versions(
      id,sku,revision,status,category_version_id,product_json,media_manifest,generated_at,
      material_preset_definition_hash,generation_scope,materialization_hash)
      VALUES($1,'0000096',2,'GENERATED',$2,'{}'::jsonb,'{}'::jsonb,NOW(),$3,'STORE_PUBLICATION',$4)`, [
      materializedVersionId, category.id, `sha256:${'c'.repeat(64)}`, materializationHash
    ]);
    const publicationId = randomUUID();
    await isolatedPool.query(`INSERT INTO wb_store_publications(
      id,sku,generated_version_id,revision,store_id,store_alias_snapshot,status,source,config_snapshot,
      request_key,materialization_hash)
      VALUES($1,'0000096',$2,2,'00000000-0000-4000-8000-000000000001','default','PLANNED','MANUAL',$3::jsonb,$4,$5)`, [
      publicationId, materializedVersionId,
      JSON.stringify({ automationRunId: firstJob!.runId, sourceGeneratedVersionId: generatedVersionId }),
      `automation:${firstJob!.runId}:${firstJob!.storeId}`,
      materializationHash
    ]);

    await expect(presets.replaceInitializedListing(rebuildInput)).rejects.toMatchObject({
      code: 'AUTOMATION_BUSY', statusCode: 409
    });
    await isolatedPool.query("UPDATE wb_store_publications SET source='AUTOMATION',materialization_hash=NULL WHERE id=$1", [publicationId]);
    await expect(presets.replaceInitializedListing(rebuildInput)).rejects.toMatchObject({
      code: 'AUTOMATION_BUSY', statusCode: 409
    });
    await isolatedPool.query('UPDATE wb_store_publications SET materialization_hash=$2,config_snapshot=$3::jsonb WHERE id=$1', [
      publicationId, materializationHash,
      JSON.stringify({ automationRunId: firstJob!.runId, sourceGeneratedVersionId: randomUUID() })
    ]);
    await expect(presets.replaceInitializedListing(rebuildInput)).rejects.toMatchObject({
      code: 'AUTOMATION_BUSY', statusCode: 409
    });
    await isolatedPool.query("UPDATE wb_store_publications SET config_snapshot=$2::jsonb WHERE id=$1", [
      publicationId, JSON.stringify({ automationRunId: firstJob!.runId, sourceGeneratedVersionId: generatedVersionId })
    ]);
    const secondClaim = await autoPublish.claimGenerationLease(secondJob!);
    expect(secondClaim).toMatchObject({ acquired: true, ownerRunId: secondJob!.runId });
    const fencedRebuildInput = {
      ...rebuildInput,
      generationFence: { jobId: secondJob!.id, runId: secondJob!.runId, rowVersion: secondClaim.rowVersion }
    };
    await isolatedPool.query("UPDATE wb_listing_drafts SET latest_operation_source='MANUAL' WHERE sku='0000096'");
    await expect(presets.replaceInitializedListing(fencedRebuildInput)).rejects.toMatchObject({
      code: 'EXISTING_LOCAL_LISTING', statusCode: 409,
      details: expect.objectContaining({ manualDraft: true, ownershipSource: 'MANUAL' })
    });
    await isolatedPool.query("UPDATE wb_listing_drafts SET latest_operation_source='AUTOMATION' WHERE sku='0000096'");
    await expect(presets.replaceInitializedListing(fencedRebuildInput)).resolves.toBeUndefined();
    await expect(wb.getListing('0000096')).resolves.toMatchObject({
      status: 'STALE', autoPublishLocked: true, latestOperationRef: `automation:${secondJob!.runId}`
    });
    await expect(autoPublish.releaseGenerationLease(secondJob!, secondClaim.rowVersion)).resolves.toBe(true);
  });

  it('does not accept a legacy LISTING publication as cross-store rewrite evidence', async () => {
    await isolatedPool.query("INSERT INTO products(sku,product_name) VALUES('0000095','旧版多店兼容测试')");
    const category = await wb.getPublishedCategory('preset_shoes');
    await presets.createInitializedListing({
      sku: '0000095', categoryKey: 'preset_shoes', categoryVersionId: category.id,
      data: { variants: [] }, automatic: true, operationRef: 'automation:legacy-first-store'
    });
    const generatedVersionId = randomUUID();
    await isolatedPool.query(`INSERT INTO wb_listing_versions(
      id,sku,revision,status,category_version_id,product_json,media_manifest,generated_at,material_preset_definition_hash)
      VALUES($1,'0000095',1,'GENERATED',$2,'{}'::jsonb,'{}'::jsonb,NOW(),$3)`, [
      generatedVersionId, category.id, `sha256:${'d'.repeat(64)}`
    ]);
    await isolatedPool.query(`UPDATE wb_listing_drafts SET status='GENERATED',generated_version_id=$2,
      auto_publish_locked=true,n8n_task_id=NULL WHERE sku=$1`, ['0000095', generatedVersionId]);
    await isolatedPool.query(`INSERT INTO wb_store_publications(
      id,sku,generated_version_id,revision,store_id,store_alias_snapshot,status,source)
      VALUES($1,'0000095',$2,1,'00000000-0000-4000-8000-000000000001','default','SUCCEEDED','AUTOMATION')`, [
      randomUUID(), generatedVersionId
    ]);

    await expect(presets.replaceInitializedListing({
      sku: '0000095', categoryKey: 'preset_shoes', categoryVersionId: category.id,
      data: { variants: [], initialization: { presetName: '旧版第二店预设' } },
      operationRef: 'automation:legacy-second-store', allowGeneratedStoreFanout: true
    })).rejects.toMatchObject({ code: 'OWNERSHIP_AMBIGUOUS', statusCode: 409 });
  });

  it('persists TNVED requiredness from live schema rather than from form-field presence', async () => {
    const formConfig = {
      fields: [{ fieldId: 'tnved', characteristicId: 15004139, labelRu: 'ТН ВЭД', scope: 'shared', control: 'select', required: true, order: 1 }],
      sizeMode: 'sizeless', compliance: { tnvedCharacteristicId: 15004139, tnvedRequired: true }
    };
    await wb.createCategory('tnved_optional_policy', {
      nameRu: 'Необязательный ТНВЭД', subjectId: 50001,
      liveSchema: [{ charcID: 15004139, name: 'ТН ВЭД', required: false }], formConfig
    });
    await wb.publishCategory('tnved_optional_policy', 'qa@example.com');
    const optional = await wb.getPublishedCategory('tnved_optional_policy');
    expect(optional.formConfig.compliance).toEqual({ tnvedCharacteristicId: 15004139, tnvedRequired: false });

    await wb.createCategory('tnved_required_policy', {
      nameRu: 'Обязательный ТНВЭД', subjectId: 50002,
      liveSchema: [{ charcID: 15004139, name: 'ТН ВЭД', required: true }],
      formConfig: { ...formConfig, fields: [{ ...formConfig.fields[0]!, required: false }] }
    });
    await wb.publishCategory('tnved_required_policy', 'qa@example.com');
    const required = await wb.getPublishedCategory('tnved_required_policy');
    expect(required.formConfig.compliance).toEqual({ tnvedCharacteristicId: 15004139, tnvedRequired: true });
  });

  it('migrates existing presets to compressed-copy video uploads', async () => {
    const legacySchema = `wb_preset_legacy_${randomUUID().replaceAll('-', '')}`;
    const legacyPool = new Pool({ connectionString, max: 1 });
    let legacyRepository: WbPresetRepository | undefined;
    try {
      await admin.query(`CREATE SCHEMA ${legacySchema}`);
      await legacyPool.query(`SET search_path TO ${legacySchema},public`);
      await legacyPool.query('CREATE TABLE wb_schema_migrations(id TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
      await legacyPool.query("INSERT INTO wb_schema_migrations(id) VALUES('007_wb_listing_presets'),('008_wb_preset_characteristic_defaults')");
      await legacyPool.query(`CREATE TABLE wb_listing_presets(
        id UUID PRIMARY KEY,
        shared_characteristics JSONB NOT NULL DEFAULT '[]'::jsonb,
        variant_characteristics JSONB NOT NULL DEFAULT '[]'::jsonb
      )`);
      const presetId = randomUUID();
      await legacyPool.query(`INSERT INTO wb_listing_presets(id,shared_characteristics,variant_characteristics)
        VALUES($1,$2::jsonb,$3::jsonb)`, [
        presetId,
        JSON.stringify([{ id: 89008, value: 0 }, { id: 204557, value: ['Женский'] }]),
        JSON.stringify([{ id: 90630, value: 99 }, { id: 14177449, value: ['Черный'] }])
      ]);
      const isolated = new URL(connectionString!);
      isolated.searchParams.set('options', `-c search_path=${legacySchema},public`);
      legacyRepository = new WbPresetRepository(isolated.toString());
      await legacyRepository.initialize();
      const row = await legacyPool.query<{
        video_upload_mode: string;
        auto_publish_enabled: boolean;
        auto_publish_activated_at: Date | null;
        shared_characteristics: unknown[];
        variant_characteristics: unknown[];
      }>('SELECT video_upload_mode,auto_publish_enabled,auto_publish_activated_at,shared_characteristics,variant_characteristics FROM wb_listing_presets WHERE id=$1', [presetId]);
      expect(row.rows[0]?.video_upload_mode).toBe('COMPRESSED_COPY');
      expect(row.rows[0]?.auto_publish_enabled).toBe(false);
      expect(row.rows[0]?.auto_publish_activated_at).toBeNull();
      expect(row.rows[0]?.shared_characteristics).toEqual([{ id: 204557, value: ['Женский'] }]);
      expect(row.rows[0]?.variant_characteristics).toEqual([{ id: 14177449, value: ['Черный'] }]);
    } finally {
      await legacyRepository?.close();
      await legacyPool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${legacySchema} CASCADE`);
    }
  });
});
