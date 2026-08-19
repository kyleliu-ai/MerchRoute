import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import {
  AppError,
  wbListingPresetDefinitionSchema,
  wbListingPresetUpdateSchema,
  type WbListingPresetDefinition
} from '@n8n-media-review/shared';
import { normalizeWbFormConfigTnvedPolicy } from './wb.js';

type SqlRow = Record<string, any>;

export type WbPresetDependencySnapshot = {
  pricingTemplateVersionId: string;
  pricingTemplateVersionNo: number;
  shippingTemplateVersionId: string;
  shippingTemplateVersionNo: number;
  categoryVersionId: string;
  categoryVersionNo: number;
  capturedAt: string;
};

export type WbListingPresetRecord = WbListingPresetDefinition & {
  id: string;
  rowVersion: number;
  isDefault: boolean;
  autoPublishActivatedAt?: string;
  dependencySnapshot: WbPresetDependencySnapshot;
  createdAt: string;
  updatedAt: string;
};

export type WbPresetResolvedDependencies = {
  pricing?: { id: string; name: string; active: boolean; platformCode: string; versionId: string; versionNo: number; definition: Record<string, any> };
  shipping?: { id: string; name: string; active: boolean; carrierActive: boolean; platformCode: string; versionId: string; versionNo: number; definition: Record<string, any> };
  category?: { categoryKey: string; nameRu: string; nameZh: string; subjectId: number; active: boolean; versionId: string; versionNo: number; liveSchema: unknown; formConfig: Record<string, any>; schemaHash: string };
};

export class WbPresetRepository {
  private pool?: Pool;

  constructor(private readonly connectionString?: string) {}
  get configured(): boolean { return Boolean(this.pool); }

  async initialize(): Promise<void> {
    if (!this.connectionString) return;
    this.pool = new Pool({ connectionString: this.connectionString, max: 4, idleTimeoutMillis: 30_000 });
    try {
      await this.pool.query('SELECT 1');
      await this.migrate();
    } catch (error) {
      await this.pool.end().catch(() => undefined);
      this.pool = undefined;
      throw error;
    }
  }

  async close(): Promise<void> { await this.pool?.end(); }

  async list(): Promise<WbListingPresetRecord[]> {
    const result = await this.query<SqlRow>('SELECT * FROM wb_listing_presets ORDER BY updated_at DESC,name ASC');
    return result.rows.map(toPreset);
  }

  async get(id: string): Promise<WbListingPresetRecord> {
    const result = await this.query<SqlRow>('SELECT * FROM wb_listing_presets WHERE id=$1', [id]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'WB 上品预设模板不存在', { id }, 404);
    return toPreset(result.rows[0]);
  }

  async getDefault(): Promise<WbListingPresetRecord | undefined> {
    const result = await this.query<SqlRow>('SELECT * FROM wb_listing_presets WHERE is_default=true LIMIT 1');
    return result.rows[0] ? toPreset(result.rows[0]) : undefined;
  }

