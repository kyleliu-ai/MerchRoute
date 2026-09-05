import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import {
  AppError,
  WB_DEFAULT_STORE_ALIAS,
  WB_DEFAULT_STORE_ID,
  WB_PER_STORE_CONCURRENCY,
  type WbStore,
  type WbStoreCreate,
  type WbStorePreflightReport,
  type WbStorePublication,
  type WbStoreUpdate,
  type WbSystemSettings,
  type WbSystemSettingsPatch
} from '@n8n-media-review/shared';
import { wbMaterialPresetDefinitionHashFromListingData } from '../services/wb-presets/material-hash.js';
import type { WbEncryptedToken } from '../services/wb-stores/token-vault.js';
import { migrateWbAutoRetry } from './wb-auto-retry.js';

type SqlRow = Record<string, any>;
type JsonRecord = Record<string, unknown>;

export type WbStoreCredentialRecord = WbEncryptedToken & {
  id: string;
  storeId: string;
  version: number;
  status: 'PENDING' | 'ACTIVE' | 'RETIRED';
};

export type WbPreflightCurrencyDecision = {
  currency: string;
  verified: boolean;
  verification: 'VERIFIED' | 'DEFERRED_EMPTY_CATALOG' | 'INVALID';
  blocker?: string;
};

export function evaluateWbPreflightCurrency(
  configuredCurrencyInput: unknown,
  report: Pick<WbStorePreflightReport, 'accountCurrency' | 'details'>
): WbPreflightCurrencyDecision {
  const details = asObject(report.details);
  const verification = String(details.currencyVerification || '');
  const source = String(details.currencySource || '');
  const reportedCurrency = String(report.accountCurrency || '').toUpperCase();
  const configuredCurrency = String(configuredCurrencyInput || '').toUpperCase();
  if (details.currencyVerified === true && verification === 'VERIFIED' && source === 'WB_PRICE_LIST') {
    return reportedCurrency === 'CNY'
      ? { currency: reportedCurrency, verified: true, verification: 'VERIFIED' }
      : { currency: reportedCurrency, verified: true, verification: 'VERIFIED', blocker: 'WB 平台账户币种不是 CNY' };
  }
  if (details.currencyVerified === false && verification === 'DEFERRED_EMPTY_CATALOG' && source === 'STORE_CONFIG') {
    return configuredCurrency === 'CNY' && reportedCurrency === 'CNY'
      ? { currency: configuredCurrency, verified: false, verification: 'DEFERRED_EMPTY_CATALOG' }
      : {
          currency: configuredCurrency,
          verified: false,
          verification: 'DEFERRED_EMPTY_CATALOG',
          blocker: '空目录延期验证只允许配置为 CNY'
        };
  }
  return {
    currency: configuredCurrency,
    verified: false,
    verification: 'INVALID',
    blocker: '未从 WB 价格接口验证币种，且不满足空目录延期验证合同'
  };
}

export type WbPublicationPlanningContext = {
  sku: string;
  productName: string;
  draftVersion: number;
  baseGeneratedVersionId?: string;
  listingStatus: string;
  sourceMediaState: 'AVAILABLE' | 'CLEANUP_PENDING' | 'CLEANED';
  listingData: JsonRecord;
  mediaAssets: unknown[];
  variantMedia: unknown[];
  stores: Array<WbStore & { presetSnapshot?: JsonRecord }>;
};

export type WbPublicationInsert = {
  id: string;
  sku: string;
  generatedVersionId: string;
  revision: number;
  storeId: string;
  storeAlias: string;
  presetId?: string;
  presetSnapshot?: JsonRecord;
  presetDefinitionHash: string;
  credentialVersionId?: string;
  taskId: string;
  configSnapshot: JsonRecord;
  source: 'MANUAL' | 'AUTOMATION';
};

export type WbMaterializedPublicationInsert = {
  id: string;
  sku: string;
  draftVersion: number;
  storeId: string;
  storeAlias: string;
  presetId: string;
  presetRowVersion: number;
  presetSnapshot: JsonRecord;
  presetDefinitionHash: string;
  credentialVersionId?: string;
  configSnapshot: JsonRecord;
  planHash: string;
  materializationHash: string;
  categoryVersionId: string;
  draftData: JsonRecord;
  mediaAssets: unknown[];
  variantMedia: unknown[];
  productJsonFactory: (identity: { versionId: string; revision: number }) => {
    productJson: JsonRecord;
    generationWarnings?: unknown[];
  };
};

export type WbAutomationMaterializedPublicationInsert = {
  sku: string;
  sourceGeneratedVersionId: string;
  storeId: string;
  storeAlias: string;
  storeRowVersion: number;
  storeConfigVersion: number;
  warehouseId: string;
  credentialVersionId?: string;
  presetId: string;
  presetSnapshot?: JsonRecord;
  presetDefinitionHash: string;
  automationRunId: string;
  automationRunNo: number;
  operationMode: 'CREATE_ONLY' | 'COMPATIBLE_UPSERT';
  mediaTargetVendorCodes: string[];
  existingCardBaseline?: JsonRecord[];
};

export type WbGatewayIdentity = {
  storeId: string;
  storeAlias: string;
  taskId?: string;
  publicationId?: string;
  warehouseId: string;
  configVersion: number;
  rootDirectory: string;
  workRelpath?: string;
  productCode?: string;
  runtimeResult?: JsonRecord;
  storeEnabled: boolean;
  leaseActive: boolean;
  credential: WbStoreCredentialRecord;
};

export class WbStoreRepository {
  private pool?: Pool;

  constructor(private readonly connectionString?: string) {}
  get configured(): boolean { return Boolean(this.pool); }

  async initialize(): Promise<void> {
    if (!this.connectionString) return;
    this.pool = new Pool({ connectionString: this.connectionString, max: 4, idleTimeoutMillis: 30_000 });
    try {
      await this.pool.query('SELECT 1');
      await migrateWbMultiStoreSchema(this.pool);
    } catch (error) {
      await this.pool.end().catch(() => undefined);
      this.pool = undefined;
      throw error;
    }
  }

  async close(): Promise<void> { await this.pool?.end(); }

  async getSettings(): Promise<WbSystemSettings> {
    const result = await this.query<SqlRow>("SELECT * FROM wb_system_settings WHERE settings_id='default'");
    if (!result.rows[0]) throw new AppError('DATABASE_UNAVAILABLE', 'WB 多店铺全局设置尚未初始化', undefined, 503);
    return toSettings(result.rows[0]);
  }

  async updateSettings(input: WbSystemSettingsPatch): Promise<WbSystemSettings> {
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>("SELECT * FROM wb_system_settings WHERE settings_id='default' FOR UPDATE");
      const row = current.rows[0];
      if (!row) throw new AppError('DATABASE_UNAVAILABLE', 'WB 多店铺全局设置尚未初始化', undefined, 503);
      assertRowVersion(input.rowVersion, row.row_version, 'WB 全局设置');
      const enabled = input.enabled ?? Boolean(row.enabled);
      const rootDirectory = input.rootDirectory ?? String(row.root_directory || '');
      const timezone = input.timezone ?? String(row.timezone || 'Asia/Shanghai');
      const globalConcurrency = input.globalConcurrency ?? Number(row.global_concurrency || 1);
      const changed = await client.query<SqlRow>(`UPDATE wb_system_settings SET
        enabled=$1,root_directory=$2,timezone=$3,global_concurrency=$4,row_version=row_version+1,updated_at=NOW()
        WHERE settings_id='default' RETURNING *`, [enabled, rootDirectory, timezone, globalConcurrency]);
      await client.query(`UPDATE wb_runtime_config SET publish_enabled=$1,import_root=$2,timezone=$3,
        dispatch_concurrency=$4,config_version=config_version+1,updated_at=NOW() WHERE config_id='default'`, [
        enabled, rootDirectory, timezone, globalConcurrency
      ]);
      if (enabled && !row.enabled) {
        await client.query(`UPDATE wb_stores SET auto_publish_activated_at=NOW(),row_version=row_version+1,updated_at=NOW()
          WHERE enabled=true AND auto_publish_enabled=true AND archived_at IS NULL`);
      }
      return toSettings(changed.rows[0]!);
    });
  }

  async listStores(includeArchived = false): Promise<WbStore[]> {
    const result = await this.query<SqlRow>(`${storeSelect()} ${includeArchived ? '' : 'WHERE s.archived_at IS NULL'}
      ORDER BY CASE WHEN s.store_alias=$1 THEN 0 ELSE 1 END,s.display_name,s.store_alias`, [WB_DEFAULT_STORE_ALIAS]);
    return result.rows.map(toStore);
  }

  async getStore(storeIdOrAlias: string, includeArchived = false): Promise<WbStore> {
    const result = await this.query<SqlRow>(`${storeSelect()} WHERE (s.id::text=$1 OR s.store_alias=$1)
      ${includeArchived ? '' : 'AND s.archived_at IS NULL'} LIMIT 1`, [storeIdOrAlias]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'WB 店铺不存在', { storeIdOrAlias }, 404);
    return toStore(result.rows[0]);
  }

  async createStore(input: WbStoreCreate): Promise<WbStore> {
    const id = randomUUID();
    try {
      await this.query(`INSERT INTO wb_stores(
        id,store_alias,display_name,auto_publish_enabled,auto_publish_activated_at,auto_publish_mode,default_preset_id,
        warehouse_id,warehouse_name,account_currency,max_daily_styles,credential_state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'MISSING')`, [
        id, input.storeAlias, input.displayName, input.autoPublishEnabled, input.autoPublishEnabled ? new Date().toISOString() : null, input.autoPublishMode,
        input.defaultPresetId || null, input.warehouseId, input.warehouseName, input.accountCurrency, input.maxDailyStyles
      ]);
      await this.query('INSERT INTO wb_store_runtime_state(store_id) VALUES($1) ON CONFLICT(store_id) DO NOTHING', [id]);
      return this.getStore(id);
    } catch (error: any) {
      if (error?.code === '23505') throw new AppError('CONFIG_INVALID', 'WB 店铺别名已存在', { storeAlias: input.storeAlias }, 409);
      throw error;
    }
  }

  async updateStore(storeId: string, input: WbStoreUpdate): Promise<WbStore> {
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>('SELECT * FROM wb_stores WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [storeId]);
      const row = current.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'WB 店铺不存在', { storeId }, 404);
      assertRowVersion(input.rowVersion, row.row_version, 'WB 店铺设置');
      const autoPublishEnabled = input.autoPublishEnabled ?? Boolean(row.auto_publish_enabled);
      const defaultPresetId = input.defaultPresetId === undefined ? row.default_preset_id : input.defaultPresetId;
      const resetAutoActivation = autoPublishEnabled && (
        !row.auto_publish_enabled
        || row.default_preset_id !== defaultPresetId
        || !row.auto_publish_activated_at
      );
      const autoPublishActivatedAt = autoPublishEnabled
        ? (resetAutoActivation ? new Date().toISOString() : row.auto_publish_activated_at)
        : null;
      await client.query(`UPDATE wb_stores SET
        display_name=$2,auto_publish_enabled=$3,auto_publish_activated_at=$4,auto_publish_mode=$5,default_preset_id=$6,
        warehouse_id=$7,warehouse_name=$8,account_currency=$9,max_daily_styles=$10,
        preflight_status=CASE WHEN
          default_preset_id IS DISTINCT FROM $6 OR warehouse_id IS DISTINCT FROM $7 OR account_currency IS DISTINCT FROM $9
          THEN 'STALE' ELSE preflight_status END,
        config_version=config_version+1,row_version=row_version+1,updated_at=NOW()
        WHERE id=$1`, [
        storeId,
        input.displayName ?? row.display_name,
        autoPublishEnabled,
        autoPublishActivatedAt,
        input.autoPublishMode ?? row.auto_publish_mode,
        defaultPresetId,
        input.warehouseId ?? row.warehouse_id,
        input.warehouseName ?? row.warehouse_name,
        input.accountCurrency ?? row.account_currency,
        input.maxDailyStyles ?? row.max_daily_styles
      ]);
      return getStoreWith(client, storeId);
    });
  }

  async savePendingCredential(storeId: string, expectedRowVersion: number, encrypted: WbEncryptedToken): Promise<WbStore> {
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>('SELECT * FROM wb_stores WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [storeId]);
      const store = current.rows[0];
      if (!store) throw new AppError('NOT_FOUND', 'WB 店铺不存在', { storeId }, 404);
      assertRowVersion(expectedRowVersion, store.row_version, 'WB 店铺设置');
      const next = await client.query<{ version: number }>('SELECT COALESCE(MAX(version_no),0)+1 version FROM wb_store_credential_versions WHERE store_id=$1', [storeId]);
      const credentialId = randomUUID();
      await client.query("UPDATE wb_store_credential_versions SET status='RETIRED',retired_at=NOW() WHERE store_id=$1 AND status='PENDING'", [storeId]);
      await client.query(`INSERT INTO wb_store_credential_versions(
        id,store_id,version_no,status,ciphertext,nonce,auth_tag,fingerprint,key_version)
        VALUES($1,$2,$3,'PENDING',$4,$5,$6,$7,$8)`, [
        credentialId, storeId, Number(next.rows[0]?.version || 1), encrypted.ciphertext,
        encrypted.nonce, encrypted.authTag, encrypted.fingerprint, encrypted.keyVersion
      ]);
      await client.query(`UPDATE wb_stores SET credential_state='PENDING',preflight_status='STALE',
        preflight_error_code='',preflight_error_message='',config_version=config_version+1,
        row_version=row_version+1,updated_at=NOW() WHERE id=$1`, [storeId]);
      return getStoreWith(client, storeId);
    });
  }

  async beginPreflight(storeId: string): Promise<{
    store: WbStore;
    storeConfigVersion: number;
    credentialVersionId: string;
  }> {
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>('SELECT * FROM wb_stores WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [storeId]);
      const row = current.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'WB 店铺不存在', { storeId }, 404);
      const credential = await client.query<SqlRow>(`SELECT * FROM wb_store_credential_versions
        WHERE store_id=$1 AND status IN ('PENDING','ACTIVE') ORDER BY CASE status WHEN 'PENDING' THEN 0 ELSE 1 END,version_no DESC LIMIT 1`, [storeId]);
      if (!credential.rows[0]) {
        throw new AppError('WB_CREDENTIAL_REQUIRED', '请先在 WB上品设置中录入店铺 Token', { storeId }, 409);
      }
      await client.query("UPDATE wb_stores SET preflight_status='PENDING',preflight_error_code='',preflight_error_message='',updated_at=NOW() WHERE id=$1", [storeId]);
      const store = await getStoreWith(client, storeId);
      return {
        store,
        storeConfigVersion: Number(row.config_version),
        credentialVersionId: String(credential.rows[0].id)
      };
    });
  }

  async applyPreflightReport(
    storeId: string,
    storeConfigVersion: number,
    credentialVersionId: string,
    report: WbStorePreflightReport
  ): Promise<WbStore> {
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>('SELECT * FROM wb_stores WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [storeId]);
      const store = current.rows[0];
      if (!store) throw new AppError('NOT_FOUND', 'WB 店铺不存在', { storeId }, 404);
      if (Number(store.config_version) !== storeConfigVersion) {
        throw new AppError('VERSION_CONFLICT', '店铺配置已变化，拒绝写入过期预检结果', {
          expected: storeConfigVersion, actual: Number(store.config_version)
        }, 409);
      }
      const credentialResult = await client.query<SqlRow>('SELECT * FROM wb_store_credential_versions WHERE id=$1 AND store_id=$2 FOR UPDATE', [credentialVersionId, storeId]);
      const credential = credentialResult.rows[0];
      if (!credential || !['PENDING', 'ACTIVE'].includes(String(credential.status))) {
        throw new AppError('VERSION_CONFLICT', '预检凭据版本已失效', { storeId, credentialVersionId }, 409);
      }
      const permissionSet = new Set(report.permissions.map((permission) => permission.trim().toLowerCase()));
      const requiredPermissions = ['content', 'prices', 'marketplace'];
      const missingPermissions = requiredPermissions.filter((permission) => ![...permissionSet].some((value) => value.includes(permission)));
      const warehouseId = String(store.warehouse_id || report.warehouses[0]?.id || '');
      const selectedWarehouse = report.warehouses.find((warehouse) => warehouse.id === warehouseId);
      const currencyDecision = evaluateWbPreflightCurrency(store.account_currency, report);
      const currency = currencyDecision.currency;
      const blockers = [
        ...(!report.ok ? [report.errorMessage || 'WB 预检未通过'] : []),
        ...(!report.sellerId ? ['未取得 Seller 身份'] : []),
        ...missingPermissions.map((permission) => `缺少 ${permission} 权限`),
        ...(!warehouseId || !selectedWarehouse ? ['所选仓库不可用'] : []),
        ...(currencyDecision.blocker ? [currencyDecision.blocker] : [])
      ];
      const passed = blockers.length === 0;
      const active = await client.query<SqlRow>("SELECT id FROM wb_store_credential_versions WHERE store_id=$1 AND status='ACTIVE' FOR UPDATE", [storeId]);
      if (passed) {
        if (String(credential.status) !== 'ACTIVE') {
          await client.query("UPDATE wb_store_credential_versions SET status='RETIRED',retired_at=NOW() WHERE store_id=$1 AND status='ACTIVE'", [storeId]);
          await client.query("UPDATE wb_store_credential_versions SET status='ACTIVE',activated_at=NOW(),retired_at=NULL WHERE id=$1", [credentialVersionId]);
        }
        await client.query(`UPDATE wb_store_credential_versions SET validation_report=$2::jsonb,
          validation_error_code='',validation_error_message='',validated_at=$3 WHERE id=$1`, [
          credentialVersionId, JSON.stringify(report), report.checkedAt || new Date().toISOString()
        ]);
        await client.query(`UPDATE wb_stores SET
          active_credential_version_id=$2,credential_state='ACTIVE',seller_id=$3,seller_name=$4,permissions=$5::jsonb,
          warehouse_id=$6,warehouse_name=$7,account_currency=$8,preflight_status='PASSED',preflight_checked_at=$9,
          preflight_report=$10::jsonb,preflight_error_code='',preflight_error_message='',row_version=row_version+1,updated_at=NOW()
          WHERE id=$1`, [
          storeId, credentialVersionId, report.sellerId, report.sellerName || '', JSON.stringify(report.permissions),
          warehouseId, selectedWarehouse?.name || store.warehouse_name || '', currency,
          report.checkedAt || new Date().toISOString(), JSON.stringify(report)
        ]);
      } else if (active.rows[0] && String(credential.status) === 'PENDING') {
        await client.query(`UPDATE wb_store_credential_versions SET status='RETIRED',retired_at=NOW(),validation_report=$2::jsonb,
          validation_error_code=$3,validation_error_message=$4,validated_at=$5 WHERE id=$1`, [
          credentialVersionId, JSON.stringify(report), report.errorCode || 'WB_PREFLIGHT_FAILED', blockers.join('；'),
          report.checkedAt || new Date().toISOString()
        ]);
        await client.query(`UPDATE wb_stores SET credential_state='ACTIVE',preflight_status='PASSED',
          preflight_error_code='',preflight_error_message='',row_version=row_version+1,updated_at=NOW() WHERE id=$1`, [
          storeId
        ]);
      } else {
        await client.query(`UPDATE wb_store_credential_versions SET validation_report=$2::jsonb,
          validation_error_code=$3,validation_error_message=$4,validated_at=$5 WHERE id=$1`, [
          credentialVersionId, JSON.stringify(report), report.errorCode || 'WB_PREFLIGHT_FAILED', blockers.join('；'),
          report.checkedAt || new Date().toISOString()
        ]);
        await client.query(`UPDATE wb_stores SET preflight_status='FAILED',preflight_checked_at=$2,
          preflight_report=$3::jsonb,preflight_error_code=$4,preflight_error_message=$5,
          row_version=row_version+1,updated_at=NOW() WHERE id=$1`, [
          storeId, report.checkedAt || new Date().toISOString(), JSON.stringify(report),
          report.errorCode || 'WB_PREFLIGHT_FAILED', blockers.join('；')
        ]);
      }
      try { return await getStoreWith(client, storeId); }
      catch (error: any) {
        if (error?.code === '23505') throw new AppError('CONFIG_INVALID', '该 WB Seller 已绑定到另一个有效店铺', { sellerId: report.sellerId }, 409);
        throw error;
      }
    }).catch((error: any) => {
      if (error?.code === '23505') throw new AppError('CONFIG_INVALID', '该 WB Seller 已绑定到另一个有效店铺', { sellerId: report.sellerId }, 409);
      throw error;
    });
  }

  async setStoreEnabled(storeId: string, enabled: boolean, expectedRowVersion: number): Promise<WbStore> {
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>('SELECT * FROM wb_stores WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [storeId]);
      const row = current.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'WB 店铺不存在', { storeId }, 404);
      assertRowVersion(expectedRowVersion, row.row_version, 'WB 店铺设置');
      if (enabled) {
        const projected = await getStoreWith(client, storeId);
        const blockers = projected.readiness.blockers.filter((blocker) => blocker !== '店铺未启用');
        if (blockers.length) throw new AppError('WB_STORE_NOT_READY', '店铺尚未满足启用条件', { blockers }, 409);
      }
      const resetAutoActivation = enabled && !row.enabled && row.auto_publish_enabled;
      await client.query(`UPDATE wb_stores SET enabled=$2,
        auto_publish_activated_at=CASE WHEN $3 THEN NOW() ELSE auto_publish_activated_at END,
        row_version=row_version+1,updated_at=NOW() WHERE id=$1`, [storeId, enabled, resetAutoActivation]);
      if (!enabled) {
        const autoTable = await client.query<{ available: boolean }>("SELECT to_regclass('wb_auto_publish_jobs') IS NOT NULL available");
        if (autoTable.rows[0]?.available) {
          await client.query(`UPDATE wb_auto_publish_jobs SET state='PAUSED',next_attempt_at=NULL,
            last_error_code='WB_STORE_DISABLED',last_error_message='店铺已停用；未领取的自动上品任务已暂停',updated_at=NOW()
            WHERE store_id=$1 AND state NOT IN ('QUEUED','RUNNING','SUCCEEDED','BLOCKED_EXISTING_CARD','CANCELLED')
              AND (worker_id IS NULL OR BTRIM(worker_id)='' OR lease_until IS NULL OR lease_until<=NOW())`, [storeId]);
        }
      }
      return getStoreWith(client, storeId);
    });
  }

  async archiveStore(storeId: string, expectedRowVersion: number): Promise<WbStore> {
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>('SELECT * FROM wb_stores WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [storeId]);
      const row = current.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'WB 店铺不存在', { storeId }, 404);
      assertRowVersion(expectedRowVersion, row.row_version, 'WB 店铺设置');
      if (row.store_alias === WB_DEFAULT_STORE_ALIAS) throw new AppError('CONFIG_INVALID', '默认兼容店铺不能归档', undefined, 409);
      if (row.enabled) throw new AppError('TASK_LOCKED', '请先停用店铺再归档', { storeId }, 409);
      const active = await client.query<{ total: string }>(`SELECT COUNT(*)::text total FROM wb_publish_jobs
        WHERE store_id=$1 AND state NOT IN ('SUCCEEDED','FAILED','BLOCKED_AUTH','BLOCKED_CONFIG','BLOCKED_SCHEMA','BLOCKED_COMPLIANCE','BLOCKED_EXISTING_CARD')`, [storeId]);
      const publications = await client.query<{ total: string }>(`SELECT COUNT(*)::text total FROM wb_store_publications
        WHERE store_id=$1 AND status NOT IN ('SUCCEEDED','FAILED','NEEDS_ATTENTION','PAUSED')`, [storeId]);
      if (Number(active.rows[0]?.total || 0) || Number(publications.rows[0]?.total || 0)) {
        throw new AppError('TASK_LOCKED', '店铺仍有非终态任务，不能归档', { storeId }, 409);
      }
      await client.query('UPDATE wb_stores SET archived_at=NOW(),auto_publish_enabled=false,row_version=row_version+1,updated_at=NOW() WHERE id=$1', [storeId]);
      return getStoreWith(client, storeId, true);
    });
  }

  async getPlanningContext(sku: string, draftVersion: number, storeIds: string[]): Promise<WbPublicationPlanningContext> {
    const listing = await this.query<SqlRow>(`SELECT d.sku,p.product_name,d.draft_version,d.generated_version_id,
      d.status listing_status,d.source_media_state,d.data,d.media_assets,d.variant_media
      FROM wb_listing_drafts d JOIN products p ON p.sku=d.sku WHERE d.sku=$1`, [sku]);
    const row = listing.rows[0];
    if (!row) throw new AppError('NOT_FOUND', 'WB 上品草稿不存在', { sku }, 404);
    if (Number(row.draft_version) !== draftVersion) throw new AppError('VERSION_CONFLICT', '草稿版本已变化，请刷新后重试', { expected: draftVersion, actual: Number(row.draft_version) }, 409);
    if (!['DRAFT', 'STALE', 'GENERATED', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'NEEDS_ATTENTION'].includes(String(row.listing_status))) {
      throw new AppError('TASK_LOCKED', '当前草稿状态不能创建多店铺发布计划', { sku, status: row.listing_status }, 409);
    }
    const stores: WbStore[] = [];
    for (const storeId of storeIds) stores.push(await this.getStore(storeId));
    return {
      sku: String(row.sku), productName: String(row.product_name || ''), draftVersion: Number(row.draft_version),
      ...(row.generated_version_id ? { baseGeneratedVersionId: String(row.generated_version_id) } : {}),
      listingStatus: String(row.listing_status),
      sourceMediaState: row.source_media_state === 'CLEANED' ? 'CLEANED'
        : row.source_media_state === 'CLEANUP_PENDING' ? 'CLEANUP_PENDING' : 'AVAILABLE',
      listingData: asObject(row.data),
      mediaAssets: Array.isArray(row.media_assets) ? row.media_assets : [],
      variantMedia: Array.isArray(row.variant_media) ? row.variant_media : [],
      stores
    };
  }

  async createMaterializedPublication(input: WbMaterializedPublicationInsert): Promise<WbStorePublication> {
    return this.transaction(async (client) => {
      const existing = await client.query<SqlRow>('SELECT * FROM wb_store_publications WHERE request_key=$1', [`${input.planHash}:${input.storeId}`]);
      if (existing.rows[0]) return toPublication(existing.rows[0]);
      const draft = await client.query<SqlRow>('SELECT * FROM wb_listing_drafts WHERE sku=$1 FOR UPDATE', [input.sku]);
      if (!draft.rows[0]) throw new AppError('NOT_FOUND', 'WB 上品草稿不存在', { sku: input.sku }, 404);
      assertRowVersion(input.draftVersion, draft.rows[0].draft_version, 'WB 公共素材草稿');
      if (stableJson(draft.rows[0].data) !== stableJson(input.draftData)
        || stableJson(draft.rows[0].media_assets || []) !== stableJson(input.mediaAssets)
        || stableJson(draft.rows[0].variant_media || []) !== stableJson(input.variantMedia)) {
        throw new AppError('VERSION_CONFLICT', 'WB 公共素材或媒体顺序已变化，请重新确认发布计划', { sku: input.sku }, 409);
      }
      const duplicate = await client.query<SqlRow>('SELECT * FROM wb_store_publications WHERE request_key=$1', [`${input.planHash}:${input.storeId}`]);
      if (duplicate.rows[0]) return toPublication(duplicate.rows[0]);
      const store = await client.query<SqlRow>('SELECT * FROM wb_stores WHERE id=$1 AND archived_at IS NULL FOR SHARE', [input.storeId]);
      const storeRow = store.rows[0];
      if (!storeRow || String(storeRow.default_preset_id || '') !== input.presetId
        || Number(storeRow.row_version) !== Number(input.configSnapshot.storeRowVersion)
        || Number(storeRow.config_version) !== Number(input.configSnapshot.storeConfigVersion)
        || String(storeRow.active_credential_version_id || '') !== String(input.credentialVersionId || '')) {
        throw new AppError('VERSION_CONFLICT', 'WB 店铺配置、凭据或默认预设已变化，请重新确认发布计划', { storeId: input.storeId }, 409);
      }
      const settings = await client.query<SqlRow>("SELECT * FROM wb_system_settings WHERE settings_id='default' FOR SHARE");
      if (!settings.rows[0]
        || Number(settings.rows[0].row_version) !== Number(input.configSnapshot.settingsRowVersion)
        || String(settings.rows[0].root_directory || '') !== String(input.configSnapshot.rootDirectory || '')) {
        throw new AppError('VERSION_CONFLICT', 'WB 全局目录配置已变化，请重新确认发布计划', undefined, 409);
      }
      const preset = await client.query<SqlRow>('SELECT row_version FROM wb_listing_presets WHERE id=$1 FOR SHARE', [input.presetId]);
      if (Number(preset.rows[0]?.row_version) !== input.presetRowVersion) {
        throw new AppError('VERSION_CONFLICT', 'WB 店铺默认预设已变化，请重新确认发布计划', { presetId: input.presetId }, 409);
      }
      const revision = Number((await client.query<{ revision: number }>(
        'SELECT COALESCE(MAX(revision),0)+1 revision FROM wb_listing_versions WHERE sku=$1', [input.sku]
      )).rows[0]!.revision);
      const versionId = randomUUID();
      const built = input.productJsonFactory({ versionId, revision });
      const mediaManifest = {
        assets: input.mediaAssets,
        variantMedia: input.variantMedia,
        ...(built.generationWarnings?.length ? { generationWarnings: built.generationWarnings } : {})
      };
      await client.query(`INSERT INTO wb_listing_versions(
        id,sku,revision,status,category_version_id,product_json,media_manifest,material_preset_definition_hash,
        generation_scope,materialization_hash,generated_at)
        VALUES($1,$2,$3,'GENERATED',$4,$5::jsonb,$6::jsonb,$7,'STORE_PUBLICATION',$8,NOW())`, [
        versionId, input.sku, revision, input.categoryVersionId, JSON.stringify(built.productJson),
        JSON.stringify(mediaManifest), input.presetDefinitionHash, input.materializationHash
      ]);
      const taskId = `${input.storeAlias}__${input.sku}__r${revision}`;
      const inserted = await client.query<SqlRow>(`INSERT INTO wb_store_publications(
        id,sku,generated_version_id,revision,store_id,store_alias_snapshot,status,source,preset_id,preset_snapshot,
        preset_definition_hash,credential_version_id,task_id,config_snapshot,request_key,plan_hash,materialization_hash)
        VALUES($1,$2,$3,$4,$5,$6,'PLANNED','MANUAL',$7,$8::jsonb,$9,$10,$11,$12::jsonb,$13,$14,$15)
        RETURNING *`, [
        input.id, input.sku, versionId, revision, input.storeId, input.storeAlias, input.presetId,
        JSON.stringify(input.presetSnapshot), input.presetDefinitionHash, input.credentialVersionId || null, taskId,
        JSON.stringify(input.configSnapshot), `${input.planHash}:${input.storeId}`, input.planHash, input.materializationHash
      ]);
      return toPublication(inserted.rows[0]!);
    });
  }

  async createAutomationMaterializedPublication(
    input: WbAutomationMaterializedPublicationInsert
  ): Promise<WbStorePublication> {
    const normalized = normalizeAutomationMaterializationInput(input);
    const requestKey = `automation:${normalized.automationRunId}:${normalized.storeId}`;
    return this.transaction(async (client) => {
      const existing = await client.query<SqlRow>(
        'SELECT * FROM wb_store_publications WHERE request_key=$1 FOR UPDATE',
        [requestKey]
      );
      if (existing.rows[0]) {
        assertAutomationPublicationIdentity(existing.rows[0], normalized, requestKey);
        return toPublication(existing.rows[0]);
      }

      // The public LISTING version and draft are locked together so revision
      // allocation, source validation, and the store-scoped copy are one
      // atomic snapshot. The draft pointer itself is deliberately never
      // updated: it remains the reusable public material workspace.
      const source = await client.query<SqlRow>(`SELECT
        v.*,d.generated_version_id current_version_id,d.status draft_status,d.data draft_data
        FROM wb_listing_versions v JOIN wb_listing_drafts d ON d.sku=v.sku
        WHERE v.id=$1 AND v.sku=$2 FOR UPDATE OF v,d`, [
        normalized.sourceGeneratedVersionId,
        normalized.sku
      ]);
      const sourceRow = source.rows[0];
      if (!sourceRow) {
        throw new AppError('NOT_FOUND', 'WB 自动上品源版本不存在或不属于该 SKU', {
          sku: normalized.sku,
          generatedVersionId: normalized.sourceGeneratedVersionId
        }, 404);
      }

      // A concurrent retry waits on the same draft lock. Re-read the request
      // key after acquiring it so only one version/revision can be created.
      const duplicate = await client.query<SqlRow>(
        'SELECT * FROM wb_store_publications WHERE request_key=$1',
        [requestKey]
      );
      if (duplicate.rows[0]) {
        assertAutomationPublicationIdentity(duplicate.rows[0], normalized, requestKey);
        return toPublication(duplicate.rows[0]);
      }

      if (String(sourceRow.generation_scope || 'LISTING') !== 'LISTING'
        || String(sourceRow.status || '') !== 'GENERATED'
        || String(sourceRow.current_version_id || '') !== normalized.sourceGeneratedVersionId
        || String(sourceRow.draft_status || '') !== 'GENERATED') {
        throw new AppError('VERSION_CONFLICT', 'WB 自动上品源版本已过期或不是公共 LISTING 版本', {
          sku: normalized.sku,
          generatedVersionId: normalized.sourceGeneratedVersionId,
          generationScope: sourceRow.generation_scope,
          versionStatus: sourceRow.status,
          currentVersionId: sourceRow.current_version_id,
          draftStatus: sourceRow.draft_status
        }, 409);
      }
      const sourcePresetDefinitionHash = await resolveGeneratedVersionMaterialHashWithClient(
        client,
        normalized.sourceGeneratedVersionId,
        sourceRow.material_preset_definition_hash,
        sourceRow.draft_data
      );
      if (sourcePresetDefinitionHash !== normalized.presetDefinitionHash) {
        throw new AppError('PRESET_VERSION_MISMATCH', 'WB 自动上品源版本与店铺冻结预设不一致', {
          generatedVersionId: normalized.sourceGeneratedVersionId,
          expectedDefinitionHash: sourcePresetDefinitionHash,
          actualDefinitionHash: normalized.presetDefinitionHash
        }, 409);
      }

      const storeResult = await client.query<SqlRow>(
        'SELECT * FROM wb_stores WHERE id=$1 AND archived_at IS NULL FOR SHARE',
        [normalized.storeId]
      );
      const store = storeResult.rows[0];
      if (!store) throw new AppError('NOT_FOUND', 'WB 自动上品店铺不存在或已归档', { storeId: normalized.storeId }, 404);
      const storeChanged = String(store.store_alias || '') !== normalized.storeAlias
        || Number(store.row_version) !== normalized.storeRowVersion
        || Number(store.config_version) !== normalized.storeConfigVersion
        || String(store.warehouse_id || '') !== normalized.warehouseId
        || String(store.default_preset_id || '') !== normalized.presetId
        || String(store.active_credential_version_id || '') !== String(normalized.credentialVersionId || '')
        || String(store.auto_publish_mode || '') !== normalized.operationMode
        || store.enabled !== true
        || store.auto_publish_enabled !== true;
      if (storeChanged) {
        throw new AppError('VERSION_CONFLICT', 'WB 店铺配置、凭据或默认预设在自动物化前发生变化', {
          storeId: normalized.storeId,
          automationRunId: normalized.automationRunId
        }, 409);
      }

      const settingsResult = await client.query<SqlRow>(
        "SELECT * FROM wb_system_settings WHERE settings_id='default' FOR SHARE"
      );
      const settings = settingsResult.rows[0];
      if (!settings || settings.enabled !== true || !String(settings.root_directory || '').trim()) {
        throw new AppError('VERSION_CONFLICT', 'WB 全局上品设置在自动物化时不可用', undefined, 409);
      }

      const revision = Number((await client.query<{ revision: number }>(
        'SELECT COALESCE(MAX(revision),0)+1 revision FROM wb_listing_versions WHERE sku=$1',
        [normalized.sku]
      )).rows[0]!.revision);
      const versionId = randomUUID();
      const publicationId = randomUUID();
      const productJson: JsonRecord = {
        ...asObject(sourceRow.product_json),
        productCode: normalized.sku,
        revision
      };
      if (!Array.isArray(productJson.variants) || !productJson.variants.length) {
        throw new AppError('VERIFY_FAILED', 'WB 自动上品源版本缺少可物化的商品变体', {
          generatedVersionId: normalized.sourceGeneratedVersionId
        }, 409);
      }
      const mediaManifest = asObject(sourceRow.media_manifest);
      const purchaseMeasurements = asObject(sourceRow.purchase_measurements);
      const configSnapshot = {
        schemaVersion: 1,
        sourceGeneratedVersionId: normalized.sourceGeneratedVersionId,
        sourceRevision: Number(sourceRow.revision),
        automationRunId: normalized.automationRunId,
        automationRunNo: normalized.automationRunNo,
        operationMode: normalized.operationMode,
        mediaTargetVendorCodes: normalized.mediaTargetVendorCodes,
        existingCardBaseline: normalized.existingCardBaseline,
        storeRowVersion: normalized.storeRowVersion,
        storeConfigVersion: normalized.storeConfigVersion,
        settingsRowVersion: Number(settings.row_version),
        rootDirectory: String(settings.root_directory),
        warehouseId: normalized.warehouseId,
        credentialVersionId: normalized.credentialVersionId || null,
        presetId: normalized.presetId,
        presetDefinitionHash: normalized.presetDefinitionHash
      };
      const frozenMaterial = {
        schemaVersion: 1,
        sku: normalized.sku,
        source: {
          generatedVersionId: normalized.sourceGeneratedVersionId,
          revision: Number(sourceRow.revision),
          categoryVersionId: String(sourceRow.category_version_id),
          productJson,
          mediaManifest,
          purchaseMeasurements,
          presetDefinitionHash: sourcePresetDefinitionHash
        },
        automation: {
          runId: normalized.automationRunId,
          runNo: normalized.automationRunNo,
          operationMode: normalized.operationMode,
          mediaTargetVendorCodes: normalized.mediaTargetVendorCodes,
          existingCardBaseline: normalized.existingCardBaseline
        },
        store: {
          id: normalized.storeId,
          alias: normalized.storeAlias,
          rowVersion: normalized.storeRowVersion,
          configVersion: normalized.storeConfigVersion,
          credentialVersionId: normalized.credentialVersionId || null,
          warehouseId: normalized.warehouseId,
          defaultPresetId: normalized.presetId
        },
        settings: {
          rowVersion: Number(settings.row_version),
          rootDirectory: String(settings.root_directory),
          timezone: String(settings.timezone || ''),
          globalConcurrency: Number(settings.global_concurrency || 0),
          perStoreConcurrency: Number(settings.per_store_concurrency || 0),
          enabled: Boolean(settings.enabled)
        }
      };
      const materializationHash = `sha256:${createHash('sha256').update(stableJson(frozenMaterial)).digest('hex')}`;

      await client.query(`INSERT INTO wb_listing_versions(
        id,sku,revision,status,category_version_id,product_json,media_manifest,purchase_measurements,
        material_preset_definition_hash,generation_scope,materialization_hash,generated_at)
        VALUES($1,$2,$3,'GENERATED',$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,'STORE_PUBLICATION',$9,NOW())`, [
        versionId,
        normalized.sku,
        revision,
        sourceRow.category_version_id,
        JSON.stringify(productJson),
        JSON.stringify(mediaManifest),
        JSON.stringify(purchaseMeasurements),
        normalized.presetDefinitionHash,
        materializationHash
      ]);
      const taskId = `${normalized.storeAlias}__${normalized.sku}__r${revision}`;
      const inserted = await client.query<SqlRow>(`INSERT INTO wb_store_publications(
        id,sku,generated_version_id,revision,store_id,store_alias_snapshot,status,source,preset_id,preset_snapshot,
        preset_definition_hash,credential_version_id,task_id,config_snapshot,request_key,materialization_hash)
        VALUES($1,$2,$3,$4,$5,$6,'PLANNED','AUTOMATION',$7,$8::jsonb,$9,$10,$11,$12::jsonb,$13,$14)
        RETURNING *`, [
        publicationId,
        normalized.sku,
        versionId,
        revision,
        normalized.storeId,
        normalized.storeAlias,
        normalized.presetId,
        JSON.stringify(normalized.presetSnapshot),
        normalized.presetDefinitionHash,
        normalized.credentialVersionId || null,
        taskId,
        JSON.stringify(configSnapshot),
        requestKey,
        materializationHash
      ]);
      return toPublication(inserted.rows[0]!);
    });
  }

  async recordPublicationPackage(publicationId: string, input: {
    packageRelPath: string;
    packageSignature: string;
    materializationHash: string;
  }): Promise<WbStorePublication> {
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>(
        'SELECT * FROM wb_store_publications WHERE id=$1 FOR UPDATE',
        [publicationId]
      );
      const row = current.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'WB 店铺发布记录不存在', { publicationId }, 404);
      const existing = {
        packageRelPath: String(row.package_rel_path || ''),
        packageSignature: String(row.package_signature || ''),
        materializationHash: String(row.materialization_hash || '')
      };
      const conflict = (existing.packageRelPath && existing.packageRelPath !== input.packageRelPath)
        || (existing.packageSignature && existing.packageSignature !== input.packageSignature)
        || (existing.materializationHash && existing.materializationHash !== input.materializationHash);
      if (conflict) {
        throw new AppError('VERSION_CONFLICT', 'WB 店铺发布包身份已冻结，禁止覆盖不同路径、签名或物化哈希', {
          publicationId,
          existing,
          requested: input
        }, 409);
      }
      if (existing.packageRelPath === input.packageRelPath
        && existing.packageSignature === input.packageSignature
        && existing.materializationHash === input.materializationHash) {
        return toPublication(row);
      }
      const result = await client.query<SqlRow>(`UPDATE wb_store_publications SET
        package_rel_path=COALESCE(package_rel_path,$2),
        package_signature=COALESCE(package_signature,$3),
        materialization_hash=COALESCE(materialization_hash,$4),
        row_version=row_version+1,updated_at=NOW()
        WHERE id=$1
          AND (package_rel_path IS NULL OR package_rel_path=$2)
          AND (package_signature IS NULL OR package_signature=$3)
          AND (materialization_hash IS NULL OR materialization_hash=$4)
        RETURNING *`, [publicationId, input.packageRelPath, input.packageSignature, input.materializationHash]);
      if (!result.rows[0]) {
        throw new AppError('VERSION_CONFLICT', 'WB 店铺发布包在持久化时发生并发变化', { publicationId }, 409);
      }
      return toPublication(result.rows[0]);
    });
  }

  async assertGeneratedVersionPreset(
    generatedVersionId: string,
    presetDefinitionHash: string
  ): Promise<string> {
    const result = await this.query<SqlRow>(`SELECT v.material_preset_definition_hash,d.data
      FROM wb_listing_versions v LEFT JOIN wb_listing_drafts d ON d.generated_version_id=v.id
      WHERE v.id=$1`, [generatedVersionId]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'WB 已生成版本不存在', { generatedVersionId }, 404);
    const actual = await this.resolveGeneratedVersionMaterialHash(
      generatedVersionId,
      result.rows[0].material_preset_definition_hash,
      result.rows[0].data
    );
    if (actual !== presetDefinitionHash) {
      throw new AppError('PRESET_VERSION_MISMATCH', '店铺预设与该 product.json 的生成预设不一致，已拒绝发布', {
        generatedVersionId,
        expectedDefinitionHash: actual,
        actualDefinitionHash: presetDefinitionHash
      }, 409);
    }
    return actual;
  }

  async getPresetSnapshot(presetId: string): Promise<{ id: string; rowVersion: number; snapshot: JsonRecord }> {
    const result = await this.query<SqlRow>('SELECT * FROM wb_listing_presets WHERE id=$1', [presetId]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'WB 上品预设不存在', { presetId }, 404);
    const row = result.rows[0];
    return { id: String(row.id), rowVersion: Number(row.row_version || 1), snapshot: { ...row } };
  }

  async createPublications(input: WbPublicationInsert[]): Promise<WbStorePublication[]> {
    return this.transaction(async (client) => {
      const output: WbStorePublication[] = [];
      for (const publication of input) {
        const version = await client.query<SqlRow>(`SELECT v.material_preset_definition_hash,d.data
          FROM wb_listing_versions v LEFT JOIN wb_listing_drafts d ON d.generated_version_id=v.id
          WHERE v.id=$1 FOR UPDATE OF v`, [publication.generatedVersionId]);
        if (!version.rows[0]) throw new AppError('NOT_FOUND', 'WB 已生成版本不存在', { generatedVersionId: publication.generatedVersionId }, 404);
        const materialHash = await resolveGeneratedVersionMaterialHashWithClient(
          client,
          publication.generatedVersionId,
          version.rows[0].material_preset_definition_hash,
          version.rows[0].data
        );
        if (materialHash !== publication.presetDefinitionHash) {
          throw new AppError('PRESET_VERSION_MISMATCH', '店铺预设与该 product.json 的生成预设不一致，已拒绝创建发布记录', {
            generatedVersionId: publication.generatedVersionId,
            storeId: publication.storeId,
            expectedDefinitionHash: materialHash,
            actualDefinitionHash: publication.presetDefinitionHash
          }, 409);
        }
        const result = await client.query<SqlRow>(`INSERT INTO wb_store_publications(
          id,sku,generated_version_id,revision,store_id,store_alias_snapshot,status,source,preset_id,preset_snapshot,
          preset_definition_hash,credential_version_id,task_id,config_snapshot)
          VALUES($1,$2,$3,$4,$5,$6,'PLANNED',$7,$8,$9::jsonb,$10,$11,$12,$13::jsonb)
          ON CONFLICT(store_id,generated_version_id) DO UPDATE SET updated_at=wb_store_publications.updated_at
          RETURNING *`, [
          publication.id, publication.sku, publication.generatedVersionId, publication.revision,
          publication.storeId, publication.storeAlias, publication.source, publication.presetId || null,
          JSON.stringify(publication.presetSnapshot || {}), publication.presetDefinitionHash,
          publication.credentialVersionId || null, publication.taskId,
          JSON.stringify(publication.configSnapshot)
        ]);
        if (String(result.rows[0]?.preset_definition_hash || '') !== publication.presetDefinitionHash) {
          throw new AppError('PRESET_VERSION_MISMATCH', '已存在的店铺发布记录绑定了不同的生成预设，已拒绝复用', {
            publicationId: result.rows[0]?.id,
            generatedVersionId: publication.generatedVersionId,
            storeId: publication.storeId
          }, 409);
        }
        output.push(toPublication(result.rows[0]!));
      }
      return output;
    });
  }

  private async resolveGeneratedVersionMaterialHash(
    generatedVersionId: string,
    storedHash: unknown,
    listingData: unknown
  ): Promise<string> {
    const current = String(storedHash || '').trim();
    if (current) return current;
    const derived = wbMaterialPresetDefinitionHashFromListingData(listingData);
    if (!derived) {
      throw new AppError('PRESET_VERSION_MISMATCH', '该 product.json 缺少生成预设定义快照，请重新生成后再发布', {
        generatedVersionId
      }, 409);
    }
    await this.query(`UPDATE wb_listing_versions SET material_preset_definition_hash=$2,updated_at=NOW()
      WHERE id=$1 AND material_preset_definition_hash IS NULL`, [generatedVersionId, derived]);
    const readback = await this.query<{ material_preset_definition_hash: string }>(
      'SELECT material_preset_definition_hash FROM wb_listing_versions WHERE id=$1',
      [generatedVersionId]
    );
    const persisted = String(readback.rows[0]?.material_preset_definition_hash || '');
    if (persisted !== derived) {
      throw new AppError('PRESET_VERSION_MISMATCH', 'product.json 生成预设定义发生并发变化，已拒绝发布', {
        generatedVersionId
      }, 409);
    }
    return persisted;
  }

  async listPublications(input: { sku?: string; skus?: string[]; storeId?: string; status?: string; source?: string; compact?: boolean } = {}): Promise<WbStorePublication[]> {
    const values: unknown[] = [];
    const where: string[] = [];
    if (input.sku) { values.push(normalizeWbSku(input.sku)); where.push(`p.sku=$${values.length}`); }
    if (input.skus?.length) {
      const skus = [...new Set(input.skus.map(normalizeWbSku))];
      values.push(skus);
      where.push(`p.sku=ANY($${values.length}::text[])`);
    }
    if (input.storeId) { values.push(input.storeId); where.push(`p.store_id=$${values.length}::uuid`); }
    if (input.status) { values.push(input.status); where.push(`p.status=$${values.length}`); }
    if (input.source) { values.push(input.source); where.push(`p.source=$${values.length}`); }
    const projection = input.compact
      ? `p.id,p.sku,p.generated_version_id,p.store_id,p.store_alias_snapshot,p.status,p.source,p.task_id,p.revision,
        p.preset_id,p.preset_definition_hash,p.plan_hash,
        NULLIF(BTRIM(p.preset_snapshot->>'name'),'') preset_name,
        NULLIF(BTRIM(p.config_snapshot->>'presetRowVersion'),'') preset_row_version,
        COALESCE(NULLIF(BTRIM(p.config_snapshot->>'autoPublishMode'),''),
          NULLIF(BTRIM(p.config_snapshot->>'operationMode'),'')) operation_mode,
        NULLIF(BTRIM(p.config_snapshot->>'draftVersion'),'') publication_draft_version,
        EXISTS(SELECT 1 FROM wb_listing_presets source_preset WHERE source_preset.id=p.preset_id) source_preset_exists,
        jsonb_build_object(
          'draftVersion',p.config_snapshot->'draftVersion',
          'baseGeneratedVersionId',p.config_snapshot->'baseGeneratedVersionId',
          'planStoreIds',p.config_snapshot->'planStoreIds'
        ) config_snapshot,p.nm_ids,p.product_urls,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'nmId',COALESCE(card.value->>'nmID',card.value->>'nmId'),
          'variantCode',COALESCE(NULLIF(BTRIM(card.value->>'variantCode'),''),NULLIF(BTRIM(card.value->>'vendorCode'),''))
        ) ORDER BY card.position)
          FROM jsonb_array_elements(CASE
            WHEN jsonb_typeof(p.result_json->'cards')='array' THEN p.result_json->'cards'
            ELSE '[]'::jsonb
          END) WITH ORDINALITY AS card(value,position)
          WHERE jsonb_typeof(card.value)='object'
            AND NULLIF(BTRIM(COALESCE(card.value->>'nmID',card.value->>'nmId')),'') IS NOT NULL
        ),'[]'::jsonb) product_link_identities,
        p.error_code,p.error_message,p.row_version,
        p.created_at,p.updated_at,p.completed_at,s.display_name store_display_name`
      : 'p.*,s.display_name store_display_name';
    const latestPlanPredicate = input.compact
      ? `AND p.plan_hash=(SELECT latest.plan_hash FROM wb_store_publications latest
        WHERE latest.sku=p.sku AND latest.source=p.source AND latest.plan_hash IS NOT NULL
        ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)`
      : '';
    const result = await this.query<SqlRow>(`SELECT ${projection}
      FROM wb_store_publications p JOIN wb_stores s ON s.id=p.store_id
      ${where.length ? `WHERE ${where.join(' AND ')} ${latestPlanPredicate}` : ''}
      ORDER BY p.updated_at DESC,p.created_at DESC,p.id${input.compact ? '' : ' LIMIT 1000'}`, values);
    return result.rows.map(toPublication);
  }

  async getPublication(publicationId: string): Promise<WbStorePublication> {
    const result = await this.query<SqlRow>(`SELECT p.*,s.display_name store_display_name
      FROM wb_store_publications p JOIN wb_stores s ON s.id=p.store_id WHERE p.id=$1`, [publicationId]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'WB 店铺发布记录不存在', { publicationId }, 404);
    return toPublication(result.rows[0]);
  }

  async findAutomationMaterializedPublication(input: {
    sku: string;
    automationRunId: string;
    storeId: string;
  }): Promise<WbStorePublication | undefined> {
    const requestKey = `automation:${input.automationRunId}:${input.storeId}`;
    const result = await this.query<SqlRow>(`SELECT p.*,s.display_name store_display_name,
        publication_version.generation_scope publication_generation_scope,
        publication_version.status publication_version_status,
        publication_version.materialization_hash publication_version_materialization_hash,
        publication_version.sku publication_version_sku,
        source_version.id source_version_id,
        source_version.generation_scope source_generation_scope,
        source_version.status source_version_status,
        source_version.sku source_version_sku
      FROM wb_store_publications p
      JOIN wb_stores s ON s.id=p.store_id
      LEFT JOIN wb_listing_versions publication_version ON publication_version.id=p.generated_version_id
      LEFT JOIN wb_listing_versions source_version
        ON source_version.id::text=p.config_snapshot->>'sourceGeneratedVersionId'
      WHERE p.request_key=$1`, [requestKey]);
    const row = result.rows[0];
    if (!row) return undefined;
    assertStrictAutomationMaterialization(row, input, requestKey);
    return toPublication(row);
  }

  async hasFrozenAutomationPublicationForSource(input: {
    sku: string;
    sourceGeneratedVersionId: string;
    automationRunId: string;
    storeId: string;
  }): Promise<boolean> {
    const publication = await this.findAutomationMaterializedPublication(input);
    return Boolean(publication
      && String(publication.configSnapshot.sourceGeneratedVersionId || '') === input.sourceGeneratedVersionId);
  }

  async syncPublication(publicationId: string): Promise<WbStorePublication> {
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>('SELECT * FROM wb_store_publications WHERE id=$1 FOR UPDATE', [publicationId]);
      const publication = current.rows[0];
      if (!publication) throw new AppError('NOT_FOUND', 'WB 店铺发布记录不存在', { publicationId }, 404);
      if (publication.task_id) {
        const job = await client.query<SqlRow>('SELECT * FROM wb_publish_jobs WHERE task_id=$1', [publication.task_id]);
        if (job.rows[0]) await syncPublicationFromRuntime(client, job.rows[0]);
      }
      const refreshed = await client.query<SqlRow>(`SELECT p.*,s.display_name store_display_name
        FROM wb_store_publications p JOIN wb_stores s ON s.id=p.store_id WHERE p.id=$1`, [publicationId]);
      return toPublication(refreshed.rows[0]!);
    });
  }

  async markPublicationDispatching(publicationId: string): Promise<WbStorePublication> {
    const result = await this.query<SqlRow>(`UPDATE wb_store_publications SET status='DISPATCHING',row_version=row_version+1,updated_at=NOW()
      WHERE id=$1 AND status IN ('PLANNED','NEEDS_ATTENTION') RETURNING *`, [publicationId]);
    if (!result.rows[0]) throw new AppError('TASK_LOCKED', 'WB 店铺发布记录已由其他操作推进', { publicationId }, 409);
    return toPublication(result.rows[0]);
  }

  async markPublicationQueued(publicationId: string, taskId: string, result: JsonRecord): Promise<WbStorePublication> {
    const changed = await this.query<SqlRow>(`UPDATE wb_store_publications SET status='QUEUED',task_id=$2,result_json=$3::jsonb,
      error_code='',error_message='',row_version=row_version+1,updated_at=NOW()
      WHERE id=$1 AND status='DISPATCHING' RETURNING *`, [publicationId, taskId, JSON.stringify(result)]);
    if (!changed.rows[0]) throw new AppError('TASK_LOCKED', 'WB 店铺发布记录状态已变化', { publicationId }, 409);
    await this.query('UPDATE wb_publish_jobs SET publication_id=$2 WHERE task_id=$1 AND publication_id IS NULL', [taskId, publicationId]);
    return toPublication(changed.rows[0]);
  }

  async markPublicationDispatchUnknown(
    publicationId: string,
    taskId: string,
    code: string,
    message: string
  ): Promise<WbStorePublication> {
    const recovery = {
      dispatchRecovery: {
        deliveryUnknown: true,
        taskId,
        errorCode: code,
        errorMessage: message.slice(0, 4_000),
        recordedAt: new Date().toISOString()
      }
    };
    const result = await this.query<SqlRow>(`UPDATE wb_store_publications SET status='DISPATCHING',task_id=COALESCE(task_id,$2),
      result_json=COALESCE(result_json,'{}'::jsonb) || $5::jsonb,error_code=$3,error_message=$4,
      row_version=row_version+1,updated_at=NOW()
      WHERE id=$1 AND status='DISPATCHING' RETURNING *`, [
      publicationId, taskId, code, message.slice(0, 4_000), JSON.stringify(recovery)
    ]);
    if (!result.rows[0]) throw new AppError('TASK_LOCKED', 'WB 店铺发布记录状态已变化', { publicationId }, 409);
    return toPublication(result.rows[0]);
  }

  async markPublicationFailed(publicationId: string, code: string, message: string): Promise<WbStorePublication> {
    const result = await this.query<SqlRow>(`UPDATE wb_store_publications SET status='NEEDS_ATTENTION',error_code=$2,error_message=$3,
      row_version=row_version+1,updated_at=NOW()
      WHERE id=$1 AND status IN ('PLANNED','DISPATCHING','NEEDS_ATTENTION') RETURNING *`, [publicationId, code, message.slice(0, 4_000)]);
    if (!result.rows[0]) throw new AppError('TASK_LOCKED', 'WB 店铺发布记录状态已变化，拒绝回退为待处理', { publicationId }, 409);
    return toPublication(result.rows[0]);
  }

  async getGatewayIdentity(input: { taskId?: string; storeId?: string }): Promise<WbGatewayIdentity> {
    let result;
    if (input.taskId) {
      result = await this.query<SqlRow>(`SELECT s.id store_id,s.store_alias,j.warehouse_id,j.store_config_version config_version,s.enabled store_enabled,
        settings.root_directory,j.task_id,j.publication_id,j.work_relpath,j.product_code,j.result_json runtime_result,
        (j.lease_owner<>'' AND j.lease_expires_at>NOW()) lease_active,c.*
        FROM wb_publish_jobs j JOIN wb_stores s ON s.id=j.store_id
        JOIN wb_system_settings settings ON settings.settings_id='default'
        JOIN wb_store_credential_versions c ON c.id=j.credential_version_id AND c.store_id=s.id
        WHERE j.task_id=$1 AND c.status IN ('ACTIVE','RETIRED')`, [input.taskId]);
    } else {
      result = await this.query<SqlRow>(`SELECT s.id store_id,s.store_alias,s.warehouse_id,s.config_version,s.enabled store_enabled,
        settings.root_directory,false lease_active,c.* FROM wb_stores s
        JOIN wb_system_settings settings ON settings.settings_id='default' JOIN LATERAL (
          SELECT * FROM wb_store_credential_versions candidate WHERE candidate.store_id=s.id
          AND candidate.status IN ('PENDING','ACTIVE') ORDER BY CASE candidate.status WHEN 'PENDING' THEN 0 ELSE 1 END,version_no DESC LIMIT 1
        ) c ON true WHERE s.id=$1 AND s.archived_at IS NULL`, [input.storeId]);
    }
    const row = result.rows[0];
    if (!row) throw new AppError('WB_CREDENTIAL_REQUIRED', '任务或店铺没有可用的 Vault 凭据', input, 409);
    return {
      storeId: String(row.store_id), storeAlias: String(row.store_alias), warehouseId: String(row.warehouse_id || ''),
      configVersion: Number(row.config_version || 1), rootDirectory: String(row.root_directory || ''),
      storeEnabled: Boolean(row.store_enabled), leaseActive: Boolean(row.lease_active),
      ...(row.task_id ? { taskId: String(row.task_id) } : {}),
      ...(row.publication_id ? { publicationId: String(row.publication_id) } : {}),
      ...(row.work_relpath ? { workRelpath: String(row.work_relpath) } : {}),
      ...(row.product_code ? { productCode: String(row.product_code) } : {}),
      ...(row.runtime_result ? { runtimeResult: asObject(row.runtime_result) } : {}),
      credential: {
        id: String(row.id), storeId: String(row.store_id), version: Number(row.version_no), status: row.status,
        ciphertext: String(row.ciphertext), nonce: String(row.nonce), authTag: String(row.auth_tag),
        fingerprint: String(row.fingerprint), keyVersion: Number(row.key_version)
      }
    };
  }

  async beginGatewayRequest(input: {
    requestRef: string;
    requestHash: string;
    operation: string;
    identity: WbGatewayIdentity;
    logicalIntentId?: string;
    attemptNo?: number;
  }): Promise<{ idempotent: boolean; row: JsonRecord }> {
    const hasLogicalIntent = input.logicalIntentId !== undefined || input.attemptNo !== undefined;
    if ((input.logicalIntentId === undefined) !== (input.attemptNo === undefined)) {
      throw new AppError('CONFIG_INVALID', 'WB 网关 logicalIntentId 与 attemptNo 必须同时提供', {
        requestRef: input.requestRef, operation: input.operation
      }, 409);
    }
    if (input.operation === 'CARD_UPLOAD') {
      const legacyAttemptOne = !hasLogicalIntent && isLegacyCardUploadRequestRef(input.requestRef, input.identity.taskId);
      if (!input.identity.taskId || (!legacyAttemptOne && (!input.logicalIntentId || !Number.isInteger(input.attemptNo)
        || input.attemptNo! < 1 || input.attemptNo! > 2147483647))) {
        throw new AppError('WB_CARD_ATTEMPT_INVALID', 'CARD_UPLOAD 必须绑定 taskId、logicalIntentId 及有效 attemptNo', {
          requestRef: input.requestRef, operation: input.operation, attemptNo: input.attemptNo
        }, 409);
      }
    } else if (hasLogicalIntent && (!Number.isInteger(input.attemptNo) || input.attemptNo! < 1 || input.attemptNo! > 2)) {
      throw new AppError('CONFIG_INVALID', 'WB 网关 attemptNo 必须在 1..2 之间', {
        requestRef: input.requestRef, operation: input.operation, attemptNo: input.attemptNo
      }, 409);
    }

    return this.transaction(async (client) => {
      const existing = await client.query<SqlRow>('SELECT * FROM wb_gateway_requests WHERE request_ref=$1 FOR UPDATE', [input.requestRef]);
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (String(row.request_hash) !== input.requestHash) {
          throw new AppError('VERSION_CONFLICT', '同一 requestRef 对应了不同请求内容', { requestRef: input.requestRef }, 409);
        }
        assertGatewayRequestIdentity(row, input);
        if (input.logicalIntentId && row.logical_intent_id == null) {
          throw new AppError('WB_CARD_LEGACY_REPLAY_REQUIRED', '旧 CARD_UPLOAD 账本不允许通过原 requestRef 绑定新 intent', {
            requestRef: input.requestRef, taskId: input.identity.taskId
          }, 409);
        } else if (input.logicalIntentId) {
          assertCardIntentCompatible(row, input);
        }
        if (row.completed_at
          && String(row.delivery_state) === 'NOT_SENT'
          && String(row.retry_class) === 'RETRYABLE') {
          if (input.operation === 'CARD_UPLOAD') {
            if (!input.logicalIntentId) return { idempotent: true, row };
            await assertCardUploadAttemptAuthorization(client, input);
          }
          const retried = await client.query<SqlRow>(`UPDATE wb_gateway_requests SET
            status_code=0,delivery_state='UNKNOWN',retry_class='READBACK_REQUIRED',retry_after_ms=NULL,
            response_json='{}'::jsonb,transport_code=NULL,transport_phase=NULL,completed_at=NULL,updated_at=NOW()
            WHERE request_ref=$1 RETURNING *`, [input.requestRef]);
          return { idempotent: false, row: retried.rows[0]! };
        }
        return { idempotent: true, row };
      }

      if (input.operation === 'CARD_UPLOAD' && !input.logicalIntentId) {
        throw new AppError('WB_CARD_LEGACY_REPLAY_REQUIRED', '旧 CARD_UPLOAD requestRef 仅允许回读已存在账本，禁止创建新的 legacy 写入', {
          requestRef: input.requestRef, taskId: input.identity.taskId
        }, 409);
      }

      if (input.logicalIntentId) {
        const intentRows = await client.query<SqlRow>(`SELECT * FROM wb_gateway_requests
          WHERE logical_intent_id=$1 FOR UPDATE`, [input.logicalIntentId]);
        for (const row of intentRows.rows) assertCardIntentCompatible(row, input);

        const sameAttempt = intentRows.rows.find((row) => Number(row.attempt_no) === input.attemptNo);
        if (sameAttempt) return { idempotent: true, row: sameAttempt };

        if (input.operation === 'CARD_UPLOAD') {
          await assertCardUploadAttemptAuthorization(client, input);
          const taskAttempt = await client.query<SqlRow>(`SELECT * FROM wb_gateway_requests
            WHERE task_id=$1 AND operation='CARD_UPLOAD' AND attempt_no=$2 FOR UPDATE`, [
            input.identity.taskId, input.attemptNo
          ]);
          if (taskAttempt.rows[0]) {
            assertCardIntentCompatible(taskAttempt.rows[0], input);
            return { idempotent: true, row: taskAttempt.rows[0] };
          }
        }

        if (input.operation === 'CARD_UPLOAD' && input.attemptNo === 2
          && !intentRows.rows.some((row) => Number(row.attempt_no) === 1)) {
          const legacy = await client.query<SqlRow>(`SELECT * FROM wb_gateway_requests
            WHERE logical_intent_id IS NULL AND operation='CARD_UPLOAD' AND task_id=$1 AND store_id=$2
              AND request_hash=$3 ORDER BY created_at ASC FOR UPDATE`, [
            input.identity.taskId, input.identity.storeId, input.requestHash
          ]);
          if (legacy.rows.length > 1) {
            throw new AppError('WB_CARD_IDENTITY_AMBIGUOUS', '历史 CARD_UPLOAD 存在多个相同请求，禁止自动建立第二次写入', {
              logicalIntentId: input.logicalIntentId, taskId: input.identity.taskId, legacyRequestRefs: legacy.rows.map((row) => row.request_ref)
            }, 409);
          }
          if (legacy.rows[0]) {
            await client.query(`UPDATE wb_gateway_requests SET logical_intent_id=$2,attempt_no=1,updated_at=NOW()
              WHERE request_ref=$1 AND logical_intent_id IS NULL`, [legacy.rows[0].request_ref, input.logicalIntentId]);
          } else {
            const refreshed = await client.query<SqlRow>(`SELECT * FROM wb_gateway_requests
              WHERE logical_intent_id=$1 FOR UPDATE`, [input.logicalIntentId]);
            for (const row of refreshed.rows) assertCardIntentCompatible(row, input);
            const racedAttempt = refreshed.rows.find((row) => Number(row.attempt_no) === 2);
            if (racedAttempt) return { idempotent: true, row: racedAttempt };
            if (!refreshed.rows.some((row) => Number(row.attempt_no) === 1)) {
              throw new AppError('WB_CARD_ATTEMPT_SEQUENCE', 'CARD_UPLOAD attempt 2 缺少已持久化的 attempt 1', {
                logicalIntentId: input.logicalIntentId, taskId: input.identity.taskId
              }, 409);
            }
          }
        }
      }

      const created = await client.query<SqlRow>(`INSERT INTO wb_gateway_requests(
        request_ref,request_hash,task_id,publication_id,store_id,credential_version_id,operation,
        logical_intent_id,attempt_no,delivery_state,retry_class)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'NOT_SENT','NONE')
        ON CONFLICT DO NOTHING RETURNING *`, [
        input.requestRef, input.requestHash, input.identity.taskId || null, input.identity.publicationId || null,
        input.identity.storeId, input.identity.credential.id, input.operation,
        input.logicalIntentId || null, input.attemptNo || null
      ]);
      if (created.rows[0]) return { idempotent: false, row: created.rows[0] };
      const raced = await client.query<SqlRow>(`SELECT * FROM wb_gateway_requests
        WHERE request_ref=$1 OR ($2::text IS NOT NULL AND logical_intent_id=$2 AND attempt_no=$3)
          OR ($4::text IS NOT NULL AND task_id=$4 AND operation='CARD_UPLOAD' AND attempt_no=$3)
        FOR UPDATE`, [input.requestRef, input.logicalIntentId || null, input.attemptNo || null,
        input.operation === 'CARD_UPLOAD' ? input.identity.taskId || null : null]);
      const row = raced.rows[0];
      if (!row) {
        throw new AppError('VERSION_CONFLICT', 'WB 网关请求并发建账冲突，且未找到可回读记录', {
          requestRef: input.requestRef, logicalIntentId: input.logicalIntentId, attemptNo: input.attemptNo
        }, 409);
      }
      if (String(row.request_hash) !== input.requestHash) {
        throw new AppError('VERSION_CONFLICT', '并发 requestRef 对应了不同请求内容', { requestRef: input.requestRef }, 409);
      }
      assertGatewayRequestIdentity(row, input);
      if (input.logicalIntentId) assertCardIntentCompatible(row, input);
      return { idempotent: true, row };
    });
  }

  async completeGatewayRequest(input: {
    requestRef: string;
    statusCode: number;
    deliveryState: 'NOT_SENT' | 'UNKNOWN' | 'RESPONDED';
    retryClass: 'NONE' | 'READBACK_REQUIRED' | 'RETRYABLE' | 'PERMANENT';
    retryAfterMs?: number;
    transportCode?: string;
    transportPhase?: string;
    response: unknown;
  }): Promise<void> {
    await this.query(`UPDATE wb_gateway_requests SET status_code=$2,delivery_state=$3,retry_class=$4,retry_after_ms=$5,
      response_json=$6::jsonb,transport_code=$7,transport_phase=$8,completed_at=NOW(),updated_at=NOW() WHERE request_ref=$1`, [
      input.requestRef, input.statusCode, input.deliveryState, input.retryClass, input.retryAfterMs || null,
      JSON.stringify(input.response ?? null), input.transportCode || null, input.transportPhase || null
    ]);
  }

  private query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
    return this.requirePool().query<T>(text, values);
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.requirePool().connect();
    try { await client.query('BEGIN'); const result = await operation(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  private requirePool(): Pool {
    if (!this.pool) throw new AppError('DATABASE_UNAVAILABLE', 'WB 多店铺管理尚未配置 PostgreSQL DATABASE_URL', undefined, 503);
    return this.pool;
  }
}

type WbGatewayRequestIdentityInput = {
  requestRef: string;
  requestHash: string;
  operation: string;
  identity: WbGatewayIdentity;
  logicalIntentId?: string;
  attemptNo?: number;
};

function isLegacyCardUploadRequestRef(requestRef: string, taskId?: string): boolean {
  if (!taskId) return false;
  const prefix = `${taskId}:CARD_WRITE:`;
  if (!requestRef.startsWith(prefix)) return false;
  const suffix = requestRef.slice(prefix.length);
  const separator = suffix.lastIndexOf(':');
  if (separator < 1 || !/^\d+$/.test(suffix.slice(separator + 1))) return false;
  const issuedAt = suffix.slice(0, separator);
  return /^\d{4}-\d{2}-\d{2}T/.test(issuedAt) && Number.isFinite(Date.parse(issuedAt));
}

function assertGatewayRequestIdentity(row: SqlRow, input: WbGatewayRequestIdentityInput): void {
  if (String(row.operation) !== input.operation
    || String(row.store_id) !== input.identity.storeId
    || String(row.task_id || '') !== String(input.identity.taskId || '')) {
    throw new AppError('VERSION_CONFLICT', '同一 requestRef 对应了不同的 WB 任务身份', {
      requestRef: input.requestRef,
      operation: input.operation,
      taskId: input.identity.taskId,
      storeId: input.identity.storeId
    }, 409);
  }
}

function assertCardIntentCompatible(row: SqlRow, input: WbGatewayRequestIdentityInput): void {
  if (String(row.logical_intent_id || '') !== String(input.logicalIntentId || '')
    || String(row.operation) !== input.operation
    || String(row.task_id || '') !== String(input.identity.taskId || '')
    || String(row.store_id) !== input.identity.storeId
    || String(row.publication_id || '') !== String(input.identity.publicationId || '')
    || String(row.credential_version_id || '') !== String(input.identity.credential.id || '')
    || String(row.request_hash) !== input.requestHash) {
    throw new AppError('WB_CARD_INTENT_CONFLICT', '同一建卡 logical intent 的任务、店铺或冻结载荷不一致', {
      logicalIntentId: input.logicalIntentId,
      requestRef: input.requestRef,
      taskId: input.identity.taskId,
      storeId: input.identity.storeId
    }, 409);
  }
}

async function assertCardUploadAttemptAuthorization(
  client: PoolClient,
  input: WbGatewayRequestIdentityInput
): Promise<void> {
  const taskId = String(input.identity.taskId || '');
  const logicalIntentId = String(input.logicalIntentId || '');
  const attemptNo = Number(input.attemptNo || 0);
  if (!taskId || !logicalIntentId || !Number.isSafeInteger(attemptNo) || attemptNo < 1) {
    throw new AppError('WB_CARD_ATTEMPT_INVALID', 'CARD_UPLOAD intent 身份不完整', {
      taskId, logicalIntentId, attemptNo
    }, 409);
  }

  const jobs = await client.query<SqlRow>(`SELECT task_id,store_id,publication_id,credential_version_id,warehouse_id,
    product_code,revision,idempotency_key,state,result_json,NOW() db_now
    FROM wb_publish_jobs WHERE task_id=$1 FOR UPDATE`, [taskId]);
  const job = jobs.rows[0];
  if (!job) {
    throw new AppError('WB_CARD_INTENT_CONFLICT', 'CARD_UPLOAD intent 对应的 runtime task 不存在', { taskId }, 409);
  }
  const expectedLogicalIntentId = `card-${createHash('sha256').update([
    String(job.task_id || ''), String(job.publication_id || ''), String(job.revision || ''),
    String(job.idempotency_key || ''), 'CARD_UPLOAD'
  ].join('|'), 'utf8').digest('hex')}`;
  if (logicalIntentId !== expectedLogicalIntentId
    || String(job.store_id) !== input.identity.storeId
    || String(job.publication_id || '') !== String(input.identity.publicationId || '')
    || String(job.credential_version_id || '') !== String(input.identity.credential.id || '')
    || String(job.warehouse_id || '') !== String(input.identity.warehouseId || '')
    || String(job.state || '') !== 'CARD_SUBMITTING') {
    throw new AppError('WB_CARD_INTENT_CONFLICT', 'CARD_UPLOAD intent 与冻结 runtime task 身份不一致', {
      taskId, logicalIntentId, attemptNo, state: job.state
    }, 409);
  }

  const runtime = asObject(job.result_json);
  const intent = asObject(runtime.cardCreateIntent);
  const recovery = asObject(runtime.cardRecovery);
  const frozenPayload = Array.isArray(intent.frozenPayload) ? intent.frozenPayload : null;
  const product = asObject(runtime.product);
  const variants = Array.isArray(product.variants) ? product.variants.map(asObject) : [];
  const productVendorCodes = variants.map((variant) => String(variant.vendorCode || '')).filter(Boolean);
  const intentVendorCodes = Array.isArray(intent.vendorCodes) ? intent.vendorCodes.map(String) : [];
  const frozenVendorCodes = frozenPayload
    ? frozenPayload.flatMap((entry) => {
      const group = asObject(entry);
      return (Array.isArray(group.variants) ? group.variants : [])
        .map((variant) => String(asObject(variant).vendorCode || '')).filter(Boolean);
    })
    : [];
  const frozenPayloadHash = frozenPayload
    ? `sha256:${createHash('sha256').update(stableJson(frozenPayload), 'utf8').digest('hex')}`
    : '';
  const expectedRequestHash = frozenPayload
    ? `sha256:${createHash('sha256').update(stableJson({
      taskId: String(job.task_id),
      storeId: String(job.store_id),
      credentialVersionId: String(job.credential_version_id),
      warehouseId: String(job.warehouse_id || ''),
      operation: 'CARD_UPLOAD',
      payload: { body: frozenPayload }
    }), 'utf8').digest('hex')}`
    : '';
  if (String(runtime.cardOperation || '') !== 'create'
    || String(intent.taskId || '') !== String(job.task_id)
    || String(intent.publicationId || '') !== String(job.publication_id || '')
    || Number(intent.revision || 0) !== Number(job.revision || 0)
    || String(intent.idempotencyKey || '') !== String(job.idempotency_key || '')
    || String(intent.logicalIntentId || '') !== logicalIntentId
    || Number(intent.attemptNo || 0) !== attemptNo
    || String(intent.frozenPayloadHash || '') !== frozenPayloadHash
    || input.requestHash !== expectedRequestHash
    || stableJson(intentVendorCodes) !== stableJson(productVendorCodes)
    || stableJson(frozenVendorCodes) !== stableJson(productVendorCodes)) {
    throw new AppError('WB_CARD_INTENT_CONFLICT', 'CARD_UPLOAD intent 的载荷、条码或商品身份已变化', {
      taskId, logicalIntentId, attemptNo
    }, 409);
  }

  const manual = asObject(runtime.manualRetry);
  if (manual.cardWriteAuthorized === true && Number(manual.cardAttemptNo) === attemptNo) {
    const grants = await client.query<SqlRow>(`SELECT * FROM wb_auto_publish_retries
      WHERE id=$1 AND task_id=$2 AND store_id=$3 AND publication_id=$4
        AND status='RUNNING' AND authorized_attempt=$5 FOR UPDATE`,
    [manual.retryId, taskId, job.store_id, job.publication_id, attemptNo]);
    const grant = grants.rows[0];
    const evidence = asObject(grant?.evidence);
    const protocol = await client.query(`SELECT 1 FROM wb_manual_retry_protocol
      WHERE singleton AND enabled AND contract_version=1 AND workflow_version_id<>'' AND verified_at IS NOT NULL`);
    const prior = await client.query<SqlRow>(`SELECT * FROM wb_gateway_requests
      WHERE task_id=$1 AND operation='CARD_UPLOAD' ORDER BY attempt_no DESC NULLS LAST FOR UPDATE`, [taskId]);
    const previous = prior.rows.find((row) => Number(row.attempt_no) < attemptNo);
    const checkedAt = Date.parse(String(evidence.checkedAt || ''));
    const now = Date.parse(String(job.db_now));
    if (grant && !grant.consumed_at && Number.isFinite(checkedAt) && now - checkedAt > 10 * 60_000) {
      throw new AppError('WB_CARD_RETRY_PROOF_EXPIRED', '重试核验已过期，后台将重新核对后继续原尝试', { taskId, attemptNo }, 409);
    }
    if (!grant || !protocol.rowCount || evidence.complete !== true || evidence.cardAbsent !== true
      || !Number.isFinite(checkedAt) || (!grant.consumed_at && now - checkedAt > 10 * 60_000) || checkedAt > now + 5_000
      || !previous || Number(previous.attempt_no) !== attemptNo - 1
      || previous.delivery_state === 'UNKNOWN' || !previous.completed_at
      || previous.request_hash !== input.requestHash
      || (grant.consumed_at && (grant.request_ref !== input.requestRef || grant.request_hash !== input.requestHash))) {
      throw new AppError('WB_CARD_RETRY_NOT_AUTHORIZED', '本次人工重试许可无效、核验已过期或存在未决写入', { taskId, attemptNo }, 409);
    }
    await client.query(`UPDATE wb_auto_publish_retries SET consumed_at=COALESCE(consumed_at,NOW()),
      request_ref=$2,request_hash=$3,updated_at=NOW() WHERE id=$1`,
    [grant.id, input.requestRef, input.requestHash]);
    return;
  }
  if (attemptNo > 2) {
    throw new AppError('WB_CARD_RETRY_NOT_AUTHORIZED', '新增建卡尝试必须绑定有效的人工重试记录', { taskId, attemptNo }, 409);
  }
  if (attemptNo === 1) {
    const legacyAttempts = await client.query<SqlRow>(`SELECT * FROM wb_gateway_requests
      WHERE logical_intent_id IS NULL AND operation='CARD_UPLOAD' AND task_id=$1 AND store_id=$2
      ORDER BY created_at ASC FOR UPDATE`, [taskId, input.identity.storeId]);
    if (legacyAttempts.rows.length > 1) {
      throw new AppError('WB_CARD_IDENTITY_AMBIGUOUS', '历史 CARD_UPLOAD 存在多个未认领请求，禁止创建新的 attempt 1', {
        taskId,
        logicalIntentId,
        legacyRequestRefs: legacyAttempts.rows.map((row) => row.request_ref)
      }, 409);
    }
    if (legacyAttempts.rows[0]) {
      throw new AppError('WB_CARD_LEGACY_ATTEMPT_EXISTS', '当前任务已有历史 CARD_UPLOAD，禁止创建新的 attempt 1；必须先完成 UNKNOWN 安全回读', {
        taskId,
        logicalIntentId,
        legacyRequestRef: legacyAttempts.rows[0].request_ref
      }, 409);
    }
    return;
  }

  const linkedAttemptOne = await client.query<SqlRow>(`SELECT * FROM wb_gateway_requests
    WHERE logical_intent_id=$1 AND attempt_no=1 FOR UPDATE`, [logicalIntentId]);
  let attemptOne = linkedAttemptOne.rows[0];
  if (!attemptOne) {
    const legacy = await client.query<SqlRow>(`SELECT * FROM wb_gateway_requests
      WHERE logical_intent_id IS NULL AND operation='CARD_UPLOAD' AND task_id=$1 AND store_id=$2
        AND request_hash=$3 ORDER BY created_at ASC FOR UPDATE`, [taskId, input.identity.storeId, input.requestHash]);
    if (legacy.rows.length !== 1) {
      throw new AppError(
        legacy.rows.length > 1 ? 'WB_CARD_IDENTITY_AMBIGUOUS' : 'WB_CARD_ATTEMPT_SEQUENCE',
        legacy.rows.length > 1
          ? '历史 CARD_UPLOAD 存在多个相同请求，禁止授权第二次写入'
          : 'CARD_UPLOAD attempt 2 缺少唯一的 attempt 1',
        { taskId, logicalIntentId, legacyRequestRefs: legacy.rows.map((row) => row.request_ref) },
        409
      );
    }
    attemptOne = legacy.rows[0];
  }
  if (!attemptOne) {
    throw new AppError('WB_CARD_ATTEMPT_SEQUENCE', 'CARD_UPLOAD attempt 2 缺少 attempt 1', {
      taskId, logicalIntentId
    }, 409);
  }
  if (String(attemptOne.operation) !== 'CARD_UPLOAD'
    || String(attemptOne.task_id || '') !== taskId
    || String(attemptOne.store_id || '') !== input.identity.storeId
    || String(attemptOne.publication_id || '') !== String(job.publication_id || '')
    || String(attemptOne.credential_version_id || '') !== String(job.credential_version_id || '')
    || String(attemptOne.request_hash || '') !== input.requestHash
    || String(attemptOne.delivery_state || '') !== 'UNKNOWN'
    || String(attemptOne.retry_class || '') !== 'READBACK_REQUIRED') {
    throw new AppError('WB_CARD_RETRY_NOT_AUTHORIZED', 'CARD_UPLOAD attempt 1 不是唯一且未决的 UNKNOWN 写入', {
      taskId, logicalIntentId, deliveryState: attemptOne.delivery_state, retryClass: attemptOne.retry_class
    }, 409);
  }

  const unknownAt = Date.parse(String(attemptOne.completed_at || ''));
  const dbNow = Date.parse(String(job.db_now || ''));
  const retryAuthorizedAt = Date.parse(String(recovery.retryAuthorizedAt || ''));
  const retryIssuedAt = Date.parse(String(intent.retryIssuedAt || intent.lastAttemptAt || ''));
  const proofEvents = (Array.isArray(runtime.audit) ? runtime.audit : [])
    .map(asObject)
    .filter((event) => String(event.event || '') === 'CARD_UNKNOWN_PROOF_ROUND'
      && String(event.logicalIntentId || '') === logicalIntentId
      && [1, 2].includes(Number(event.round || 0))
      && Number.isFinite(Date.parse(String(event.at || ''))));
  const roundOnes = proofEvents.filter((event) => Number(event.round) === 1);
  const roundTwos = proofEvents.filter((event) => Number(event.round) === 2);
  const eligibleAt = unknownAt + 30 * 60 * 1000;
  const hasProofPair = roundOnes.length === 1 && roundTwos.length === 1 && roundTwos.some((roundTwo) => {
    const roundTwoAt = Date.parse(String(roundTwo.at));
    return roundTwoAt >= eligibleAt && roundOnes.some((roundOne) => {
      const roundOneAt = Date.parse(String(roundOne.at));
      return roundOneAt >= eligibleAt && roundTwoAt - roundOneAt >= 60 * 1000
        && retryAuthorizedAt >= roundTwoAt && retryIssuedAt >= retryAuthorizedAt
        && retryIssuedAt <= dbNow + 5_000;
    });
  });
  if (!Number.isFinite(unknownAt) || !Number.isFinite(dbNow) || dbNow < eligibleAt
    || recovery.active !== true || Number(recovery.attemptNo || 0) !== 2
    || Number(recovery.proofRounds || 0) < 2 || recovery.finalReadbackOnly !== true
    || String(recovery.logicalIntentId || '') !== logicalIntentId
    || !Number.isFinite(retryAuthorizedAt) || !Number.isFinite(retryIssuedAt)
    || retryAuthorizedAt < eligibleAt || retryIssuedAt < retryAuthorizedAt
    || retryIssuedAt > dbNow + 5_000 || !hasProofPair) {
    throw new AppError('WB_CARD_RETRY_NOT_AUTHORIZED', 'CARD_UPLOAD attempt 2 尚未满足 30 分钟和两轮完整核验门槛', {
      taskId, logicalIntentId, attemptNo, proofRounds: recovery.proofRounds
    }, 409);
  }
}

export async function migrateWbMultiStoreSchema(pool: Pool): Promise<void> {
  await pool.query('CREATE TABLE IF NOT EXISTS wb_schema_migrations(id TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('pixroute_wb_schema_migrations'))");
    const applied = await client.query("SELECT id FROM wb_schema_migrations WHERE id='028_wb_multi_store_foundation'");
    if (!applied.rows[0]) {
      await client.query('BEGIN');
      await client.query(`CREATE TABLE wb_system_settings(
        settings_id TEXT PRIMARY KEY DEFAULT 'default',enabled BOOLEAN NOT NULL DEFAULT false,root_directory TEXT NOT NULL DEFAULT '',
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',global_concurrency INTEGER NOT NULL DEFAULT 2 CHECK(global_concurrency BETWEEN 1 AND 2),
        per_store_concurrency INTEGER NOT NULL DEFAULT 1 CHECK(per_store_concurrency=1),row_version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await client.query(`INSERT INTO wb_system_settings(settings_id,enabled,root_directory,timezone,global_concurrency)
        SELECT 'default',publish_enabled,import_root,timezone,LEAST(2,GREATEST(1,dispatch_concurrency))
        FROM wb_runtime_config WHERE config_id='default' ON CONFLICT(settings_id) DO NOTHING`);
      await client.query('ALTER TABLE wb_runtime_config DROP CONSTRAINT IF EXISTS wb_runtime_config_dispatch_concurrency_check');
      await client.query('ALTER TABLE wb_runtime_config ADD CONSTRAINT wb_runtime_config_dispatch_concurrency_check CHECK(dispatch_concurrency BETWEEN 1 AND 2)');
      await client.query(`CREATE TABLE wb_stores(
        id UUID PRIMARY KEY,store_alias TEXT NOT NULL UNIQUE CHECK(store_alias ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
        display_name TEXT NOT NULL,enabled BOOLEAN NOT NULL DEFAULT false,auto_publish_enabled BOOLEAN NOT NULL DEFAULT false,
        auto_publish_mode TEXT NOT NULL DEFAULT 'CREATE_ONLY' CHECK(auto_publish_mode IN ('CREATE_ONLY','COMPATIBLE_UPSERT')),
        default_preset_id UUID,active_credential_version_id UUID,credential_state TEXT NOT NULL DEFAULT 'MISSING'
          CHECK(credential_state IN ('MISSING','LEGACY_EXTERNAL','PENDING','ACTIVE')),
        seller_id TEXT NOT NULL DEFAULT '',seller_name TEXT NOT NULL DEFAULT '',permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
        warehouse_id TEXT NOT NULL DEFAULT '',warehouse_name TEXT NOT NULL DEFAULT '',account_currency TEXT NOT NULL DEFAULT 'CNY',
        max_daily_styles INTEGER NOT NULL DEFAULT 100 CHECK(max_daily_styles>0),
        preflight_status TEXT NOT NULL DEFAULT 'NOT_RUN' CHECK(preflight_status IN ('NOT_RUN','PENDING','PASSED','FAILED','STALE')),
        preflight_checked_at TIMESTAMPTZ,preflight_report JSONB NOT NULL DEFAULT '{}'::jsonb,
        preflight_error_code TEXT NOT NULL DEFAULT '',preflight_error_message TEXT NOT NULL DEFAULT '',
        config_version INTEGER NOT NULL DEFAULT 1,row_version INTEGER NOT NULL DEFAULT 1,last_dispatched_at TIMESTAMPTZ,
        archived_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await client.query(`CREATE UNIQUE INDEX wb_stores_active_seller_unique ON wb_stores(seller_id)
        WHERE archived_at IS NULL AND seller_id<>''`);
      await client.query(`INSERT INTO wb_stores(
        id,store_alias,display_name,enabled,auto_publish_enabled,warehouse_id,account_currency,max_daily_styles,
        credential_state,preflight_status)
        SELECT $1,$2,'现有WB店铺',publish_enabled,publish_enabled,warehouse_id,price_currency_expected,max_daily_styles,
          CASE WHEN credential_ready THEN 'LEGACY_EXTERNAL' ELSE 'MISSING' END,
          CASE WHEN credential_ready THEN 'STALE' ELSE 'NOT_RUN' END
        FROM wb_runtime_config WHERE config_id='default' ON CONFLICT(store_alias) DO NOTHING`, [WB_DEFAULT_STORE_ID, WB_DEFAULT_STORE_ALIAS]);
      await client.query(`CREATE TABLE wb_store_credential_versions(
        id UUID PRIMARY KEY,store_id UUID NOT NULL REFERENCES wb_stores(id) ON DELETE RESTRICT,version_no INTEGER NOT NULL CHECK(version_no>0),
        status TEXT NOT NULL CHECK(status IN ('PENDING','ACTIVE','RETIRED')),ciphertext TEXT NOT NULL,nonce TEXT NOT NULL,auth_tag TEXT NOT NULL,
        fingerprint TEXT NOT NULL,key_version INTEGER NOT NULL DEFAULT 1,validation_report JSONB NOT NULL DEFAULT '{}'::jsonb,
        validation_error_code TEXT NOT NULL DEFAULT '',validation_error_message TEXT NOT NULL DEFAULT '',validated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        activated_at TIMESTAMPTZ,retired_at TIMESTAMPTZ,UNIQUE(store_id,version_no))`);
      await client.query("CREATE UNIQUE INDEX wb_store_one_active_credential ON wb_store_credential_versions(store_id) WHERE status='ACTIVE'");
      await client.query("CREATE UNIQUE INDEX wb_store_one_pending_credential ON wb_store_credential_versions(store_id) WHERE status='PENDING'");
      await client.query(`CREATE TABLE wb_store_runtime_state(
        store_id UUID PRIMARY KEY REFERENCES wb_stores(id) ON DELETE CASCADE,network_attempt INTEGER NOT NULL DEFAULT 0 CHECK(network_attempt>=0),
        network_next_attempt_at TIMESTAMPTZ,network_last_error_code TEXT NOT NULL DEFAULT '',network_last_error_message TEXT NOT NULL DEFAULT '',
        network_updated_at TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await client.query('INSERT INTO wb_store_runtime_state(store_id) SELECT id FROM wb_stores ON CONFLICT(store_id) DO NOTHING');
      await client.query(`UPDATE wb_store_runtime_state state SET
        network_attempt=runtime.network_attempt,network_next_attempt_at=runtime.network_next_attempt_at,
        network_last_error_code=runtime.network_last_error_code,network_last_error_message=runtime.network_last_error_message,
        network_updated_at=runtime.network_updated_at
        FROM wb_runtime_config runtime WHERE state.store_id=$1 AND runtime.config_id='default'`, [WB_DEFAULT_STORE_ID]);
      await client.query(`CREATE TABLE wb_store_publications(
        id UUID PRIMARY KEY,sku CHAR(7) NOT NULL REFERENCES products(sku) ON DELETE RESTRICT,
        generated_version_id UUID NOT NULL REFERENCES wb_listing_versions(id) ON DELETE RESTRICT,revision INTEGER NOT NULL CHECK(revision>0),
        store_id UUID NOT NULL REFERENCES wb_stores(id) ON DELETE RESTRICT,store_alias_snapshot TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('PLANNED','DISPATCHING','QUEUED','RUNNING','SUCCEEDED','FAILED','NEEDS_ATTENTION','PAUSED')),
        source TEXT NOT NULL DEFAULT 'MANUAL' CHECK(source IN ('MANUAL','AUTOMATION')),preset_id UUID,preset_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        credential_version_id UUID REFERENCES wb_store_credential_versions(id) ON DELETE RESTRICT,task_id TEXT UNIQUE,
        config_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,nm_ids JSONB NOT NULL DEFAULT '[]'::jsonb,product_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
        result_json JSONB NOT NULL DEFAULT '{}'::jsonb,error_code TEXT NOT NULL DEFAULT '',error_message TEXT NOT NULL DEFAULT '',
        network_recovery JSONB NOT NULL DEFAULT '{}'::jsonb,row_version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ,
        UNIQUE(store_id,generated_version_id))`);
      await client.query('CREATE INDEX wb_store_publications_sku_updated ON wb_store_publications(sku,updated_at DESC)');
      await client.query('CREATE INDEX wb_store_publications_store_status ON wb_store_publications(store_id,status,updated_at DESC)');
      await client.query(`CREATE TABLE wb_gateway_requests(
        request_ref TEXT PRIMARY KEY,request_hash TEXT NOT NULL,task_id TEXT,publication_id UUID REFERENCES wb_store_publications(id) ON DELETE SET NULL,
        store_id UUID NOT NULL REFERENCES wb_stores(id) ON DELETE RESTRICT,credential_version_id UUID NOT NULL REFERENCES wb_store_credential_versions(id) ON DELETE RESTRICT,
        operation TEXT NOT NULL,delivery_state TEXT NOT NULL CHECK(delivery_state IN ('NOT_SENT','UNKNOWN','RESPONDED')),
        retry_class TEXT NOT NULL CHECK(retry_class IN ('NONE','READBACK_REQUIRED','RETRYABLE','PERMANENT')),retry_after_ms INTEGER,
        status_code INTEGER,response_json JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ)`);
      await client.query(`ALTER TABLE wb_publish_jobs
        ADD COLUMN store_id UUID NOT NULL DEFAULT '${WB_DEFAULT_STORE_ID}' REFERENCES wb_stores(id) ON DELETE RESTRICT,
        ADD COLUMN store_alias TEXT NOT NULL DEFAULT '${WB_DEFAULT_STORE_ALIAS}',
        ADD COLUMN publication_id UUID REFERENCES wb_store_publications(id) ON DELETE SET NULL,
        ADD COLUMN credential_version_id UUID REFERENCES wb_store_credential_versions(id) ON DELETE RESTRICT,
        ADD COLUMN store_config_version INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN warehouse_id TEXT NOT NULL DEFAULT ''`);
      await client.query(`UPDATE wb_publish_jobs SET store_id=$1,store_alias=$2,
        warehouse_id=COALESCE(NULLIF(warehouse_id,''),(SELECT warehouse_id FROM wb_stores WHERE id=$1))`, [WB_DEFAULT_STORE_ID, WB_DEFAULT_STORE_ALIAS]);
      await client.query('DROP INDEX IF EXISTS wb_publish_jobs_idempotency');
      await client.query("CREATE UNIQUE INDEX wb_publish_jobs_store_idempotency ON wb_publish_jobs(store_id,idempotency_key) WHERE idempotency_key<>''");
      await client.query('CREATE INDEX wb_publish_jobs_store_due ON wb_publish_jobs(store_id,state,next_run_at)');
      await client.query(`ALTER TABLE wb_publish_events
        ADD COLUMN store_id UUID NOT NULL DEFAULT '${WB_DEFAULT_STORE_ID}' REFERENCES wb_stores(id) ON DELETE RESTRICT,
        ADD COLUMN publication_id UUID REFERENCES wb_store_publications(id) ON DELETE SET NULL`);
      await client.query(`ALTER TABLE wb_product_registry
        ADD COLUMN store_id UUID NOT NULL DEFAULT '${WB_DEFAULT_STORE_ID}' REFERENCES wb_stores(id) ON DELETE RESTRICT,
        ADD COLUMN store_alias TEXT NOT NULL DEFAULT '${WB_DEFAULT_STORE_ALIAS}'`);
      await client.query(`DO $$ BEGIN
        IF EXISTS(SELECT 1 FROM wb_product_registry WHERE store_id IS NULL OR BTRIM(store_alias)='') THEN
          RAISE EXCEPTION 'wb_product_registry store backfill incomplete';
        END IF;
      END $$`);
      await client.query('ALTER TABLE wb_product_registry DROP CONSTRAINT IF EXISTS wb_product_registry_pkey');
      await client.query('ALTER TABLE wb_product_registry ADD PRIMARY KEY(store_id,registry_key)');
      await client.query('DROP INDEX IF EXISTS wb_product_registry_product');
      await client.query('CREATE INDEX wb_product_registry_store_product ON wb_product_registry(store_id,product_code)');
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('028_wb_multi_store_foundation')");
      await client.query('COMMIT');
    }
    const credentialValidation = await client.query("SELECT id FROM wb_schema_migrations WHERE id='031_wb_credential_validation_history'");
    if (!credentialValidation.rows[0]) {
      await client.query('BEGIN');
      await client.query(`ALTER TABLE wb_store_credential_versions
        ADD COLUMN IF NOT EXISTS validation_report JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS validation_error_code TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS validation_error_message TEXT NOT NULL DEFAULT '',
        ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ`);
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('031_wb_credential_validation_history')");
      await client.query('COMMIT');
    }
    const materialPresetIdentity = await client.query("SELECT id FROM wb_schema_migrations WHERE id='032_wb_material_preset_identity'");
    if (!materialPresetIdentity.rows[0]) {
      await client.query('BEGIN');
      await client.query('ALTER TABLE wb_listing_versions ADD COLUMN IF NOT EXISTS material_preset_definition_hash TEXT');
      await client.query('ALTER TABLE wb_store_publications ADD COLUMN IF NOT EXISTS preset_definition_hash TEXT');
      await client.query('CREATE INDEX IF NOT EXISTS wb_listing_versions_material_preset ON wb_listing_versions(material_preset_definition_hash) WHERE material_preset_definition_hash IS NOT NULL');
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('032_wb_material_preset_identity')");
      await client.query('COMMIT');
    }
    const storeAutoActivation = await client.query("SELECT id FROM wb_schema_migrations WHERE id='034_wb_store_auto_activation'");
    if (!storeAutoActivation.rows[0]) {
      await client.query('BEGIN');
      await client.query('ALTER TABLE wb_stores ADD COLUMN IF NOT EXISTS auto_publish_activated_at TIMESTAMPTZ');
      await client.query(`UPDATE wb_stores SET auto_publish_activated_at=created_at
        WHERE auto_publish_enabled=true AND auto_publish_activated_at IS NULL`);
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('034_wb_store_auto_activation')");
      await client.query('COMMIT');
    }
    const storeMaterialization = await client.query("SELECT id FROM wb_schema_migrations WHERE id='035_wb_store_publication_materialization'");
    if (!storeMaterialization.rows[0]) {
      await client.query('BEGIN');
      await client.query(`ALTER TABLE wb_listing_versions
        ADD COLUMN IF NOT EXISTS generation_scope TEXT NOT NULL DEFAULT 'LISTING',
        ADD COLUMN IF NOT EXISTS materialization_hash TEXT`);
      await client.query('ALTER TABLE wb_listing_versions DROP CONSTRAINT IF EXISTS wb_listing_versions_generation_scope_check');
      await client.query("ALTER TABLE wb_listing_versions ADD CONSTRAINT wb_listing_versions_generation_scope_check CHECK(generation_scope IN ('LISTING','STORE_PUBLICATION'))");
      await client.query(`ALTER TABLE wb_store_publications
        ADD COLUMN IF NOT EXISTS request_key TEXT,
        ADD COLUMN IF NOT EXISTS plan_hash TEXT,
        ADD COLUMN IF NOT EXISTS materialization_hash TEXT,
        ADD COLUMN IF NOT EXISTS package_rel_path TEXT,
        ADD COLUMN IF NOT EXISTS package_signature TEXT`);
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS wb_store_publications_request_key ON wb_store_publications(request_key) WHERE request_key IS NOT NULL');
      await client.query('CREATE INDEX IF NOT EXISTS wb_listing_versions_store_materialization ON wb_listing_versions(sku,generation_scope,revision DESC)');
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('035_wb_store_publication_materialization')");
      await client.query('COMMIT');
    }
    const cardUploadAttempts = await client.query("SELECT id FROM wb_schema_migrations WHERE id='037_wb_card_upload_attempts'");
    if (!cardUploadAttempts.rows[0]) {
      await client.query('BEGIN');
      await client.query(`ALTER TABLE wb_gateway_requests
        ADD COLUMN IF NOT EXISTS logical_intent_id TEXT,
        ADD COLUMN IF NOT EXISTS attempt_no INTEGER,
        ADD COLUMN IF NOT EXISTS transport_code TEXT,
        ADD COLUMN IF NOT EXISTS transport_phase TEXT`);
      await client.query(`DO $$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='wb_gateway_requests_card_attempt_pair'
          AND connamespace=(SELECT oid FROM pg_namespace WHERE nspname=current_schema())) THEN
          ALTER TABLE wb_gateway_requests ADD CONSTRAINT wb_gateway_requests_card_attempt_pair CHECK(
            (logical_intent_id IS NULL AND attempt_no IS NULL)
            OR (logical_intent_id IS NOT NULL AND attempt_no BETWEEN 1 AND 2)
          );
        END IF;
      END $$`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS wb_gateway_requests_logical_attempt_unique
        ON wb_gateway_requests(logical_intent_id,attempt_no) WHERE logical_intent_id IS NOT NULL`);
      await client.query(`CREATE INDEX IF NOT EXISTS wb_gateway_requests_task_card_history
        ON wb_gateway_requests(task_id,operation,created_at) WHERE operation='CARD_UPLOAD'`);
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('037_wb_card_upload_attempts')");
      await client.query('COMMIT');
    }
    const cardUploadRetryFencing = await client.query("SELECT id FROM wb_schema_migrations WHERE id='038_wb_card_upload_retry_fencing'");
    if (!cardUploadRetryFencing.rows[0]) {
      await client.query('BEGIN');
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS wb_gateway_requests_card_task_attempt_unique
        ON wb_gateway_requests(task_id,attempt_no)
        WHERE operation='CARD_UPLOAD' AND task_id IS NOT NULL AND attempt_no IS NOT NULL`);
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('038_wb_card_upload_retry_fencing')");
      await client.query('COMMIT');
    }
    const manualRetry = await client.query("SELECT id FROM wb_schema_migrations WHERE id='040_wb_manual_publish_retry'");
    if (!manualRetry.rows[0]) {
      await client.query('BEGIN');
      await migrateWbAutoRetry(client);
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('040_wb_manual_publish_retry')");
      await client.query('COMMIT');
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('pixroute_wb_schema_migrations'))").catch(() => undefined);
    client.release();
  }
}

export async function ensureWbAutoPublishStoreColumns(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('pixroute_wb_schema_migrations'))");
    const applied = await client.query("SELECT id FROM wb_schema_migrations WHERE id='029_wb_auto_publish_multi_store'");
    if (!applied.rows[0]) {
      await client.query('BEGIN');
    await client.query(`ALTER TABLE wb_auto_publish_jobs
      ADD COLUMN IF NOT EXISTS id UUID,
      ADD COLUMN IF NOT EXISTS store_id UUID NOT NULL DEFAULT '${WB_DEFAULT_STORE_ID}',
      ADD COLUMN IF NOT EXISTS publication_id UUID,
      ADD COLUMN IF NOT EXISTS store_config_version INTEGER NOT NULL DEFAULT 1`);
    await client.query('UPDATE wb_auto_publish_jobs SET id=gen_random_uuid() WHERE id IS NULL');
    await client.query('ALTER TABLE wb_auto_publish_jobs ALTER COLUMN id SET NOT NULL');
    await client.query(`DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM wb_auto_publish_jobs WHERE store_id IS NULL OR id IS NULL) THEN
        RAISE EXCEPTION 'wb_auto_publish_jobs store backfill incomplete';
      END IF;
    END $$`);
    await client.query('ALTER TABLE wb_auto_publish_events DROP CONSTRAINT IF EXISTS wb_auto_publish_events_sku_fkey');
    await client.query('ALTER TABLE wb_auto_publish_jobs DROP CONSTRAINT IF EXISTS wb_auto_publish_jobs_pkey');
    await client.query('ALTER TABLE wb_auto_publish_jobs ADD PRIMARY KEY(id)');
    await client.query('CREATE UNIQUE INDEX wb_auto_publish_jobs_store_sku ON wb_auto_publish_jobs(store_id,sku)');
    await client.query(`ALTER TABLE wb_auto_publish_events
      ADD COLUMN IF NOT EXISTS job_id UUID,
      ADD COLUMN IF NOT EXISTS store_id UUID NOT NULL DEFAULT '${WB_DEFAULT_STORE_ID}',
      ADD COLUMN IF NOT EXISTS publication_id UUID`);
    await client.query(`UPDATE wb_auto_publish_events event SET job_id=job.id,store_id=job.store_id
      FROM wb_auto_publish_jobs job WHERE event.sku=job.sku AND event.store_id=job.store_id AND event.job_id IS NULL`);
    await client.query('ALTER TABLE wb_auto_publish_events ALTER COLUMN job_id SET NOT NULL');
    await client.query('ALTER TABLE wb_auto_publish_events ADD CONSTRAINT wb_auto_publish_events_job_id_fkey FOREIGN KEY(job_id) REFERENCES wb_auto_publish_jobs(id) ON DELETE CASCADE');
    await client.query('DROP INDEX IF EXISTS wb_auto_publish_events_delivery_unique');
    await client.query("CREATE UNIQUE INDEX wb_auto_publish_events_delivery_unique ON wb_auto_publish_events(job_id,event_type,(details->>'submissionId')) WHERE event_type='MEDIA_DELIVERED'");
    await client.query('DROP INDEX IF EXISTS wb_auto_publish_events_sku_time');
    await client.query('CREATE INDEX wb_auto_publish_events_job_time ON wb_auto_publish_events(job_id,created_at DESC)');
    await client.query(`ALTER TABLE wb_auto_publish_job_runs
      ADD COLUMN IF NOT EXISTS job_id UUID,
      ADD COLUMN IF NOT EXISTS store_id UUID NOT NULL DEFAULT '${WB_DEFAULT_STORE_ID}',
      ADD COLUMN IF NOT EXISTS publication_id UUID`);
    await client.query(`UPDATE wb_auto_publish_job_runs run SET job_id=job.id,store_id=job.store_id
      FROM wb_auto_publish_jobs job WHERE run.sku=job.sku AND run.store_id=job.store_id AND run.job_id IS NULL`);
    await client.query('ALTER TABLE wb_auto_publish_job_runs DROP CONSTRAINT IF EXISTS wb_auto_publish_job_runs_sku_run_no_key');
    await client.query('CREATE UNIQUE INDEX wb_auto_publish_job_runs_store_sku_run ON wb_auto_publish_job_runs(store_id,sku,run_no)');
    await client.query('CREATE INDEX wb_auto_publish_jobs_store_state ON wb_auto_publish_jobs(store_id,state,next_attempt_at)');
    await client.query("INSERT INTO wb_schema_migrations(id) VALUES('029_wb_auto_publish_multi_store')");
      await client.query('COMMIT');
    }
    const constraints = await client.query("SELECT id FROM wb_schema_migrations WHERE id='030_wb_auto_publish_store_constraints'");
    if (!constraints.rows[0]) {
      await client.query('BEGIN');
      await client.query(`DO $$ BEGIN
        IF to_regclass(current_schema()||'.wb_stores') IS NOT NULL THEN
          IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='wb_auto_publish_jobs_store_id_fkey'
            AND connamespace=(SELECT oid FROM pg_namespace WHERE nspname=current_schema())) THEN
            ALTER TABLE wb_auto_publish_jobs ADD CONSTRAINT wb_auto_publish_jobs_store_id_fkey
              FOREIGN KEY(store_id) REFERENCES wb_stores(id) ON DELETE RESTRICT;
          END IF;
          IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='wb_auto_publish_events_store_id_fkey'
            AND connamespace=(SELECT oid FROM pg_namespace WHERE nspname=current_schema())) THEN
            ALTER TABLE wb_auto_publish_events ADD CONSTRAINT wb_auto_publish_events_store_id_fkey
              FOREIGN KEY(store_id) REFERENCES wb_stores(id) ON DELETE RESTRICT;
          END IF;
          IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='wb_auto_publish_job_runs_store_id_fkey'
            AND connamespace=(SELECT oid FROM pg_namespace WHERE nspname=current_schema())) THEN
            ALTER TABLE wb_auto_publish_job_runs ADD CONSTRAINT wb_auto_publish_job_runs_store_id_fkey
              FOREIGN KEY(store_id) REFERENCES wb_stores(id) ON DELETE RESTRICT;
          END IF;
        END IF;
        IF to_regclass(current_schema()||'.wb_store_publications') IS NOT NULL THEN
          IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='wb_auto_publish_jobs_publication_id_fkey'
            AND connamespace=(SELECT oid FROM pg_namespace WHERE nspname=current_schema())) THEN
            ALTER TABLE wb_auto_publish_jobs ADD CONSTRAINT wb_auto_publish_jobs_publication_id_fkey
              FOREIGN KEY(publication_id) REFERENCES wb_store_publications(id) ON DELETE SET NULL;
          END IF;
          IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='wb_auto_publish_events_publication_id_fkey'
            AND connamespace=(SELECT oid FROM pg_namespace WHERE nspname=current_schema())) THEN
            ALTER TABLE wb_auto_publish_events ADD CONSTRAINT wb_auto_publish_events_publication_id_fkey
              FOREIGN KEY(publication_id) REFERENCES wb_store_publications(id) ON DELETE SET NULL;
          END IF;
          IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='wb_auto_publish_job_runs_publication_id_fkey'
            AND connamespace=(SELECT oid FROM pg_namespace WHERE nspname=current_schema())) THEN
            ALTER TABLE wb_auto_publish_job_runs ADD CONSTRAINT wb_auto_publish_job_runs_publication_id_fkey
              FOREIGN KEY(publication_id) REFERENCES wb_store_publications(id) ON DELETE SET NULL;
          END IF;
        END IF;
        IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='wb_auto_publish_job_runs_job_id_fkey'
          AND connamespace=(SELECT oid FROM pg_namespace WHERE nspname=current_schema())) THEN
          ALTER TABLE wb_auto_publish_job_runs ADD CONSTRAINT wb_auto_publish_job_runs_job_id_fkey
            FOREIGN KEY(job_id) REFERENCES wb_auto_publish_jobs(id) ON DELETE CASCADE;
        END IF;
      END $$`);
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('030_wb_auto_publish_store_constraints')");
      await client.query('COMMIT');
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('pixroute_wb_schema_migrations'))").catch(() => undefined);
    client.release();
  }
}

function storeSelect(): string {
  return `SELECT s.*,settings.enabled system_enabled,settings.root_directory,
    active.id active_credential_id,active.version_no active_credential_version,active.fingerprint active_credential_fingerprint,
    active.created_at active_credential_updated_at,
    pending.id pending_credential_id,pending.version_no pending_credential_version,pending.fingerprint pending_credential_fingerprint,
    pending.created_at pending_credential_updated_at,
    runtime.network_attempt,runtime.network_next_attempt_at,runtime.network_last_error_code,runtime.network_last_error_message,
    COALESCE(tasks.active_count,0) active_task_count,COALESCE(tasks.queued_count,0) queued_task_count
    FROM wb_stores s JOIN wb_system_settings settings ON settings.settings_id='default'
    LEFT JOIN wb_store_credential_versions active ON active.id=s.active_credential_version_id AND active.status='ACTIVE'
    LEFT JOIN wb_store_credential_versions pending ON pending.store_id=s.id AND pending.status='PENDING'
    LEFT JOIN wb_store_runtime_state runtime ON runtime.store_id=s.id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER(WHERE j.lease_owner<>'' AND j.lease_expires_at>NOW()) active_count,
        COUNT(*) FILTER(WHERE j.state NOT IN ('SUCCEEDED','FAILED','BLOCKED_AUTH','BLOCKED_CONFIG','BLOCKED_SCHEMA','BLOCKED_COMPLIANCE','BLOCKED_EXISTING_CARD')
          AND (j.lease_owner='' OR j.lease_expires_at IS NULL OR j.lease_expires_at<=NOW())) queued_count
      FROM wb_publish_jobs j WHERE j.store_id=s.id
    ) tasks ON true`;
}

async function getStoreWith(client: PoolClient, storeId: string, includeArchived = false): Promise<WbStore> {
  const result = await client.query<SqlRow>(`${storeSelect()} WHERE s.id=$1 ${includeArchived ? '' : 'AND s.archived_at IS NULL'} LIMIT 1`, [storeId]);
  if (!result.rows[0]) throw new AppError('NOT_FOUND', 'WB 店铺不存在', { storeId }, 404);
  return toStore(result.rows[0]);
}

function toSettings(row: SqlRow): WbSystemSettings {
  return {
    enabled: Boolean(row.enabled), rootDirectory: String(row.root_directory || ''),
    timezone: String(row.timezone || 'Asia/Shanghai'), globalConcurrency: Number(row.global_concurrency || 1),
    perStoreConcurrency: WB_PER_STORE_CONCURRENCY, rowVersion: Number(row.row_version || 1),
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString()
  };
}

function toStore(row: SqlRow): WbStore {
  const pending = Boolean(row.pending_credential_id);
  const active = Boolean(row.active_credential_id);
  const credentialState = pending ? 'PENDING' : active ? 'ACTIVE' : row.credential_state === 'LEGACY_EXTERNAL' ? 'LEGACY_EXTERNAL' : 'MISSING';
  const preflightDetails = asObject(asObject(row.preflight_report).details);
  const currencyVerification = String(preflightDetails.currencyVerification || '');
  const blockers = [
    ...(row.archived_at ? ['店铺已归档'] : []),
    ...(!row.system_enabled ? ['WB 全局上品未启用'] : []),
    ...(!row.enabled ? ['店铺未启用'] : []),
    ...(!row.root_directory ? ['WB 全局根目录未配置'] : []),
    ...(credentialState === 'LEGACY_EXTERNAL' ? ['旧 Token 仍在 n8n Credential，请在 WB上品设置中重新录入'] : []),
    ...(!active ? ['店铺 Token 尚未通过预检并激活'] : []),
    ...(String(row.preflight_status) !== 'PASSED' ? ['店铺预检未通过或已过期'] : []),
    ...(!row.seller_id ? ['Seller 身份未确认'] : []),
    ...(!row.warehouse_id ? ['店铺仓库未配置'] : []),
    ...(String(row.account_currency || '').toUpperCase() !== 'CNY' ? ['当前版本只支持 CNY 店铺'] : []),
    ...(!row.default_preset_id ? ['店铺默认上品预设未配置'] : [])
  ];
  return {
    id: String(row.id), storeAlias: String(row.store_alias), displayName: String(row.display_name),
    enabled: Boolean(row.enabled), autoPublishEnabled: Boolean(row.auto_publish_enabled),
    ...(row.auto_publish_activated_at ? { autoPublishActivatedAt: new Date(row.auto_publish_activated_at).toISOString() } : {}),
    autoPublishMode: row.auto_publish_mode === 'COMPATIBLE_UPSERT' ? 'COMPATIBLE_UPSERT' : 'CREATE_ONLY',
    ...(row.default_preset_id ? { defaultPresetId: String(row.default_preset_id) } : {}),
    warehouseId: String(row.warehouse_id || ''), warehouseName: String(row.warehouse_name || ''),
    accountCurrency: String(row.account_currency || 'CNY'), maxDailyStyles: Number(row.max_daily_styles || 100),
    credential: {
      state: credentialState, configured: active || pending,
      ...(active ? { activeVersionId: String(row.active_credential_id) } : {}),
      ...(pending ? { pendingVersionId: String(row.pending_credential_id) } : {}),
      ...((pending || active) ? {
        fingerprint: String(pending ? row.pending_credential_fingerprint : row.active_credential_fingerprint),
        version: Number(pending ? row.pending_credential_version : row.active_credential_version),
        updatedAt: new Date(pending ? row.pending_credential_updated_at : row.active_credential_updated_at).toISOString()
      } : {})
    },
    seller: { ...(row.seller_id ? { id: String(row.seller_id) } : {}), ...(row.seller_name ? { name: String(row.seller_name) } : {}) },
    permissions: Array.isArray(row.permissions) ? row.permissions.map(String) : [],
    preflight: {
      status: ['NOT_RUN', 'PENDING', 'PASSED', 'FAILED', 'STALE'].includes(String(row.preflight_status)) ? row.preflight_status : 'NOT_RUN',
      ...(currencyVerification === 'VERIFIED' || currencyVerification === 'DEFERRED_EMPTY_CATALOG'
        ? { currencyVerification: currencyVerification as 'VERIFIED' | 'DEFERRED_EMPTY_CATALOG' }
        : {}),
      ...(typeof preflightDetails.currencyVerified === 'boolean'
        ? { currencyVerified: preflightDetails.currencyVerified }
        : {}),
      ...(row.preflight_checked_at ? { checkedAt: new Date(row.preflight_checked_at).toISOString() } : {}),
      ...(row.preflight_error_code ? { errorCode: String(row.preflight_error_code) } : {}),
      ...(row.preflight_error_message ? { errorMessage: String(row.preflight_error_message) } : {})
    },
    network: {
      status: row.network_next_attempt_at && new Date(row.network_next_attempt_at).getTime() > Date.now() ? 'WAITING'
        : row.network_last_error_code ? 'ERROR' : 'READY',
      ...(row.network_next_attempt_at ? { nextAttemptAt: new Date(row.network_next_attempt_at).toISOString() } : {}),
      ...(row.network_last_error_code ? { errorCode: String(row.network_last_error_code) } : {}),
      ...(row.network_last_error_message ? { errorMessage: String(row.network_last_error_message) } : {})
    },
    readiness: { ready: blockers.length === 0, blockers: [...new Set(blockers)] },
    activeTaskCount: Number(row.active_task_count || 0), queuedTaskCount: Number(row.queued_task_count || 0),
    configVersion: Number(row.config_version || 1), rowVersion: Number(row.row_version || 1),
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    ...(row.archived_at ? { archivedAt: new Date(row.archived_at).toISOString() } : {})
  };
}

function toPublication(row: SqlRow): WbStorePublication {
  const configSnapshot = asObject(row.config_snapshot);
  const presetSnapshot = asObject(row.preset_snapshot);
  const presetName = String(row.preset_name || presetSnapshot.name || '').trim();
  const presetRowVersion = Number(row.preset_row_version || configSnapshot.presetRowVersion || 0);
  const operationMode = String(row.operation_mode || configSnapshot.autoPublishMode || configSnapshot.operationMode || '');
  const draftVersion = Number(row.publication_draft_version || configSnapshot.draftVersion || 0);
  const productUrls = Array.isArray(row.product_urls) ? row.product_urls.map(String) : [];
  return {
    id: String(row.id), sku: String(row.sku), generatedVersionId: String(row.generated_version_id),
    storeId: String(row.store_id), storeAlias: String(row.store_alias_snapshot),
    ...(row.store_display_name ? { storeDisplayName: String(row.store_display_name) } : {}),
    status: row.status, source: row.source === 'AUTOMATION' ? 'AUTOMATION' : 'MANUAL',
    ...(row.task_id ? { taskId: String(row.task_id) } : {}), revision: Number(row.revision),
    ...(row.preset_id ? { presetId: String(row.preset_id) } : {}),
    ...(presetName ? { presetName } : {}),
    ...(presetRowVersion > 0 ? { presetRowVersion } : {}),
    ...(['CREATE_ONLY', 'COMPATIBLE_UPSERT'].includes(operationMode)
      ? { operationMode: operationMode as 'CREATE_ONLY' | 'COMPATIBLE_UPSERT' } : {}),
    ...(draftVersion > 0 ? { draftVersion } : {}),
    ...(typeof row.source_preset_exists === 'boolean' ? { sourcePresetExists: row.source_preset_exists } : {}),
    presetDefinitionHash: String(row.preset_definition_hash || ''),
    ...(row.plan_hash ? { planHash: String(row.plan_hash) } : {}),
    ...(row.materialization_hash ? { materializationHash: String(row.materialization_hash) } : {}),
    ...(row.package_rel_path ? { packageRelPath: String(row.package_rel_path) } : {}),
    ...(row.package_signature ? { packageSignature: String(row.package_signature) } : {}),
    configSnapshot,
    ...(row.credential_version_id ? { credentialVersionId: String(row.credential_version_id) } : {}),
    nmIds: normalizeIdentifiers(row.nm_ids), productUrls,
    ...(row.product_link_identities !== undefined
      ? { productLinks: normalizePublicationProductLinks(row.product_link_identities, productUrls) } : {}),
    result: asObject(row.result_json),
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
    ...(row.error_message ? { errorMessage: String(row.error_message) } : {}),
    rowVersion: Number(row.row_version || 1), createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    ...(row.completed_at ? { completedAt: new Date(row.completed_at).toISOString() } : {})
  };
}

function normalizeWbSku(value: unknown): string {
  const sku = String(value || '').trim();
  if (!/^\d{7}$/.test(sku)) throw new AppError('CONFIG_INVALID', 'SKU 必须是 7 位数字字符串');
  return sku;
}

function normalizeAutomationMaterializationInput(
  input: WbAutomationMaterializedPublicationInsert
): WbAutomationMaterializedPublicationInsert & {
  presetSnapshot: JsonRecord;
  existingCardBaseline: JsonRecord[];
} {
  const sku = normalizeWbSku(input.sku);
  const uuidFields = [
    ['sourceGeneratedVersionId', input.sourceGeneratedVersionId],
    ['storeId', input.storeId],
    ['presetId', input.presetId],
    ['automationRunId', input.automationRunId],
    ...(input.credentialVersionId ? [['credentialVersionId', input.credentialVersionId]] : [])
  ] as Array<[string, unknown]>;
  for (const [field, value] of uuidFields) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''))) {
      throw new AppError('CONFIG_INVALID', `WB 自动物化 ${field} 必须是 UUID`, { field }, 400);
    }
  }
  const storeAlias = String(input.storeAlias || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(storeAlias)) {
    throw new AppError('CONFIG_INVALID', 'WB 自动物化 storeAlias 格式无效', { storeAlias }, 400);
  }
  const positiveIntegers = [
    ['storeRowVersion', input.storeRowVersion],
    ['storeConfigVersion', input.storeConfigVersion],
    ['automationRunNo', input.automationRunNo]
  ] as Array<[string, unknown]>;
  for (const [field, value] of positiveIntegers) {
    if (!Number.isInteger(Number(value)) || Number(value) < 1) {
      throw new AppError('CONFIG_INVALID', `WB 自动物化 ${field} 必须是正整数`, { field }, 400);
    }
  }
  const warehouseId = String(input.warehouseId || '').trim();
  if (!warehouseId) throw new AppError('CONFIG_INVALID', 'WB 自动物化 warehouseId 必填', undefined, 400);
  if (!['CREATE_ONLY', 'COMPATIBLE_UPSERT'].includes(String(input.operationMode))) {
    throw new AppError('CONFIG_INVALID', 'WB 自动物化 operationMode 无效', { operationMode: input.operationMode }, 400);
  }
  const presetDefinitionHash = String(input.presetDefinitionHash || '').trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(presetDefinitionHash)) {
    throw new AppError('CONFIG_INVALID', 'WB 自动物化预设哈希格式无效', undefined, 400);
  }
  const mediaTargetVendorCodes = [...new Set((input.mediaTargetVendorCodes || []).map((value) => String(value || '').trim()))].sort();
  if (!mediaTargetVendorCodes.length
    || mediaTargetVendorCodes.some((value) => !/^[A-Za-z0-9._-]+$/.test(value))) {
    throw new AppError('CONFIG_INVALID', 'WB 自动物化媒体目标卖家商品编码无效', undefined, 400);
  }
  const existingCardBaseline = (input.existingCardBaseline || []).map((value) => {
    const row = asObject(value);
    const vendorCode = String(row.vendorCode || '').trim();
    const nmID = String(row.nmID || row.nmId || '').trim();
    const imtID = String(row.imtID || row.imtId || '').trim();
    const subjectID = String(row.subjectID || row.subjectId || '').trim();
    if (!/^[A-Za-z0-9._-]+$/.test(vendorCode) || !/^[1-9]\d*$/.test(nmID)
      || (imtID && !/^[1-9]\d*$/.test(imtID)) || (subjectID && !/^[1-9]\d*$/.test(subjectID))) {
      throw new AppError('CONFIG_INVALID', 'WB 自动物化既有商品基线无效', { vendorCode }, 400);
    }
    return {
      vendorCode,
      nmID,
      ...(imtID ? { imtID } : {}),
      ...(subjectID ? { subjectID } : {})
    };
  }).sort((left, right) => String(left.vendorCode).localeCompare(String(right.vendorCode)));
  if (new Set(existingCardBaseline.map((row) => row.vendorCode)).size !== existingCardBaseline.length) {
    throw new AppError('CONFIG_INVALID', 'WB 自动物化既有商品基线卖家商品编码不能重复', undefined, 400);
  }
  return {
    ...input,
    sku,
    sourceGeneratedVersionId: String(input.sourceGeneratedVersionId).toLowerCase(),
    storeId: String(input.storeId).toLowerCase(),
    storeAlias,
    storeRowVersion: Number(input.storeRowVersion),
    storeConfigVersion: Number(input.storeConfigVersion),
    warehouseId,
    ...(input.credentialVersionId ? { credentialVersionId: String(input.credentialVersionId).toLowerCase() } : {}),
    presetId: String(input.presetId).toLowerCase(),
    presetSnapshot: asObject(input.presetSnapshot),
    presetDefinitionHash,
    automationRunId: String(input.automationRunId).toLowerCase(),
    automationRunNo: Number(input.automationRunNo),
    mediaTargetVendorCodes,
    existingCardBaseline
  };
}

function assertAutomationPublicationIdentity(
  row: SqlRow,
  input: WbAutomationMaterializedPublicationInsert,
  requestKey: string
): void {
  const snapshot = asObject(row.config_snapshot);
  if (String(row.request_key || '') !== requestKey
    || String(row.source || '') !== 'AUTOMATION'
    || String(row.sku || '').trim() !== input.sku
    || String(row.store_id || '') !== input.storeId
    || String(snapshot.automationRunId || '') !== input.automationRunId) {
    throw new AppError('VERSION_CONFLICT', 'WB 自动物化幂等键已绑定到不同发布身份', {
      requestKey,
      publicationId: row.id
    }, 409);
  }
}

function assertStrictAutomationMaterialization(
  row: SqlRow,
  input: { sku: string; automationRunId: string; storeId: string },
  requestKey: string
): void {
  const snapshot = asObject(row.config_snapshot);
  const materializationHash = String(row.materialization_hash || '');
  const sourceGeneratedVersionId = String(snapshot.sourceGeneratedVersionId || '');
  const valid = String(row.request_key || '') === requestKey
    && String(row.source || '') === 'AUTOMATION'
    && String(row.sku || '').trim() === input.sku
    && String(row.store_id || '') === input.storeId
    && String(snapshot.automationRunId || '') === input.automationRunId
    && Boolean(sourceGeneratedVersionId)
    && String(row.publication_generation_scope || '') === 'STORE_PUBLICATION'
    && String(row.publication_version_status || '') === 'GENERATED'
    && String(row.publication_version_sku || '').trim() === input.sku
    && /^sha256:[a-f0-9]{64}$/.test(materializationHash)
    && String(row.publication_version_materialization_hash || '') === materializationHash
    && String(row.source_version_id || '') === sourceGeneratedVersionId
    && String(row.source_generation_scope || '') === 'LISTING'
    && String(row.source_version_status || '') === 'GENERATED'
    && String(row.source_version_sku || '').trim() === input.sku;
  if (!valid) {
    throw new AppError('VERSION_CONFLICT', 'WB 自动发布记录缺少可验证的 STORE_PUBLICATION 冻结证据', {
      requestKey,
      publicationId: row.id,
      sku: input.sku,
      storeId: input.storeId,
      automationRunId: input.automationRunId,
      sourceGeneratedVersionId: sourceGeneratedVersionId || null,
      generationScope: row.publication_generation_scope || null,
      materializationHash: materializationHash || null
    }, 409);
  }
}

export async function syncPublicationFromRuntime(client: PoolClient, job: SqlRow): Promise<void> {
  if (!job.publication_id) return;
  const state = String(job.state || '').toUpperCase();
  const status = state === 'SUCCEEDED' ? 'SUCCEEDED'
    : state === 'FAILED' ? 'FAILED'
      : state.startsWith('BLOCKED_') ? 'NEEDS_ATTENTION'
        : state === 'QUEUED' || state === 'RETRY_WAIT' ? 'QUEUED' : 'RUNNING';
  const result = asObject(job.result_json);
  const nmIds = collectNmIds(result);
  const productUrls = nmIds.map((nmId) => `https://www.wildberries.ru/catalog/${String(nmId)}/detail.aspx`);
  const terminal = ['SUCCEEDED', 'FAILED', 'NEEDS_ATTENTION'].includes(status);
  await client.query(`UPDATE wb_store_publications SET status=$2,nm_ids=$3::jsonb,product_urls=$4::jsonb,
    result_json=$5::jsonb,error_code=$6,error_message=$7,row_version=row_version+1,updated_at=NOW(),
    completed_at=CASE WHEN $8 THEN COALESCE(completed_at,NOW()) ELSE NULL END
    WHERE id=$1`, [job.publication_id, status, JSON.stringify(nmIds), JSON.stringify(productUrls), JSON.stringify(result),
    String(job.last_error_code || ''), String(job.last_error_message || '').slice(0, 4_000), terminal]);
}