  async create(input: unknown, dependencySnapshot: WbPresetDependencySnapshot, _allowDefault: boolean): Promise<WbListingPresetRecord> {
    const parsed = wbListingPresetDefinitionSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error.issues);
    const definition = normalizeDefinition(parsed.data);
    return this.transaction(async (client) => {
      const result = await client.query<SqlRow>(`INSERT INTO wb_listing_presets(
        id,name,description,is_default,auto_publish_enabled,auto_publish_mode,auto_publish_activated_at,pricing_template_id,shipping_template_id,shipping_service_code,destination_country_code,
        packaging,category_key,discount_percent,club_discount,tnved,brand,title_translation,description_source,
        shared_characteristics,variant_characteristics,sizes,dependency_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18::jsonb,$19,$20::jsonb,$21::jsonb,$22::jsonb,$23::jsonb) RETURNING *`, [
        randomUUID(), definition.name, definition.description, false, definition.autoPublishEnabled,
        definition.autoPublishMode,
        null,
        definition.pricingTemplateId, definition.shippingTemplateId, definition.shippingServiceCode, definition.destinationCountryCode || null,
        JSON.stringify(definition.packaging), definition.categoryKey, definition.discountPercent, definition.clubDiscount, definition.tnved,
        definition.brand, JSON.stringify(definition.titleTranslation), definition.descriptionSource,
        JSON.stringify(definition.sharedCharacteristics), JSON.stringify(definition.variantCharacteristics), JSON.stringify(definition.sizes),
        JSON.stringify(dependencySnapshot)
      ]);
      return toPreset(result.rows[0]!);
    }).catch(translateConstraintError);
  }

  async update(id: string, input: unknown, dependencySnapshot: WbPresetDependencySnapshot, _allowDefault: boolean): Promise<WbListingPresetRecord> {
    const parsed = wbListingPresetUpdateSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error.issues);
    const definition = normalizeDefinition(parsed.data);
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>('SELECT * FROM wb_listing_presets WHERE id=$1 FOR UPDATE', [id]);
      if (!current.rows[0]) throw new AppError('NOT_FOUND', 'WB 上品预设模板不存在', { id }, 404);
      if (Number(current.rows[0].row_version) !== parsed.data.rowVersion) {
        throw new AppError('VERSION_CONFLICT', '上品预设已被其他操作修改，请刷新后重试', { expected: parsed.data.rowVersion, actual: Number(current.rows[0].row_version) }, 409);
      }
      const result = await client.query<SqlRow>(`UPDATE wb_listing_presets SET
        name=$2,description=$3,auto_publish_enabled=$4,auto_publish_mode=$5,pricing_template_id=$6,shipping_template_id=$7,
        shipping_service_code=$8,destination_country_code=$9,packaging=$10::jsonb,category_key=$11,discount_percent=$12,club_discount=$13,
        tnved=$14,brand=$15,title_translation=$16::jsonb,description_source=$17,shared_characteristics=$18::jsonb,
        variant_characteristics=$19::jsonb,sizes=$20::jsonb,dependency_snapshot=$21::jsonb,row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 RETURNING *`, [id, definition.name, definition.description, definition.autoPublishEnabled, definition.autoPublishMode,
        definition.pricingTemplateId, definition.shippingTemplateId, definition.shippingServiceCode, definition.destinationCountryCode || null,
        JSON.stringify(definition.packaging), definition.categoryKey, definition.discountPercent, definition.clubDiscount, definition.tnved,
        definition.brand, JSON.stringify(definition.titleTranslation), definition.descriptionSource, JSON.stringify(definition.sharedCharacteristics),
        JSON.stringify(definition.variantCharacteristics), JSON.stringify(definition.sizes), JSON.stringify(dependencySnapshot)]);
      return toPreset(result.rows[0]!);
    }).catch(translateConstraintError);
  }

  async clone(id: string, nameInput: string | undefined, dependencySnapshot: WbPresetDependencySnapshot): Promise<WbListingPresetRecord> {
    const source = await this.get(id);
    const name = String(nameInput || `${source.name} 副本`).trim();
    return this.create({ ...source, name, autoPublishEnabled: false }, dependencySnapshot, false);
  }

  async setDefault(id: string, expectedRowVersion: number): Promise<WbListingPresetRecord> {
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>('SELECT * FROM wb_listing_presets WHERE id=$1 FOR UPDATE', [id]);
      if (!current.rows[0]) throw new AppError('NOT_FOUND', 'WB 上品预设模板不存在', { id }, 404);
      if (Number(current.rows[0].row_version) !== expectedRowVersion) {
        throw new AppError('VERSION_CONFLICT', '上品预设已被其他操作修改，请刷新后重试', { expected: expectedRowVersion, actual: Number(current.rows[0].row_version) }, 409);
      }
      await client.query('UPDATE wb_listing_presets SET is_default=false,auto_publish_activated_at=NULL,row_version=row_version+1,updated_at=NOW() WHERE is_default=true AND id<>$1', [id]);
      const activatedAt = current.rows[0].auto_publish_enabled
        ? (current.rows[0].is_default && current.rows[0].auto_publish_activated_at ? current.rows[0].auto_publish_activated_at : new Date().toISOString())
        : null;
      const result = await client.query<SqlRow>('UPDATE wb_listing_presets SET is_default=true,auto_publish_activated_at=$2,row_version=row_version+1,updated_at=NOW() WHERE id=$1 RETURNING *', [id, activatedAt]);
      return toPreset(result.rows[0]!);
    });
  }

  async delete(id: string, expectedRowVersion: number): Promise<{ id: string; name: string; wasDefault: boolean }> {
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>('SELECT * FROM wb_listing_presets WHERE id=$1 FOR UPDATE', [id]);
      if (!current.rows[0]) throw new AppError('NOT_FOUND', 'WB 上品预设模板不存在', { id }, 404);
      if (Number(current.rows[0].row_version) !== expectedRowVersion) {
        throw new AppError('VERSION_CONFLICT', '上品预设已被其他操作修改，请刷新后重试', { expected: expectedRowVersion, actual: Number(current.rows[0].row_version) }, 409);
      }
      await client.query('DELETE FROM wb_listing_presets WHERE id=$1', [id]);
      return { id, name: String(current.rows[0].name), wasDefault: Boolean(current.rows[0].is_default) };
    });
  }

  async resolveDependencies(definition: Pick<WbListingPresetDefinition, 'pricingTemplateId' | 'shippingTemplateId' | 'categoryKey'>): Promise<WbPresetResolvedDependencies> {
    const [pricing, shipping, category] = await Promise.all([
      this.query<SqlRow>(`SELECT t.id,t.name,t.active,t.platform_code,v.id version_id,v.version_no,v.definition
        FROM pricing_templates t LEFT JOIN pricing_template_versions v ON v.template_id=t.id AND v.status='PUBLISHED' WHERE t.id=$1`, [definition.pricingTemplateId]),
      this.query<SqlRow>(`SELECT t.id,t.name,t.active,t.platform_code,c.active carrier_active,v.id version_id,v.version_no,v.definition
        FROM shipping_templates t JOIN shipping_carriers c ON c.code=t.carrier_code
        LEFT JOIN shipping_template_versions v ON v.template_id=t.id AND v.status='PUBLISHED' WHERE t.id=$1`, [definition.shippingTemplateId]),
      this.query<SqlRow>(`SELECT t.category_key,t.name_ru,t.name_zh,t.subject_id,t.active,v.id version_id,v.version_no,v.live_schema,v.form_config,v.schema_hash
        FROM wb_category_templates t LEFT JOIN wb_category_template_versions v ON v.template_id=t.id AND v.status='PUBLISHED' WHERE t.category_key=$1`, [definition.categoryKey])
    ]);
    const p = pricing.rows[0];
    const s = shipping.rows[0];
    const c = category.rows[0];
    return {
      ...(p?.version_id ? { pricing: { id: p.id, name: p.name, active: Boolean(p.active), platformCode: p.platform_code, versionId: p.version_id, versionNo: Number(p.version_no), definition: p.definition } } : {}),
      ...(s?.version_id ? { shipping: { id: s.id, name: s.name, active: Boolean(s.active), carrierActive: Boolean(s.carrier_active), platformCode: s.platform_code, versionId: s.version_id, versionNo: Number(s.version_no), definition: s.definition } } : {}),
      ...(c?.version_id ? { category: {
        categoryKey: c.category_key, nameRu: c.name_ru, nameZh: c.name_zh || '', subjectId: Number(c.subject_id), active: Boolean(c.active),
        versionId: c.version_id, versionNo: Number(c.version_no), liveSchema: c.live_schema || [],
        formConfig: normalizeWbFormConfigTnvedPolicy(c.form_config || {}, c.live_schema || []), schemaHash: c.schema_hash
      } } : {})
    };
  }

  async resolveDependenciesAtSnapshot(
    definition: Pick<WbListingPresetDefinition, 'pricingTemplateId' | 'shippingTemplateId' | 'categoryKey'>,
    snapshot: WbPresetDependencySnapshot
  ): Promise<WbPresetResolvedDependencies> {
    const [pricing, shipping, category] = await Promise.all([
      this.query<SqlRow>(`SELECT t.id,t.name,t.active,t.platform_code,v.id version_id,v.version_no,v.definition
        FROM pricing_templates t JOIN pricing_template_versions v ON v.template_id=t.id
        WHERE t.id=$1 AND v.id=$2`, [definition.pricingTemplateId, snapshot.pricingTemplateVersionId]),
      this.query<SqlRow>(`SELECT t.id,t.name,t.active,t.platform_code,c.active carrier_active,v.id version_id,v.version_no,v.definition
        FROM shipping_templates t JOIN shipping_carriers c ON c.code=t.carrier_code
        JOIN shipping_template_versions v ON v.template_id=t.id
        WHERE t.id=$1 AND v.id=$2`, [definition.shippingTemplateId, snapshot.shippingTemplateVersionId]),
      this.query<SqlRow>(`SELECT t.category_key,t.name_ru,t.name_zh,t.subject_id,t.active,v.id version_id,v.version_no,v.live_schema,v.form_config,v.schema_hash
        FROM wb_category_templates t JOIN wb_category_template_versions v ON v.template_id=t.id
        WHERE t.category_key=$1 AND v.id=$2`, [definition.categoryKey, snapshot.categoryVersionId])
    ]);
    const p = pricing.rows[0];
    const s = shipping.rows[0];
    const c = category.rows[0];
    return {
      ...(p ? { pricing: { id: p.id, name: p.name, active: Boolean(p.active), platformCode: p.platform_code, versionId: p.version_id, versionNo: Number(p.version_no), definition: p.definition } } : {}),
      ...(s ? { shipping: { id: s.id, name: s.name, active: Boolean(s.active), carrierActive: Boolean(s.carrier_active), platformCode: s.platform_code, versionId: s.version_id, versionNo: Number(s.version_no), definition: s.definition } } : {}),
      ...(c ? { category: {
        categoryKey: c.category_key, nameRu: c.name_ru, nameZh: c.name_zh || '', subjectId: Number(c.subject_id), active: Boolean(c.active),
        versionId: c.version_id, versionNo: Number(c.version_no), liveSchema: c.live_schema || [],
        formConfig: normalizeWbFormConfigTnvedPolicy(c.form_config || {}, c.live_schema || []), schemaHash: c.schema_hash
      } } : {})
    };
  }

  async createInitializedListing(input: { sku: string; categoryKey: string; categoryVersionId: string; data: Record<string, unknown>; automatic?: boolean; operationRef?: string }): Promise<boolean> {
    const source = input.automatic === true ? 'AUTOMATION' : 'MANUAL';
    const operationRef = input.operationRef || (input.automatic === true ? 'automation:initialize' : 'manual:create');
    const result = await this.query(`INSERT INTO wb_listing_drafts(
        sku,category_key,category_version_id,data,auto_publish_locked,
        latest_operation_source,latest_operation_at,latest_operation_ref)
      SELECT p.sku,$2,$3,$4::jsonb,$5,$6,NOW(),$7 FROM products p WHERE p.sku=$1 ON CONFLICT(sku) DO NOTHING`, [
      input.sku, input.categoryKey, input.categoryVersionId, JSON.stringify(input.data), input.automatic === true, source, operationRef
    ]);
    if (!result.rowCount) {
      const product = await this.query('SELECT sku FROM products WHERE sku=$1', [input.sku]);
      if (!product.rows[0]) throw new AppError('NOT_FOUND', '产品 SKU 不存在', { sku: input.sku }, 404);
      return false;
    }
    return true;
  }

  async createPublicMaterialListing(input: { sku: string; data: Record<string, unknown> }): Promise<boolean> {
    const result = await this.query(`INSERT INTO wb_listing_drafts(
        sku,data,auto_publish_locked,latest_operation_source,latest_operation_at,latest_operation_ref)
      SELECT p.sku,$2::jsonb,false,'MANUAL',NOW(),'manual:public-material:create'
      FROM products p WHERE p.sku=$1 ON CONFLICT(sku) DO NOTHING`, [input.sku, JSON.stringify(input.data)]);
    if (!result.rowCount) {
      const product = await this.query('SELECT sku FROM products WHERE sku=$1', [input.sku]);
      if (!product.rows[0]) throw new AppError('NOT_FOUND', '产品 SKU 不存在', { sku: input.sku }, 404);
      return false;
    }
    return true;
  }

  async replaceInitializedListing(input: {
    sku: string;
    categoryKey: string;
    categoryVersionId: string;
    data: Record<string, unknown>;
    operationRef?: string;
    allowGeneratedStoreFanout?: boolean;
    generationFence?: { jobId: string; runId: string; rowVersion: number };
  }): Promise<void> {
    await this.transaction(async (client) => {
      const result = await client.query<SqlRow>('SELECT * FROM wb_listing_drafts WHERE sku=$1 FOR UPDATE', [input.sku]);
      const row = result.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'WB 上品草稿不存在', { sku: input.sku }, 404);
      const operationRef = String(row.latest_operation_ref || '');
      const ownerRunId = parseAutomationRunId(operationRef);
      const requestedRunId = parseAutomationRunId(String(input.operationRef || ''));
      const ownerJob = ownerRunId ? (await client.query<SqlRow>(
        'SELECT id,store_id,state,publication_id FROM wb_auto_publish_jobs WHERE sku=$1 AND run_id=$2::uuid LIMIT 1',
        [input.sku, ownerRunId]
      )).rows[0] : undefined;
      const generationLeaseTable = Boolean((await client.query<{ available: boolean }>(
        "SELECT to_regclass(current_schema()||'.wb_auto_generation_leases') IS NOT NULL available"
      )).rows[0]?.available);
      const generationLease = generationLeaseTable && input.generationFence ? (await client.query<SqlRow>(
        `SELECT * FROM wb_auto_generation_leases
          WHERE sku=$1 AND owner_job_id=$2::uuid AND owner_run_id=$3::uuid
            AND row_version=$4 AND lease_until>NOW()`,
        [input.sku, input.generationFence.jobId, input.generationFence.runId, input.generationFence.rowVersion]
      )).rows[0] : undefined;
      const currentOwnsLease = Boolean(generationLease && requestedRunId && input.generationFence
        && input.generationFence.runId === requestedRunId);
      const versionCount = Number((await client.query<{ total: string }>(
        'SELECT COUNT(*)::text total FROM wb_listing_versions WHERE sku=$1',
        [input.sku]
      )).rows[0]?.total || 0);
      const reclaimableStaleAutomationDraft = currentOwnsLease && isReclaimableAutomationDraftRow(row, versionCount);
      const generatedStoreFanout = input.allowGeneratedStoreFanout === true
        && currentOwnsLease
        && String(row.status) === 'GENERATED'
        && row.latest_operation_source === 'AUTOMATION'
        && row.auto_publish_locked === true
        && Boolean(row.generated_version_id)
        && !row.n8n_task_id
        && Boolean(ownerJob && ownerRunId)
        && Boolean((await client.query<{ frozen: boolean }>(`SELECT EXISTS(
          SELECT 1
          FROM wb_store_publications publication
          JOIN wb_listing_versions publication_version ON publication_version.id=publication.generated_version_id
          JOIN wb_listing_versions source_version
            ON source_version.id::text=publication.config_snapshot->>'sourceGeneratedVersionId'
          WHERE publication.source='AUTOMATION'
            AND publication.sku=$1
            AND publication.store_id=$3::uuid
            AND publication.request_key='automation:'||$2::text||':'||$3::text
            AND publication.config_snapshot->>'automationRunId'=$2::text
            AND publication.config_snapshot->>'sourceGeneratedVersionId'=$4::text
            AND publication.materialization_hash~'^sha256:[0-9a-f]{64}$'
            AND publication_version.sku=publication.sku
            AND publication_version.status='GENERATED'
            AND publication_version.generation_scope='STORE_PUBLICATION'
            AND publication_version.materialization_hash=publication.materialization_hash
            AND source_version.id=$4::uuid
            AND source_version.sku=publication.sku
            AND source_version.status='GENERATED'
            AND source_version.generation_scope='LISTING'
        ) frozen`, [input.sku, ownerRunId || null, ownerJob?.store_id || null, row.generated_version_id])).rows[0]?.frozen);
      const sameAutomationOwner = currentOwnsLease && Boolean(ownerRunId && requestedRunId && ownerRunId === requestedRunId);
      const automationOrphaned = row.latest_operation_source === 'AUTOMATION' && Boolean(ownerJob)
        && currentOwnsLease && ownerRunId !== requestedRunId;
      const terminalListing = ['SUCCEEDED', 'FAILED', 'BLOCKED'].includes(String(row.status));
      if (row.latest_operation_source === 'AUTOMATION' && (!ownerRunId || !ownerJob || !requestedRunId)) {
        throw new AppError('OWNERSHIP_AMBIGUOUS', '自动草稿的 operationRef 无法映射到同一 SKU 的自动任务，已停止覆盖', {
          sku: input.sku, status: row.status, ownershipSource: row.latest_operation_source,
          operationRef, manualDraft: false
        }, 409);
      }
      const automaticReplaceAllowed = row.latest_operation_source === 'AUTOMATION'
        && currentOwnsLease
        && (sameAutomationOwner || automationOrphaned || reclaimableStaleAutomationDraft || generatedStoreFanout || terminalListing);
      if (row.latest_operation_source === 'AUTOMATION' && !automaticReplaceAllowed) {
        throw new AppError('AUTOMATION_BUSY', '同一 SKU 的另一店正在冻结共享版本，请等待生成轮次', {
          sku: input.sku, status: row.status, ownershipSource: row.latest_operation_source,
          operationRef, manualDraft: false, ownerJobId: String(ownerJob!.id), ownerRunId,
          ownerStoreId: String(ownerJob!.store_id), ownerState: String(ownerJob!.state),
          ...(generationLease ? {
            generationLeaseUntil: new Date(generationLease.lease_until).toISOString(),
            generationLeaseRowVersion: Number(generationLease.row_version)
          } : {})
        }, 409);
      }
      if (row.latest_operation_source !== 'AUTOMATION' && !terminalListing) {
        throw new AppError('EXISTING_LOCAL_LISTING', '当前 SKU 存在尚未提交的人工草稿，兼容更新已停止', {
          sku: input.sku, status: row.status, ownershipSource: row.latest_operation_source || 'MANUAL',
          operationRef: operationRef || null, manualDraft: true
        }, 409);
      }
      if (!currentOwnsLease) {
        throw new AppError('AUTOMATION_GENERATION_LEASE_LOST', '兼容重建缺少当前自动生成 fencing token', {
          sku: input.sku,
          requestedRunId: requestedRunId || null,
          expectedRowVersion: input.generationFence?.rowVersion || null
        }, 409);
      }
      const updated = await client.query(`UPDATE wb_listing_drafts SET category_key=$2,category_version_id=$3,data=$4::jsonb,
        media_assets='[]'::jsonb,variant_media='[]'::jsonb,draft_version=draft_version+1,status='STALE',n8n_task_id=NULL,last_error=NULL,
        auto_publish_locked=true,latest_operation_source='AUTOMATION',latest_operation_at=NOW(),latest_operation_ref=$5,
        updated_at=NOW() WHERE sku=$1 AND EXISTS(
          SELECT 1 FROM wb_auto_generation_leases generation_lease
          WHERE generation_lease.sku=$1 AND generation_lease.owner_job_id=$6::uuid
            AND generation_lease.owner_run_id=$7::uuid AND generation_lease.row_version=$8
            AND generation_lease.lease_until>NOW()
        )`, [
        input.sku, input.categoryKey, input.categoryVersionId, JSON.stringify(input.data),
        input.operationRef || 'automation:rebuild', input.generationFence!.jobId,
        input.generationFence!.runId, input.generationFence!.rowVersion
      ]);
      if ((updated.rowCount || 0) !== 1) {
        throw new AppError('AUTOMATION_GENERATION_LEASE_LOST', '兼容重建写入前自动生成租约已失效', {
          sku: input.sku, runId: input.generationFence!.runId,
          expectedRowVersion: input.generationFence!.rowVersion
        }, 409);
      }
    });
  }

  async patchMissingListing(input: { sku: string; draftVersion: number; patch: Record<string, unknown>; initialization: Record<string, unknown>; automatic?: boolean; operationRef?: string }): Promise<void> {
    await this.transaction(async (client) => {
      const result = await client.query<SqlRow>('SELECT * FROM wb_listing_drafts WHERE sku=$1 FOR UPDATE', [input.sku]);
      const row = result.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'WB 上品草稿不存在', { sku: input.sku }, 404);
      if (Number(row.draft_version) !== input.draftVersion) throw new AppError('VERSION_CONFLICT', '草稿已被其他操作更新，请刷新后重试', { expected: input.draftVersion, actual: Number(row.draft_version) }, 409);
      if (row.auto_publish_locked && input.automatic !== true) throw new AppError('TASK_LOCKED', '当前 SKU 正由自动上品流程处理，暂不能人工重试初始化', { sku: input.sku }, 409);
      if (['GENERATING', 'SUBMITTING', 'QUEUED', 'RUNNING'].includes(row.status)) throw new AppError('TASK_LOCKED', '当前 SKU 正在处理，不能重试初始化', { sku: input.sku, status: row.status }, 409);
      const current = asObject(row.data);
      const next = { ...current };
      for (const [key, value] of Object.entries(input.patch)) {
        if (key === 'variants' && Array.isArray(current.variants) && Array.isArray(value)) {
          const incoming = new Map(value.map((variantInput) => {
            const variant = asObject(variantInput);
            return [String(variant.variantId || ''), variant] as const;
          }));
          next.variants = current.variants.map((variantInput) => {
            const variant = asObject(variantInput);
            const update = incoming.get(String(variant.variantId || ''));
            if (!update || String(variant.descriptionRu || '').trim() || !String(update.descriptionRu || '').trim()) return variant;
            return { ...variant, descriptionRu: String(update.descriptionRu) };
          });
          continue;
        }
        if (current[key] === '' || current[key] === 0 || current[key] == null) next[key] = value;
      }
      next.initialization = input.initialization;
      next.initializationIssues = Array.isArray(input.initialization.issues) ? input.initialization.issues : [];
      const source = input.automatic === true ? 'AUTOMATION' : 'MANUAL';
      const operationRef = input.operationRef || (input.automatic === true ? 'automation:initialize-missing' : `manual:initialize-missing:${input.draftVersion}`);
      await client.query(`UPDATE wb_listing_drafts SET data=$2::jsonb,draft_version=draft_version+1,
        status=CASE WHEN generated_version_id IS NULL THEN 'DRAFT' ELSE 'STALE' END,last_error=NULL,
        latest_operation_source=$3,latest_operation_at=NOW(),latest_operation_ref=$4,updated_at=NOW() WHERE sku=$1`, [
        input.sku, JSON.stringify(next), source, operationRef
      ]);
    });
  }

  async getTranslation(cacheKey: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.query<{ response_json: Record<string, unknown> }>('SELECT response_json FROM wb_title_translation_cache WHERE cache_key=$1', [cacheKey]);
    return result.rows[0]?.response_json;
  }

  async putTranslation(cacheKey: string, inputHash: string, response: Record<string, unknown>): Promise<void> {
    await this.query(`INSERT INTO wb_title_translation_cache(cache_key,input_hash,response_json) VALUES($1,$2,$3::jsonb)
      ON CONFLICT(cache_key) DO UPDATE SET response_json=EXCLUDED.response_json,updated_at=NOW()`, [cacheKey, inputHash, JSON.stringify(response)]);
  }

  private async migrate(): Promise<void> {
    await this.query('CREATE TABLE IF NOT EXISTS wb_schema_migrations(id TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const lock = await this.requirePool().connect();
    try {
      await lock.query("SELECT pg_advisory_lock(hashtext('pixroute_wb_schema_migrations'))");
      const applied = await lock.query("SELECT id FROM wb_schema_migrations WHERE id='007_wb_listing_presets'");
      if (!applied.rows[0]) {
        await lock.query('BEGIN');
        await lock.query(`CREATE TABLE wb_listing_presets(
          id UUID PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',is_default BOOLEAN NOT NULL DEFAULT false,row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
          pricing_template_id UUID NOT NULL REFERENCES pricing_templates(id) ON DELETE RESTRICT,
          shipping_template_id UUID NOT NULL REFERENCES shipping_templates(id) ON DELETE RESTRICT,
          shipping_service_code TEXT NOT NULL,destination_country_code TEXT,packaging JSONB NOT NULL,
          category_key TEXT NOT NULL REFERENCES wb_category_templates(category_key) ON DELETE RESTRICT,
          discount_percent INTEGER NOT NULL CHECK(discount_percent BETWEEN 0 AND 99),club_discount INTEGER CHECK(club_discount IS NULL OR club_discount=0 OR club_discount BETWEEN 3 AND 31),
          tnved TEXT NOT NULL,brand TEXT NOT NULL DEFAULT '',title_translation JSONB NOT NULL,description_source TEXT NOT NULL CHECK(description_source='E003'),
          shared_characteristics JSONB NOT NULL DEFAULT '[]'::jsonb,variant_characteristics JSONB NOT NULL DEFAULT '[]'::jsonb,
          sizes JSONB NOT NULL,dependency_snapshot JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await lock.query('CREATE UNIQUE INDEX wb_listing_presets_name_unique ON wb_listing_presets(LOWER(name))');
        await lock.query('CREATE UNIQUE INDEX wb_listing_presets_one_default ON wb_listing_presets((is_default)) WHERE is_default=true');
        await lock.query('CREATE INDEX wb_listing_presets_updated ON wb_listing_presets(updated_at DESC)');
        await lock.query(`CREATE TABLE wb_title_translation_cache(
          cache_key TEXT PRIMARY KEY,input_hash TEXT NOT NULL,response_json JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await lock.query("INSERT INTO wb_schema_migrations(id) VALUES('007_wb_listing_presets')");
        await lock.query('COMMIT');
      }
      const characteristicDefaultsApplied = await lock.query("SELECT id FROM wb_schema_migrations WHERE id='008_wb_preset_characteristic_defaults'");
      if (!characteristicDefaultsApplied.rows[0]) {
        await lock.query('BEGIN');
        await lock.query("ALTER TABLE wb_listing_presets ADD COLUMN IF NOT EXISTS shared_characteristics JSONB NOT NULL DEFAULT '[]'::jsonb");
        await lock.query("ALTER TABLE wb_listing_presets ADD COLUMN IF NOT EXISTS variant_characteristics JSONB NOT NULL DEFAULT '[]'::jsonb");
        await lock.query("INSERT INTO wb_schema_migrations(id) VALUES('008_wb_preset_characteristic_defaults')");
        await lock.query('COMMIT');
      }
      const videoUploadModeApplied = await lock.query("SELECT id FROM wb_schema_migrations WHERE id='009_wb_preset_video_upload_mode'");
      if (!videoUploadModeApplied.rows[0]) {
        await lock.query('BEGIN');
        await lock.query("ALTER TABLE wb_listing_presets ADD COLUMN IF NOT EXISTS video_upload_mode TEXT NOT NULL DEFAULT 'COMPRESSED_COPY' CHECK(video_upload_mode IN ('ORIGINAL','COMPRESSED_COPY'))");
        await lock.query("INSERT INTO wb_schema_migrations(id) VALUES('009_wb_preset_video_upload_mode')");
        await lock.query('COMMIT');
      }
      const autoPublishApplied = await lock.query("SELECT id FROM wb_schema_migrations WHERE id='010_wb_preset_auto_publish'");
      if (!autoPublishApplied.rows[0]) {
        await lock.query('BEGIN');
        await lock.query('ALTER TABLE wb_listing_presets ADD COLUMN IF NOT EXISTS auto_publish_enabled BOOLEAN NOT NULL DEFAULT false');
        await lock.query('ALTER TABLE wb_listing_presets ADD COLUMN IF NOT EXISTS auto_publish_activated_at TIMESTAMPTZ');
        await lock.query(`DO $$ BEGIN
          IF to_regclass('wb_listing_drafts') IS NOT NULL THEN
            ALTER TABLE wb_listing_drafts ADD COLUMN IF NOT EXISTS auto_publish_locked BOOLEAN NOT NULL DEFAULT false;
          END IF;
        END $$`);
        await lock.query("UPDATE wb_listing_presets SET auto_publish_enabled=false,auto_publish_activated_at=NULL");
        await lock.query("INSERT INTO wb_schema_migrations(id) VALUES('010_wb_preset_auto_publish')");
        await lock.query('COMMIT');
      }
      const autoPublishModeApplied = await lock.query("SELECT id FROM wb_schema_migrations WHERE id='015_wb_preset_auto_publish_mode'");
      if (!autoPublishModeApplied.rows[0]) {
        await lock.query('BEGIN');
        await lock.query("ALTER TABLE wb_listing_presets ADD COLUMN IF NOT EXISTS auto_publish_mode TEXT NOT NULL DEFAULT 'CREATE_ONLY' CHECK(auto_publish_mode IN ('CREATE_ONLY','COMPATIBLE_UPSERT'))");
        await lock.query("INSERT INTO wb_schema_migrations(id) VALUES('015_wb_preset_auto_publish_mode')");
        await lock.query('COMMIT');
      }
      const purchaseCharacteristicsCleaned = await lock.query("SELECT id FROM wb_schema_migrations WHERE id='023_wb_preset_purchase_characteristic_cleanup'");
      if (!purchaseCharacteristicsCleaned.rows[0]) {
        await lock.query('BEGIN');
        // Some early installations recorded migration 008 before every column
        // had been materialized. Make the cleanup independently recoverable.
        await lock.query("ALTER TABLE wb_listing_presets ADD COLUMN IF NOT EXISTS shared_characteristics JSONB NOT NULL DEFAULT '[]'::jsonb");
        await lock.query("ALTER TABLE wb_listing_presets ADD COLUMN IF NOT EXISTS variant_characteristics JSONB NOT NULL DEFAULT '[]'::jsonb");
        await lock.query('ALTER TABLE wb_listing_presets ADD COLUMN IF NOT EXISTS row_version INTEGER NOT NULL DEFAULT 1');
        await lock.query('ALTER TABLE wb_listing_presets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
        await lock.query(`WITH cleaned AS (
          SELECT id,
            COALESCE((
              SELECT jsonb_agg(item)
              FROM jsonb_array_elements(shared_characteristics) item
              WHERE item->>'id' NOT IN ('90630','90652','90673','89008')
            ), '[]'::jsonb) AS shared_characteristics,
            COALESCE((
              SELECT jsonb_agg(item)
              FROM jsonb_array_elements(variant_characteristics) item
              WHERE item->>'id' NOT IN ('90630','90652','90673','89008')
            ), '[]'::jsonb) AS variant_characteristics
          FROM wb_listing_presets
        )
        UPDATE wb_listing_presets preset SET
          shared_characteristics=cleaned.shared_characteristics,
          variant_characteristics=cleaned.variant_characteristics,
          row_version=preset.row_version+1,
          updated_at=NOW()
        FROM cleaned
        WHERE preset.id=cleaned.id
          AND (
            preset.shared_characteristics IS DISTINCT FROM cleaned.shared_characteristics
            OR preset.variant_characteristics IS DISTINCT FROM cleaned.variant_characteristics
          )`);
        await lock.query("INSERT INTO wb_schema_migrations(id) VALUES('023_wb_preset_purchase_characteristic_cleanup')");
        await lock.query('COMMIT');
      }
    } catch (error) {
      await lock.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtext('pixroute_wb_schema_migrations'))").catch(() => undefined);
      lock.release();
    }
  }

  private query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) { return this.requirePool().query<T>(text, values); }
  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.requirePool().connect();
    try { await client.query('BEGIN'); const value = await operation(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
  private requirePool(): Pool {
    if (!this.pool) throw new AppError('DATABASE_UNAVAILABLE', 'WB 上品预设尚未配置 PostgreSQL DATABASE_URL', undefined, 503);
    return this.pool;
  }
}

function normalizeDefinition(input: WbListingPresetDefinition): WbListingPresetDefinition {
  return {
    ...input,
    sizes: input.sizes.map((size) => ({
      ...size,
      sizeId: size.sizeId || randomUUID(),
      barcode: undefined
    } as typeof size))
  };
}

function toPreset(row: SqlRow): WbListingPresetRecord {
  return {
    id: String(row.id), rowVersion: Number(row.row_version), name: String(row.name), description: String(row.description || ''),
    isDefault: Boolean(row.is_default), autoPublishEnabled: Boolean(row.auto_publish_enabled),
    autoPublishMode: String(row.auto_publish_mode || 'CREATE_ONLY') === 'COMPATIBLE_UPSERT' ? 'COMPATIBLE_UPSERT' : 'CREATE_ONLY',
    ...(row.auto_publish_activated_at ? { autoPublishActivatedAt: new Date(row.auto_publish_activated_at).toISOString() } : {}),
    pricingTemplateId: String(row.pricing_template_id), shippingTemplateId: String(row.shipping_template_id),
    shippingServiceCode: String(row.shipping_service_code), ...(row.destination_country_code ? { destinationCountryCode: String(row.destination_country_code) } : {}),
    packaging: row.packaging, categoryKey: String(row.category_key), discountPercent: Number(row.discount_percent),
    clubDiscount: row.club_discount == null ? null : Number(row.club_discount),
    tnved: String(row.tnved), brand: String(row.brand || ''),
    titleTranslation: row.title_translation, descriptionSource: 'E003',
    sharedCharacteristics: row.shared_characteristics || [], variantCharacteristics: row.variant_characteristics || [], sizes: row.sizes || [],
    dependencySnapshot: row.dependency_snapshot, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString()
  };
}

function translateConstraintError(error: any): never {
  if (error?.code === '23505') throw new AppError('CONFIG_INVALID', 'WB 上品预设名称已存在或默认预设发生冲突', undefined, 409);
  if (error?.code === '23503') throw new AppError('CONFIG_INVALID', '预设引用的定价、运费或类目模板不存在', undefined, 409);
  throw error;
}

function validationError(issues: Array<{ path: PropertyKey[]; message: string }>): AppError {
  return new AppError('CONFIG_INVALID', issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；'), { issues });
}

function asObject(value: unknown): Record<string, any> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}; }

function parseAutomationRunId(operationRef: string): string | undefined {
  return operationRef.match(/^automation:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i)?.[1]?.toLowerCase();
}

function isReclaimableAutomationDraftRow(row: SqlRow, versionCount: number): boolean {
  if (String(row.status) !== 'DRAFT') return false;
  if (row.latest_operation_source !== 'AUTOMATION') return false;
  if (row.n8n_task_id) return false;
  if (row.generated_version_id) return false;
  if (versionCount > 0) return false;
  if (Array.isArray(row.nm_ids) && row.nm_ids.length > 0) return false;
  if (Array.isArray(row.product_urls) && row.product_urls.length > 0) return false;
  if (Array.isArray(row.media_assets) && row.media_assets.length > 0) return false;
  if (Array.isArray(row.variant_media) && row.variant_media.length > 0) return false;
  return true;
}