function collectNmIds(value: unknown, output = new Set<string>()): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectNmIds(item, output);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as JsonRecord)) {
      if (/^nm_?ids?$/i.test(key)) {
        const values = Array.isArray(child) ? child : [child];
        for (const candidate of values) {
          const normalized = typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0
            ? String(candidate) : typeof candidate === 'string' && /^\d+$/.test(candidate.trim()) ? candidate.trim() : undefined;
          if (normalized !== undefined) output.add(normalized);
        }
      } else collectNmIds(child, output);
    }
  }
  return [...output];
}

function normalizeIdentifiers(value: unknown): Array<string | number> {
  const output = new Set<string>();
  for (const candidate of Array.isArray(value) ? value : []) {
    const normalized = typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0
      ? String(candidate) : typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
    if (normalized !== undefined) output.add(normalized);
  }
  return [...output];
}

function normalizePublicationProductLinks(
  identities: unknown,
  productUrls: string[]
): Array<{ nmId: string; url: string; variantCode?: string }> {
  const variantsByNmId = new Map<string, Set<string>>();
  if (Array.isArray(identities)) {
    for (const item of identities) {
      const identity = asObject(item);
      const nmId = String(identity.nmId || '').trim();
      const variantCode = String(identity.variantCode || '').trim();
      if (!/^\d+$/.test(nmId) || !variantCode) continue;
      const variants = variantsByNmId.get(nmId) || new Set<string>();
      variants.add(variantCode);
      variantsByNmId.set(nmId, variants);
    }
  }

  const seenUrls = new Set<string>();
  const seenNmIds = new Set<string>();
  return productUrls.flatMap((value) => {
    const url = String(value || '').trim();
    const nmId = wbNmIdFromProductUrl(url);
    if (!nmId || seenUrls.has(url) || seenNmIds.has(nmId)) return [];
    seenUrls.add(url);
    seenNmIds.add(nmId);
    const variants = variantsByNmId.get(nmId);
    return [{
      nmId,
      url,
      ...(variants?.size === 1 ? { variantCode: [...variants][0]! } : {})
    }];
  });
}

function wbNmIdFromProductUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:'
      || (url.hostname !== 'wildberries.ru' && !url.hostname.endsWith('.wildberries.ru'))) return undefined;
    return url.pathname.match(/^\/catalog\/(\d+)(?:\/|$)/)?.[1];
  } catch {
    return undefined;
  }
}

async function resolveGeneratedVersionMaterialHashWithClient(
  client: PoolClient,
  generatedVersionId: string,
  storedHash: unknown,
  listingData: unknown
): Promise<string> {
  const current = String(storedHash || '').trim();
  if (current) return current;
  const derived = wbMaterialPresetDefinitionHashFromListingData(listingData);
  if (!derived) {
    throw new AppError('PRESET_VERSION_MISMATCH', '该 product.json 缺少生成预设定义快照，请重新生成后再发布', {
      generatedVersionId
    }, 409);
  }
  const updated = await client.query<{ material_preset_definition_hash: string }>(`UPDATE wb_listing_versions
    SET material_preset_definition_hash=$2,updated_at=NOW()
    WHERE id=$1 AND material_preset_definition_hash IS NULL
    RETURNING material_preset_definition_hash`, [generatedVersionId, derived]);
  if (updated.rows[0]) return String(updated.rows[0].material_preset_definition_hash);
  const readback = await client.query<{ material_preset_definition_hash: string }>(
    'SELECT material_preset_definition_hash FROM wb_listing_versions WHERE id=$1',
    [generatedVersionId]
  );
  const persisted = String(readback.rows[0]?.material_preset_definition_hash || '');
  if (persisted !== derived) {
    throw new AppError('PRESET_VERSION_MISMATCH', 'product.json 生成预设定义发生并发变化，已拒绝发布', {
      generatedVersionId
    }, 409);
  }
  return persisted;
}

function assertRowVersion(expected: number, actual: unknown, subject: string): void {
  if (expected !== Number(actual)) throw new AppError('VERSION_CONFLICT', `${subject}已被其他操作修改，请刷新后重试`, { expected, actual: Number(actual) }, 409);
}

function asObject(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as JsonRecord;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
