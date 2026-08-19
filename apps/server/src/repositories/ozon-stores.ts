import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import {
  AppError,
  OZON_DEFAULT_STORE_ALIAS,
  OZON_DEFAULT_STORE_ID,
  OZON_PER_STORE_CONCURRENCY,
  OZON_PREFLIGHT_DUE_HOURS,
  OZON_PREFLIGHT_TTL_HOURS,
  OZON_SHARED_MATERIAL_HASH_VERSION,
  ozonProductUrl,
  ozonPresetInputSchema,
  ozonRuntimeClaimJobSchema,
  type OzonCredentialBindingMode,
  type OzonGatewayDeliveryState,
  type OzonGatewayLegacyReceipt,
  type OzonGatewayRetryClass,
  type OzonIntakeVerify,
  type OzonListingDraft,
  type OzonPlatformOfferStatus,
  type OzonProductMapping,
  type OzonPublicationTaskDetail,
  type OzonPublicationTaskSummary,
  type OzonProductLink,
  type OzonPublishEvent,
  type OzonPublishJob,
  type OzonRuntimeClaimJob,
  type OzonStore,
  type OzonStoreCreate,
  type OzonStorePreflightReport,
  type OzonStorePublication,
  type OzonStoreSystemSettings,
  type OzonStoreSystemSettingsPatch,
  type OzonStoreUpdate
} from '@n8n-media-review/shared';
import type { OzonEncryptedCredentialPair } from '../services/ozon-stores/token-vault.js';

type SqlRow = Record<string, any>;
type JsonRecord = Record<string, unknown>;

const ACTIVE_JOB_STATES = [
  'WAITING_MEDIA', 'READY', 'UPLOADING_MEDIA', 'SUBMITTING', 'IMPORTING', 'VERIFYING_IMAGES',
  'UPDATING_PRICE', 'UPDATING_STOCK', 'MODERATING'
] as const;
const CLAIMABLE_JOB_STATES = [
  'READY', 'UPLOADING_MEDIA', 'SUBMITTING', 'IMPORTING', 'VERIFYING_IMAGES',
  'UPDATING_PRICE', 'UPDATING_STOCK', 'MODERATING'
] as const;
const NONTERMINAL_PUBLICATION_STATES = ['PLANNED', 'MATERIALIZED', 'QUEUED', 'RUNNING', 'NEEDS_ATTENTION', 'PAUSED'] as const;
const LEGACY_WRITE_OPERATIONS = new Set(['importProduct', 'picturesImport', 'pricesWrite', 'stocksWrite', 'attributesUpdate']);
const PUBLICATION_READBACK_HOLD_MS = 10 * 60_000;
const OZON_PREFLIGHT_REPORT_TIMEOUT_CODE = 'OZON_PREFLIGHT_REPORT_TIMEOUT';
const OZON_PREFLIGHT_REPORT_TIMEOUT_MESSAGE = '预检任务在租约期限内未回写结果';
const OZON_PREFLIGHT_DISPATCH_REJECTED_CODE = 'OZON_PREFLIGHT_DISPATCH_REJECTED';
const OZON_PREFLIGHT_DISPATCH_REJECTED_MESSAGE = '预检 Webhook 明确未受理请求';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OZON_RUNTIME_WRITE_SLOT_KEY = 'OZON_WRITE';

export function evaluateOzonPreflightCurrency(
  configuredCurrency: OzonStore['accountCurrency'],
  verification: OzonStorePreflightReport['currencyVerification']
) {
  const observedCurrency = verification.status === 'VERIFIED' ? verification.currency : undefined;
  if (!observedCurrency) {
    return {
      verified: false,
      mismatch: false,
      errorCode: 'OZON_CURRENCY_NOT_VERIFIED',
      errorMessage: '店铺币种尚未取得可验证证据'
    } as const;
  }
  if (observedCurrency !== configuredCurrency) {
    return {
      verified: false,
      mismatch: true,
      observedCurrency,
      errorCode: 'OZON_CURRENCY_MISMATCH',
      errorMessage: `OZON 账户验证币种 ${observedCurrency} 与店铺配置 ${configuredCurrency} 不一致，请在店铺设置中选择实际账户币种后重新检查`
    } as const;
  }
  return { verified: true, mismatch: false, observedCurrency } as const;
}

export type OzonStoreCredentialRecord = OzonEncryptedCredentialPair & {
  id: string;
  storeId: string;
  version: number;
  status: 'PENDING' | 'ACTIVE' | 'RETIRED';
};

export type OzonPublicationPlanningContext = {
  sku: string;
  draftVersion: number;
  generatedVersionId: string;
  revision: number;
  contentPolicyVersion: string;
  materialHash: string;
  materialHashVersion: string;
  sourceMediaIdentityHash: string;
  listingStatus: string;
  listingSnapshot: JsonRecord;
  basePresetId?: string;
  basePresetSnapshot?: JsonRecord;
  materialOverrides: JsonRecord;
  offerIds: string[];
  stores: Array<OzonStore & { presetSnapshot?: JsonRecord; presetRowVersion?: number; presetName?: string }>;
};

export type OzonAutomaticListingSnapshotContext = {
  job: {
    id: string;
    source: string;
    taskId: string;
    storeId: string;
    storeAlias: string;
    publicationId: string;
    credentialVersionId?: string;
    credentialBindingMode: OzonCredentialBindingMode;
    storeConfigVersion: number;
    warehouseId: string;
    sku: string;
    revision: number;
    offerIds: string[];
    offerContractHash: string;
    materializationHash: string;
    payload: JsonRecord;
    taskFolder: string;
    workRelPath: string;
    directoryStage: string;
    directorySignature: string;
  };
  publication: OzonStorePublication;
  generatedVersionId: string;
  listingSnapshot: JsonRecord;
  currentAccountCurrency?: 'RUB' | 'CNY';
};

export type OzonEligibleAutoStore = OzonStore & {
  presetSnapshot?: JsonRecord;
  presetRowVersion?: number;
};

export type OzonPublicationInsert = {
  id: string;
  jobId: string;
  sku: string;
  generatedVersionId: string;
  revision: number;
  storeId: string;
  storeAlias: string;
  storeDisplayName: string;
  source: 'MANUAL' | 'AUTOMATION';
  credentialBindingMode: OzonCredentialBindingMode;
  credentialVersionId?: string;
  storeConfigVersion: number;
  presetId?: string;
  presetName?: string;
  presetRowVersion?: number;
  presetSnapshot?: JsonRecord;
  presetDefinitionHash?: string;
  preparationJobId?: string;
  requestId?: string;
  planHash: string;
  contentPolicyVersion: string;
  materialHash: string;
  materialHashVersion: string;
  publicationMode: 'CREATE_ONLY' | 'COMPATIBLE_UPSERT';
  taskId: string;
  warehouseId: string;
  warehouseName: string;
  fulfillmentMode: 'FBS' | 'RFBS';
  accountCurrency: 'RUB' | 'CNY';
  offerIds: string[];
  offerContractHash: string;
  materializationHash: string;
  /** Immutable, store-scoped product used to rebuild the original package identity. */
  materializedProductSnapshot: JsonRecord;
  packageRelPath?: string;
  packageSignature?: string;
  productJsonPath?: string;
};

export type OzonPublicationMediaConsumption = {
  sourceStageId: string;
  submissionId: string;
  variantId?: string;
  deliveredAt: string;
  decision: string;
  reason?: string;
};

export type OzonGatewayIdentity = {
  storeId: string;
  storeAlias: string;
  taskId?: string;
  publicationId?: string;
  credentialVersionId?: string;
  credentialBindingMode: OzonCredentialBindingMode;
  storeConfigVersion: number;
  warehouseId: string;
  offerContractHash?: string;
  materializationHash?: string;
  offerIds: string[];
  productIds: string[];
  importTaskId?: string;
  storeEnabled: boolean;
  leaseActive: boolean;
  credential?: OzonStoreCredentialRecord;
};

export type OzonExactStoreReadbackIdentity = OzonGatewayIdentity & {
  credentialVersionId: string;
  credential: OzonStoreCredentialRecord;
};

export type OzonVariantColorRepairIntentInput = {
  publicationId: string;
  publicationRowVersion: number;
  taskId: string;
  storeConfigVersion: number;
  credentialVersionId: string;
  requestRef: string;
  requestHash: string;
  payloadHash: string;
  planHash: string;
  offerIds: string[];
  evidence: JsonRecord;
};

export type OzonVariantColorRepairIntent = {
  requestRef: string;
  leaseToken?: string;
  existing?: JsonRecord;
};

export type OzonImportPriceFloorRecoveryInput = {
  publicationRowVersion: number;
  jobRowVersion: number;
  dryRun: boolean;
};

export type OzonImportPriceFloorRecoveryResult = {
  status: 'DRY_RUN' | 'RECOVERED' | 'ALREADY_RECOVERED';
  dryRun: boolean;
  publication: OzonStorePublication;
  jobId: string;
  jobRowVersion: number;
  checks: {
    storeId: string;
    storeAlias: string;
    sku: string;
    revision: number;
    taskId: string;
    importTaskId: string;
    offerIds: string[];
    productIds: string[];
    workRelPath: string;
    directorySignature: string;
    importProductCount: number;
    importInfoCount: number;
    pricesWriteCount: number;
    stocksWriteCount: number;
  };
};

export type OzonImportNoBrandRecoveryInput = OzonImportPriceFloorRecoveryInput;
export type OzonImportNoBrandRecoveryResult = OzonImportPriceFloorRecoveryResult;

export type OzonPublicationReadbackContext = {
  publication: OzonStorePublication;
  dispatchRowVersion: number;
  requestRef: string;
  taskId: string;
  listing: OzonListingDraft;
  mappings: OzonProductMapping[];
};

export type OzonRepresentedMediaFanoutReconciliationResult = {
  status: 'DRY_RUN' | 'RECONCILED' | 'ALREADY_RECONCILED';
  dryRun: boolean;
  jobId: string;
  sku: string;
  rowVersionBefore: number;
  rowVersionAfter: number;
  generatedVersionId: string;
  revision: number;
  anchorJobId: string;
  anchorDelivery: { sourceStageId: string; submissionId: string; variantId: string };
  deliveryIdentities: Array<{ sourceStageId: string; submissionId: string; variantId: string }>;
  publicationIds: string[];
  storeIds: string[];
  evidenceHash: string;
};

export class OzonStoreRepository {
  private pool?: Pool;

  constructor(private readonly connectionString?: string) {}
  get configured(): boolean { return Boolean(this.pool); }
  isFleetCapabilityReady(): boolean { return fleetCapabilityReady(); }

  async initialize(options: { migrate?: boolean } = {}): Promise<void> {
    if (!this.connectionString) return;
    this.pool = new Pool({ connectionString: this.connectionString, max: 4, idleTimeoutMillis: 30_000 });
    try {
      await this.pool.query('SELECT 1');
      if (options.migrate === false) {
        const required = await this.pool.query<{ table_name: string | null }>(`SELECT unnest(ARRAY[
          to_regclass('ozon_publish_jobs')::text,to_regclass('ozon_media_deliveries')::text,
          to_regclass('ozon_store_publications')::text,to_regclass('ozon_listing_versions')::text,
          to_regclass('ozon_store_media_consumptions')::text,to_regclass('ozon_product_mappings')::text,
          to_regclass('ozon_publish_events')::text
        ]) AS table_name`);
        if (required.rows.some((row) => !row.table_name)) {
          throw new AppError('DATABASE_UNAVAILABLE', 'OZON 媒体收口所需数据表尚未完成迁移', undefined, 503);
        }
      } else {
        await migrateOzonMultiStoreSchema(this.pool);
      }
    } catch (error) {
      await this.pool.end().catch(() => undefined);
      this.pool = undefined;
      throw error;
    }
  }

  async close(): Promise<void> { await this.pool?.end(); }

  async getSettings(): Promise<OzonStoreSystemSettings> {
    const result = await this.query<SqlRow>("SELECT * FROM ozon_system_settings WHERE id='default'");
    if (!result.rows[0]) throw new AppError('DATABASE_UNAVAILABLE', 'OZON 多店铺全局设置尚未初始化', undefined, 503);
    return toSettings(result.rows[0]);
  }

  async updateSettings(input: OzonStoreSystemSettingsPatch): Promise<OzonStoreSystemSettings> {
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>("SELECT * FROM ozon_system_settings WHERE id='default' FOR UPDATE");
      const row = current.rows[0];
      if (!row) throw new AppError('DATABASE_UNAVAILABLE', 'OZON 多店铺全局设置尚未初始化', undefined, 503);
      assertRowVersion(input.rowVersion, row.row_version, 'OZON 全局设置');
      const changed = await client.query<SqlRow>(`UPDATE ozon_system_settings SET
        enabled=$1,root_directory=$2,timezone=$3,global_concurrency=$4,
        task_api_webhook_url=$5,admin_api_webhook_url=$6,preflight_webhook_url=$7,
        image_uploader_workflow_id=$8,store_gateway_workflow_id=$9,
        image_upload_concurrency=$10,video_upload_concurrency=$11,video_prewarm_enabled=$12,
        row_version=row_version+1,updated_at=NOW()
        WHERE id='default' RETURNING *`, [
        input.enabled ?? Boolean(row.enabled),
        input.rootDirectory ?? String(row.root_directory || ''),
        input.timezone ?? String(row.timezone || 'Asia/Shanghai'),
        input.globalConcurrency ?? Number(row.global_concurrency || 2),
        input.taskApiWebhookUrl ?? String(row.task_api_webhook_url || ''),
        input.adminApiWebhookUrl ?? String(row.admin_api_webhook_url || ''),
        input.preflightWebhookUrl ?? String(row.preflight_webhook_url || ''),
        input.imageUploaderWorkflowId ?? String(row.image_uploader_workflow_id || ''),
        input.storeGatewayWorkflowId ?? String(row.store_gateway_workflow_id || ''),
        input.imageUploadConcurrency ?? Number(row.image_upload_concurrency || 7),
        input.videoUploadConcurrency ?? Number(row.video_upload_concurrency || 2),
        input.videoPrewarmEnabled ?? Boolean(row.video_prewarm_enabled)
      ]);
      if (input.enabled === true && !row.enabled) {
        await client.query(`UPDATE ozon_stores SET auto_publish_activated_at=NOW(),row_version=row_version+1,updated_at=NOW()
          WHERE enabled=true AND auto_publish_enabled=true AND archived_at IS NULL`);
      }
      return toSettings(changed.rows[0]!);
    });
  }

  async listStores(includeArchived = false): Promise<OzonStore[]> {
    const result = await this.query<SqlRow>(`${storeSelect()} ${includeArchived ? '' : 'WHERE s.archived_at IS NULL'}
      ORDER BY CASE WHEN s.store_alias=$1 THEN 0 ELSE 1 END,s.display_name,s.store_alias`, [OZON_DEFAULT_STORE_ALIAS]);
    return result.rows.map(toStore);
  }

  async getStore(storeIdOrAlias: string, includeArchived = false): Promise<OzonStore> {
    const result = await this.query<SqlRow>(`${storeSelect()} WHERE (s.id::text=$1 OR s.store_alias=$1)
      ${includeArchived ? '' : 'AND s.archived_at IS NULL'} LIMIT 1`, [storeIdOrAlias]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'OZON 店铺不存在', { storeIdOrAlias }, 404);
    return toStore(result.rows[0]);
  }

  async createStore(input: OzonStoreCreate): Promise<OzonStore> {
    const id = randomUUID();
    try {
      await this.transaction(async (client) => {
        await client.query(`INSERT INTO ozon_stores(
          id,store_alias,display_name,auto_publish_enabled,auto_publish_mode,default_preset_id,
          warehouse_id,warehouse_name,fulfillment_mode,account_currency,max_daily_styles,credential_state,credential_binding_mode
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'MISSING','VAULT')`, [
          id, input.storeAlias, input.displayName, input.autoPublishEnabled, input.autoPublishMode,
          input.defaultPresetId || null, input.warehouseId, input.warehouseName, input.fulfillmentMode,
          input.accountCurrency, input.maxDailyStyles
        ]);
        await client.query('INSERT INTO ozon_store_runtime_state(store_id) VALUES($1)', [id]);
      });
      return this.getStore(id);
    } catch (error: any) {
      if (error?.code === '23505') throw new AppError('CONFIG_INVALID', 'OZON 店铺别名已存在', { storeAlias: input.storeAlias }, 409);
      if (error?.code === '23503') throw new AppError('CONFIG_INVALID', '默认 OZON 预设不存在', undefined, 409);
      throw error;
    }
  }

  async updateStore(storeId: string, input: OzonStoreUpdate): Promise<OzonStore> {
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>('SELECT * FROM ozon_stores WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [storeId]);
      const row = current.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'OZON 店铺不存在', { storeId }, 404);
      assertRowVersion(input.rowVersion, row.row_version, 'OZON 店铺');
      const semanticFields: Array<[keyof OzonStoreUpdate, string]> = [
        ['autoPublishEnabled', 'auto_publish_enabled'], ['autoPublishMode', 'auto_publish_mode'],
        ['defaultPresetId', 'default_preset_id'], ['warehouseId', 'warehouse_id'], ['warehouseName', 'warehouse_name'],
        ['fulfillmentMode', 'fulfillment_mode'], ['accountCurrency', 'account_currency'], ['maxDailyStyles', 'max_daily_styles']
      ];
      const semanticChanged = semanticFields.some(([inputKey, rowKey]) => input[inputKey] !== undefined
        && String(input[inputKey] ?? '') !== String(row[rowKey] ?? ''));
      const enablingAuto = input.autoPublishEnabled === true && !row.auto_publish_enabled;
      const result = await client.query<SqlRow>(`UPDATE ozon_stores SET
        display_name=$2,auto_publish_enabled=$3,auto_publish_mode=$4,default_preset_id=$5,
        warehouse_id=$6,warehouse_name=$7,fulfillment_mode=$8,account_currency=$9,max_daily_styles=$10,
        auto_publish_activated_at=CASE WHEN $11 THEN NOW() WHEN $3=false THEN NULL ELSE auto_publish_activated_at END,
        config_version=config_version+CASE WHEN $12 THEN 1 ELSE 0 END,
        preflight_status=CASE WHEN $12 AND preflight_status='PASSED' THEN 'STALE' ELSE preflight_status END,
        row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 RETURNING *`, [
        storeId,
        input.displayName ?? row.display_name,
        input.autoPublishEnabled ?? row.auto_publish_enabled,
        input.autoPublishMode ?? row.auto_publish_mode,
        input.defaultPresetId === undefined ? row.default_preset_id : input.defaultPresetId,
        input.warehouseId ?? row.warehouse_id,
        input.warehouseName ?? row.warehouse_name,
        input.fulfillmentMode ?? row.fulfillment_mode,
        input.accountCurrency ?? row.account_currency,
        input.maxDailyStyles ?? row.max_daily_styles,
        enablingAuto,
        semanticChanged
      ]);
      if (semanticChanged) {
        await client.query(`UPDATE ozon_store_runtime_state SET
          preflight_credential_version_id=NULL,preflight_store_config_version=NULL,
          preflight_lock_expires_at=NULL,preflight_lease_owner=NULL,updated_at=NOW() WHERE store_id=$1`, [storeId]);
      }
      return this.getStoreWithClient(client, String(result.rows[0]!.id));
    });
  }

  async savePendingCredential(
    storeId: string,
    expectedRowVersion: number,
    credentialVersionId: string,
    encrypted: OzonEncryptedCredentialPair
  ): Promise<OzonStore> {
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>('SELECT * FROM ozon_stores WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [storeId]);
      const store = current.rows[0];
      if (!store) throw new AppError('NOT_FOUND', 'OZON 店铺不存在', { storeId }, 404);
      assertRowVersion(expectedRowVersion, store.row_version, 'OZON 店铺');
      await client.query(`UPDATE ozon_store_credential_versions SET status='RETIRED',retired_at=NOW()
        WHERE store_id=$1 AND status='PENDING'`, [storeId]);
      const versionResult = await client.query<{ version_no: number }>(
        'SELECT COALESCE(MAX(version_no),0)+1 version_no FROM ozon_store_credential_versions WHERE store_id=$1', [storeId]
      );
      await client.query(`INSERT INTO ozon_store_credential_versions(
        id,store_id,version_no,status,ciphertext,nonce,auth_tag,fingerprint,key_version
      ) VALUES($1,$2,$3,'PENDING',$4,$5,$6,$7,$8)`, [
        credentialVersionId, storeId, Number(versionResult.rows[0]?.version_no || 1), encrypted.ciphertext,
        encrypted.nonce, encrypted.authTag, encrypted.fingerprint, encrypted.keyVersion
      ]);
      await client.query(`UPDATE ozon_stores SET credential_state='PENDING',row_version=row_version+1,updated_at=NOW()
        WHERE id=$1`, [storeId]);
      await client.query(`UPDATE ozon_store_runtime_state SET
        preflight_credential_version_id=NULL,preflight_store_config_version=NULL,
        preflight_lock_expires_at=NULL,preflight_lease_owner=NULL,updated_at=NOW() WHERE store_id=$1`, [storeId]);
      return this.getStoreWithClient(client, storeId);
    });
  }

  async beginPreflight(storeId: string, expectedRowVersion: number): Promise<{
    store: OzonStore;
    storeConfigVersion: number;
    credentialVersionId: string;
  }> {
    return this.transaction(async (client) => {
      const store = await client.query<SqlRow>('SELECT * FROM ozon_stores WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [storeId]);
      const row = store.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'OZON 店铺不存在', { storeId }, 404);
      assertRowVersion(expectedRowVersion, row.row_version, 'OZON 店铺');
      const runtimeResult = await client.query<SqlRow>(`SELECT rs.*,
          (rs.preflight_lock_expires_at>NOW()) preflight_lock_active
        FROM ozon_store_runtime_state rs WHERE rs.store_id=$1 FOR UPDATE`, [storeId]);
      const runtime = runtimeResult.rows[0];
      if (!runtime) throw new AppError('DATABASE_UNAVAILABLE', 'OZON 店铺运行状态缺失', { storeId }, 503);
      if (runtime.preflight_lock_active) {
        throw new AppError('OZON_PREFLIGHT_IN_PROGRESS', 'OZON 店铺预检正在进行，请等待结果回写', {
          lockExpiresAt: iso(runtime.preflight_lock_expires_at)
        }, 409);
      }
      const recoveredExpiredLock = runtime.preflight_lock_expires_at
        ? await appendPreflightFailureRunWithClient(client, {
            storeId,
            storeConfigVersion: Number(runtime.preflight_store_config_version || 0),
            credentialVersionId: String(runtime.preflight_credential_version_id || ''),
            errorCode: OZON_PREFLIGHT_REPORT_TIMEOUT_CODE,
            errorMessage: OZON_PREFLIGHT_REPORT_TIMEOUT_MESSAGE,
            source: 'LOCK_TIMEOUT',
            lockExpiresAt: runtime.preflight_lock_expires_at
          })
        : false;
      const credential = await client.query<SqlRow>(`SELECT * FROM ozon_store_credential_versions
        WHERE store_id=$1 AND status IN ('PENDING','ACTIVE')
        ORDER BY CASE status WHEN 'PENDING' THEN 0 ELSE 1 END,version_no DESC LIMIT 1 FOR UPDATE`, [storeId]);
      if (!credential.rows[0]) throw new AppError('OZON_CREDENTIAL_MISSING', '请先录入 OZON Client-Id 和 Api-Key', undefined, 409);
      if (!row.active_credential_version_id) {
        await client.query(`UPDATE ozon_stores SET preflight_status='PENDING',
          preflight_error_code=CASE WHEN $2 THEN $3 ELSE preflight_error_code END,
          preflight_error_message=CASE WHEN $2 THEN $4 ELSE preflight_error_message END,
          row_version=row_version+1,updated_at=NOW() WHERE id=$1`, [
          storeId, recoveredExpiredLock, OZON_PREFLIGHT_REPORT_TIMEOUT_CODE, OZON_PREFLIGHT_REPORT_TIMEOUT_MESSAGE
        ]);
      }
      await client.query(`UPDATE ozon_store_runtime_state SET
        preflight_credential_version_id=$2,preflight_store_config_version=$3,
        preflight_lock_expires_at=NOW()+INTERVAL '15 minutes',preflight_lease_owner='manual',updated_at=NOW() WHERE store_id=$1`, [
        storeId, credential.rows[0].id, Number(row.config_version)
      ]);
      return {
        store: await this.getStoreWithClient(client, storeId),
        storeConfigVersion: Number(row.config_version),
        credentialVersionId: String(credential.rows[0].id)
      };
    });
  }

  async failPreflightDispatch(
    storeId: string,
    storeConfigVersion: number,
    credentialVersionId: string
  ): Promise<OzonStore> {
    return this.transaction(async (client) => {
      const stateResult = await client.query<SqlRow>(`SELECT s.active_credential_version_id,rs.*
        FROM ozon_stores s JOIN ozon_store_runtime_state rs ON rs.store_id=s.id
        WHERE s.id=$1 AND s.archived_at IS NULL FOR UPDATE OF s,rs`, [storeId]);
      const state = stateResult.rows[0];
      if (!state) throw new AppError('NOT_FOUND', 'OZON 店铺不存在', { storeId }, 404);
      const ownsLock = String(state.preflight_credential_version_id || '') === credentialVersionId
        && Number(state.preflight_store_config_version || 0) === storeConfigVersion
        && String(state.preflight_lease_owner || '') === 'manual'
        && Boolean(state.preflight_lock_expires_at);
      if (!ownsLock) return this.getStoreWithClient(client, storeId);
      await appendPreflightFailureRunWithClient(client, {
        storeId,
        storeConfigVersion,
        credentialVersionId,
        errorCode: OZON_PREFLIGHT_DISPATCH_REJECTED_CODE,
        errorMessage: OZON_PREFLIGHT_DISPATCH_REJECTED_MESSAGE,
        source: 'DISPATCH_REJECTED'
      });
      await client.query(`UPDATE ozon_store_runtime_state SET
        preflight_credential_version_id=NULL,preflight_store_config_version=NULL,
        preflight_lock_expires_at=NULL,preflight_lease_owner=NULL,updated_at=NOW()
        WHERE store_id=$1 AND preflight_credential_version_id=$2
          AND preflight_store_config_version=$3 AND preflight_lease_owner='manual'`, [
        storeId, credentialVersionId, storeConfigVersion
      ]);
      if (!state.active_credential_version_id) {
        await client.query(`UPDATE ozon_stores SET preflight_status='FAILED',preflight_error_code=$2,
          preflight_error_message=$3,row_version=row_version+1,updated_at=NOW() WHERE id=$1`, [
          storeId, OZON_PREFLIGHT_DISPATCH_REJECTED_CODE, OZON_PREFLIGHT_DISPATCH_REJECTED_MESSAGE
        ]);
      }
      return this.getStoreWithClient(client, storeId);
    });
  }

  async claimDuePreflights(input: { leaseOwner: string; limit: number }): Promise<Array<{
    storeId: string;
    storeAlias: string;
    storeConfigVersion: number;
    credentialVersionId: string;
    requestRef: string;
    lockExpiresAt: string;
  }>> {
    return this.transaction(async (client) => {
      const candidates = await client.query<SqlRow>(`SELECT
          s.id store_id,s.store_alias,s.config_version,s.active_credential_version_id,
          c.id credential_version_id,c.status credential_status,rs.preflight_lock_expires_at,
          rs.preflight_credential_version_id expired_credential_version_id,
          rs.preflight_store_config_version expired_store_config_version
        FROM ozon_stores s
        JOIN ozon_store_runtime_state rs ON rs.store_id=s.id
        JOIN LATERAL (
          SELECT cv.id,cv.status FROM ozon_store_credential_versions cv
          WHERE cv.store_id=s.id AND cv.status IN ('PENDING','ACTIVE')
          ORDER BY CASE cv.status WHEN 'PENDING' THEN 0 ELSE 1 END,cv.version_no DESC LIMIT 1
        ) c ON true
        WHERE s.archived_at IS NULL
          AND (rs.preflight_lock_expires_at IS NULL OR rs.preflight_lock_expires_at<=NOW())
          AND (c.status='PENDING' OR s.preflight_status IN ('NOT_RUN','FAILED','STALE')
            OR s.preflight_due_at IS NULL OR s.preflight_due_at<=NOW())
        ORDER BY CASE c.status WHEN 'PENDING' THEN 0 ELSE 1 END,
          COALESCE(s.preflight_due_at,'epoch'::timestamptz),s.id
        FOR UPDATE OF s,rs SKIP LOCKED LIMIT $1`, [Math.max(1, Math.min(50, input.limit))]);
      const claimed: Array<{
        storeId: string; storeAlias: string; storeConfigVersion: number; credentialVersionId: string;
        requestRef: string; lockExpiresAt: string;
      }> = [];
      for (const row of candidates.rows) {
        const recoveredExpiredLock = row.preflight_lock_expires_at
          ? await appendPreflightFailureRunWithClient(client, {
              storeId: String(row.store_id),
              storeConfigVersion: Number(row.expired_store_config_version || 0),
              credentialVersionId: String(row.expired_credential_version_id || ''),
              errorCode: OZON_PREFLIGHT_REPORT_TIMEOUT_CODE,
              errorMessage: OZON_PREFLIGHT_REPORT_TIMEOUT_MESSAGE,
              source: 'LOCK_TIMEOUT',
              lockExpiresAt: row.preflight_lock_expires_at
            })
          : false;
        const requestRef = `ozon-preflight:${row.store_id}:${row.config_version}:${row.credential_version_id}:${randomUUID()}`;
        const lockResult = await client.query<SqlRow>(`UPDATE ozon_store_runtime_state SET
          preflight_credential_version_id=$2,preflight_store_config_version=$3,
          preflight_lock_expires_at=NOW()+INTERVAL '15 minutes',preflight_lease_owner=$4,updated_at=NOW()
          WHERE store_id=$1 RETURNING preflight_lock_expires_at`, [
          row.store_id, row.credential_version_id, Number(row.config_version), input.leaseOwner
        ]);
        if (!row.active_credential_version_id) {
          await client.query(`UPDATE ozon_stores SET preflight_status='PENDING',
            preflight_error_code=CASE WHEN $2 THEN $3 ELSE preflight_error_code END,
            preflight_error_message=CASE WHEN $2 THEN $4 ELSE preflight_error_message END,
            row_version=row_version+1,updated_at=NOW() WHERE id=$1`, [
            row.store_id, recoveredExpiredLock, OZON_PREFLIGHT_REPORT_TIMEOUT_CODE, OZON_PREFLIGHT_REPORT_TIMEOUT_MESSAGE
          ]);
        }
        claimed.push({
          storeId: String(row.store_id),
          storeAlias: String(row.store_alias),
          storeConfigVersion: Number(row.config_version),
          credentialVersionId: String(row.credential_version_id),
          requestRef,
          lockExpiresAt: iso(lockResult.rows[0]!.preflight_lock_expires_at)
        });
      }
      return claimed;
    });
  }

  async applyPreflightReport(
    storeId: string,
    storeConfigVersion: number,
    credentialVersionId: string,
    report: OzonStorePreflightReport
  ): Promise<OzonStore> {
    return this.transaction(async (client) => {
      const storeResult = await client.query<SqlRow>('SELECT * FROM ozon_stores WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [storeId]);
      const store = storeResult.rows[0];
      if (!store) throw new AppError('NOT_FOUND', 'OZON 店铺不存在', { storeId }, 404);
      if (Number(store.config_version) !== storeConfigVersion
        || report.storeId !== storeId
        || report.storeConfigVersion !== storeConfigVersion
        || report.credentialVersionId !== credentialVersionId) {
        throw new AppError('VERSION_CONFLICT', 'OZON 店铺或凭据版本已变化，预检结果已拒绝', {
          storeId, expectedStoreConfigVersion: storeConfigVersion, actualStoreConfigVersion: Number(store.config_version)
        }, 409);
      }
      const credentialResult = await client.query<SqlRow>(`SELECT * FROM ozon_store_credential_versions
        WHERE id=$1 AND store_id=$2 AND status IN ('PENDING','ACTIVE') FOR UPDATE`, [credentialVersionId, storeId]);
      const credential = credentialResult.rows[0];
      if (!credential) throw new AppError('VERSION_CONFLICT', 'OZON 预检凭据版本已失效', undefined, 409);
      const lock = await client.query<SqlRow>(`SELECT * FROM ozon_store_runtime_state
        WHERE store_id=$1 AND preflight_credential_version_id=$2
          AND preflight_store_config_version=$3 AND preflight_lock_expires_at>NOW() FOR UPDATE`, [
        storeId, credentialVersionId, storeConfigVersion
      ]);
      if (!lock.rows[0]) throw new AppError('VERSION_CONFLICT', 'OZON 预检锁已过期或已被新请求取代', undefined, 409);
      const configuredCurrency: OzonStore['accountCurrency'] = store.account_currency === 'CNY' ? 'CNY' : 'RUB';
      const currencyEvaluation = evaluateOzonPreflightCurrency(configuredCurrency, report.currencyVerification);
      const ready = report.ok && Boolean(report.sellerId) && report.warehouses.length > 0
        && report.currencyVerified === true && currencyEvaluation.verified;
      const duplicate = ready && store.enabled && report.sellerId
        ? Boolean((await client.query<{ exists: boolean }>(`SELECT EXISTS(
            SELECT 1 FROM ozon_stores WHERE id<>$1 AND enabled=true AND archived_at IS NULL AND seller_id=$2
          ) AS exists`, [storeId, report.sellerId])).rows[0]?.exists)
        : false;
      const auditResult = duplicate ? 'REJECTED_DUPLICATE_SELLER' : ready ? 'PASSED' : 'FAILED';
      const auditErrorCode = duplicate
        ? 'OZON_DUPLICATE_SELLER'
        : currencyEvaluation.mismatch
          ? currencyEvaluation.errorCode
          : report.errorCode || (!ready && !currencyEvaluation.verified
          ? currencyEvaluation.errorCode
          : !ready ? 'OZON_PREFLIGHT_FAILED' : '');
      const auditErrorMessage = duplicate
        ? '该 OZON Seller 已由另一家启用店铺使用'
        : currencyEvaluation.mismatch
          ? currencyEvaluation.errorMessage
          : report.errorMessage || (!ready && !currencyEvaluation.verified
          ? currencyEvaluation.errorMessage
          : !ready ? '店铺预检未通过' : '');
      await client.query(`INSERT INTO ozon_store_preflight_runs(
        id,store_id,store_config_version,credential_version_id,result,report,observed_at,error_code,error_message
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz,$8,$9)`, [
        randomUUID(), storeId, storeConfigVersion, credentialVersionId,
        auditResult, JSON.stringify(redactCredentialLikeKeys(report)), report.observedAt,
        auditErrorCode, auditErrorMessage
      ]);
      await client.query(`UPDATE ozon_store_credential_versions SET
        validation_report=$2::jsonb,validation_error_code=$3,validation_error_message=$4,validated_at=$5::timestamptz
        WHERE id=$1`, [
        credentialVersionId, JSON.stringify(redactCredentialLikeKeys(report)), auditErrorCode, auditErrorMessage, report.observedAt
      ]);
      await client.query(`UPDATE ozon_store_runtime_state SET
        preflight_credential_version_id=NULL,preflight_store_config_version=NULL,
        preflight_lock_expires_at=NULL,preflight_lease_owner=NULL,updated_at=NOW() WHERE store_id=$1`, [storeId]);
      if (!ready) {
        if (currencyEvaluation.mismatch) {
          await client.query(`UPDATE ozon_stores SET preflight_status='FAILED',preflight_checked_at=$4::timestamptz,
            preflight_due_at=NULL,preflight_expires_at=NULL,preflight_report=$5::jsonb,
            preflight_error_code=$2,preflight_error_message=$3,row_version=row_version+1,updated_at=NOW() WHERE id=$1`, [
            storeId, auditErrorCode, auditErrorMessage, report.observedAt,
            JSON.stringify(redactCredentialLikeKeys(report))
          ]);
        } else if (!store.active_credential_version_id) {
          await client.query(`UPDATE ozon_stores SET preflight_status='FAILED',preflight_error_code=$2,
            preflight_error_message=$3,row_version=row_version+1,updated_at=NOW() WHERE id=$1`, [
            storeId, auditErrorCode, auditErrorMessage
          ]);
        }
        return this.getStoreWithClient(client, storeId);
      }
      if (duplicate) return this.getStoreWithClient(client, storeId);
      try {
        await client.query(`UPDATE ozon_store_credential_versions SET status='RETIRED',retired_at=NOW()
          WHERE store_id=$1 AND status='ACTIVE' AND id<>$2`, [storeId, credentialVersionId]);
        await client.query(`UPDATE ozon_store_credential_versions SET status='ACTIVE',activated_at=COALESCE(activated_at,NOW())
          WHERE id=$1`, [credentialVersionId]);
        await client.query(`UPDATE ozon_stores SET
          active_credential_version_id=$2,credential_state='ACTIVE',credential_binding_mode='VAULT',
          vault_activated_at=COALESCE(vault_activated_at,NOW()),
          seller_id=$3,seller_name=$4,permissions=$5::jsonb,limits=$6::jsonb,warehouses=$7::jsonb,
          preflight_status='PASSED',preflight_checked_at=$8::timestamptz,
          preflight_due_at=$8::timestamptz+make_interval(hours=>$9),
          preflight_expires_at=$8::timestamptz+make_interval(hours=>$10),
          preflight_report=$11::jsonb,preflight_error_code='',preflight_error_message='',
          config_version=config_version+1,row_version=row_version+1,updated_at=NOW()
          WHERE id=$1`, [
          storeId, credentialVersionId, report.sellerId || '', report.sellerName || '', JSON.stringify(report.permissions),
          JSON.stringify(report.limits), JSON.stringify(report.warehouses), report.observedAt,
          OZON_PREFLIGHT_DUE_HOURS, OZON_PREFLIGHT_TTL_HOURS, JSON.stringify(redactCredentialLikeKeys(report))
        ]);
      } catch (error: any) {
        if (error?.code === '23505') throw new AppError('CONFIG_INVALID', '该 OZON Seller 已绑定到另一个有效店铺', { sellerId: report.sellerId }, 409);
        throw error;
      }
      return this.getStoreWithClient(client, storeId);
    });
  }

  async setStoreEnabled(storeId: string, enabled: boolean, expectedRowVersion: number): Promise<OzonStore> {
    return this.transaction(async (client) => {
      const result = await client.query<SqlRow>(`${storeSelect()}
        WHERE s.id=$1 AND s.archived_at IS NULL FOR UPDATE OF s`, [storeId]);
      const row = result.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'OZON 店铺不存在', { storeId }, 404);
      assertRowVersion(expectedRowVersion, row.row_version, 'OZON 店铺');
      if (enabled) {
        const blockers = readinessBlockers(row);
        if (row.seller_id) {
          const duplicate = await client.query<{ exists: boolean }>(`SELECT EXISTS(
            SELECT 1 FROM ozon_stores WHERE id<>$1 AND enabled=true AND archived_at IS NULL AND seller_id=$2
          ) AS exists`, [storeId, row.seller_id]);
          if (duplicate.rows[0]?.exists) blockers.push('该 Seller 身份已由另一家启用店铺使用');
        }
        if (blockers.length) throw new AppError('OZON_STORE_NOT_READY', 'OZON 店铺尚未就绪', { blockers }, 409);
      }
      try {
        await client.query(`UPDATE ozon_stores SET enabled=$2,
          auto_publish_activated_at=CASE WHEN $2 AND auto_publish_enabled THEN NOW() ELSE NULL END,
          row_version=row_version+1,updated_at=NOW() WHERE id=$1`, [storeId, enabled]);
      } catch (error: any) {
        if (error?.code === '23505') throw new AppError('CONFIG_INVALID', '该 OZON Seller 已由另一家启用店铺使用', undefined, 409);
        throw error;
      }
      return this.getStoreWithClient(client, storeId);
    });
  }

  async archiveStore(storeId: string, expectedRowVersion: number): Promise<OzonStore> {
    return this.transaction(async (client) => {
      const result = await client.query<SqlRow>('SELECT * FROM ozon_stores WHERE id=$1 AND archived_at IS NULL FOR UPDATE', [storeId]);
      const row = result.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'OZON 店铺不存在', { storeId }, 404);
      if (storeId === OZON_DEFAULT_STORE_ID) throw new AppError('CONFIG_INVALID', '历史默认 OZON 店铺不能归档', undefined, 409);
      assertRowVersion(expectedRowVersion, row.row_version, 'OZON 店铺');
      const active = await client.query<{ count: string }>(`SELECT COUNT(*) count FROM ozon_publish_jobs
        WHERE store_id=$1 AND state=ANY($2::text[])`, [storeId, ACTIVE_JOB_STATES]);
      const publications = await client.query<{ count: string }>(`SELECT COUNT(*) count FROM ozon_store_publications
        WHERE store_id=$1 AND status=ANY($2::text[])`, [storeId, NONTERMINAL_PUBLICATION_STATES]);
      if (Number(active.rows[0]?.count || 0) || Number(publications.rows[0]?.count || 0)) {
        throw new AppError('TASK_LOCKED', 'OZON 店铺仍有活动任务或 publication，不能归档', undefined, 409);
      }
      await client.query(`UPDATE ozon_stores SET enabled=false,auto_publish_enabled=false,
        auto_publish_activated_at=NULL,archived_at=NOW(),row_version=row_version+1,updated_at=NOW() WHERE id=$1`, [storeId]);
      return this.getStoreWithClient(client, storeId, true);
    });
  }

  async getPlanningContext(skuInput: string, draftVersion: number, storeIds: string[]): Promise<OzonPublicationPlanningContext> {
    const sku = normalizeSku(skuInput);
    return this.transaction(async (client) => {
      const listingResult = await client.query<SqlRow>('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR SHARE', [sku]);
      const listing = listingResult.rows[0];
      if (!listing) throw new AppError('NOT_FOUND', 'OZON 上品草稿不存在', { sku }, 404);
      if (Number(listing.row_version) !== draftVersion) {
        throw new AppError('VERSION_CONFLICT', 'OZON 草稿已变化，请重新生成发布计划', {
          expected: draftVersion, actual: Number(listing.row_version)
        }, 409);
      }
      const versionResult = await client.query<SqlRow>(`SELECT * FROM ozon_listing_versions
        WHERE sku=$1 AND revision=$2 ORDER BY created_at DESC LIMIT 1`, [sku, Number(listing.revision)]);
      const version = versionResult.rows[0];
      if (!version) throw new AppError('VERSION_CONFLICT', '当前 OZON 草稿尚未生成稳定版本', { sku, revision: listing.revision }, 409);
      await assertOzonSourceMediaVersionAvailable(client, String(version.id));
      const uniqueStoreIds = [...new Set(storeIds)];
      const storesResult = await client.query<SqlRow>(`${storeSelect()}
        WHERE s.id=ANY($1::uuid[]) AND s.archived_at IS NULL ORDER BY s.id`, [uniqueStoreIds]);
      if (storesResult.rows.length !== uniqueStoreIds.length) {
        const found = new Set(storesResult.rows.map((row) => String(row.id)));
        throw new AppError('NOT_FOUND', '发布计划包含不存在或已归档的 OZON 店铺', {
          missingStoreIds: uniqueStoreIds.filter((id) => !found.has(id))
        }, 404);
      }
      const stores: OzonPublicationPlanningContext['stores'] = [];
      for (const row of storesResult.rows) {
        const store = toStore(row);
        if (!store.defaultPresetId) {
          stores.push(store);
          continue;
        }
        const preset = await client.query<SqlRow>('SELECT * FROM ozon_listing_presets WHERE id=$1', [store.defaultPresetId]);
        stores.push({
          ...store,
          ...(preset.rows[0] ? {
            presetSnapshot: jsonObject(preset.rows[0].definition),
            presetRowVersion: Number(preset.rows[0].row_version),
            presetName: String(preset.rows[0].name || '')
          } : {})
        });
      }
      const snapshot = jsonObject(version.snapshot);
      const data = jsonObject(snapshot.data);
      const presetSnapshot = jsonObject(jsonObject(data.initialization).presetSnapshot);
      const basePresetSnapshot = jsonObject(presetSnapshot.definition);
      const basePresetId = String(version.base_preset_id || presetSnapshot.presetId || '').trim();
      const storedOverrides = jsonObject(version.material_overrides);
      const materialOverrides = Object.keys(storedOverrides).length
        ? storedOverrides
        : deriveMaterialOverrides(data, basePresetSnapshot);
      const basePresetExists = basePresetId
        ? Boolean((await client.query<{ exists: boolean }>(
            'SELECT EXISTS(SELECT 1 FROM ozon_listing_presets WHERE id=$1) exists', [basePresetId]
          )).rows[0]?.exists)
        : false;
      if ((!version.base_preset_id && basePresetExists) || !Object.keys(storedOverrides).length) {
        await client.query(`UPDATE ozon_listing_versions SET
          base_preset_id=COALESCE(base_preset_id,$2::uuid),material_overrides=$3::jsonb WHERE id=$1`, [
          version.id, basePresetExists ? basePresetId : null, JSON.stringify(materialOverrides)
        ]);
      }
      const offerIds = normalizeStringArray(Array.isArray(data.offers)
        ? data.offers.map((offer) => jsonObject(offer).offerId)
        : []);
      if (!offerIds.length) throw new AppError('CONFIG_INVALID', 'OZON 生成版本没有可发布的 offer_id', { sku }, 409);
      return {
        sku,
        draftVersion,
        generatedVersionId: String(version.id),
        revision: Number(version.revision),
        contentPolicyVersion: String(version.content_policy_version || 'LEGACY_UNKNOWN'),
        materialHash: String(version.material_hash || ''),
        materialHashVersion: String(version.material_hash_version || 'LEGACY_UNKNOWN'),
        sourceMediaIdentityHash: String(version.source_media_identity_hash || ''),
        listingStatus: String(listing.status),
        listingSnapshot: snapshot,
        ...(basePresetId ? { basePresetId } : {}),
        ...(Object.keys(basePresetSnapshot).length ? { basePresetSnapshot } : {}),
        materialOverrides,
        offerIds,
        stores
      };
    });
  }

  async getCurrentListingVersion(skuInput: string): Promise<{
    draftVersion: number;
    revision: number;
    generatedVersionId: string;
  }> {
    const sku = normalizeSku(skuInput);
    const result = await this.query<SqlRow>(`SELECT d.row_version AS draft_version,d.revision,v.id AS generated_version_id
      FROM ozon_listing_drafts d
      LEFT JOIN LATERAL (
        SELECT id FROM ozon_listing_versions
        WHERE sku=d.sku AND revision=d.revision
        ORDER BY created_at DESC LIMIT 1
      ) v ON TRUE
      WHERE d.sku=$1`, [sku]);
    const row = result.rows[0];
    if (!row) throw new AppError('NOT_FOUND', 'OZON 上品草稿不存在', { sku }, 404);
    if (!row.generated_version_id) {
      throw new AppError('VERSION_CONFLICT', '当前 OZON 草稿尚未生成稳定版本', {
        sku,
        revision: Number(row.revision)
      }, 409);
    }
    return {
      draftVersion: Number(row.draft_version),
      revision: Number(row.revision),
      generatedVersionId: String(row.generated_version_id)
    };
  }

  async planPublicationAttempt(
    input: OzonPublicationInsert,
    mediaConsumption?: OzonPublicationMediaConsumption
  ): Promise<OzonStorePublication> {
    return this.transaction(async (client) => {
      const existing = await client.query<SqlRow>(`SELECT * FROM ozon_store_publications
        WHERE (store_id=$1 AND generated_version_id=$2)
          OR ($3::uuid IS NOT NULL AND request_id=$3::uuid AND store_id=$1)
          OR ($4::uuid IS NOT NULL AND preparation_job_id=$4::uuid AND store_id=$1)
        ORDER BY created_at LIMIT 1 FOR UPDATE`, [
        input.storeId, input.generatedVersionId, input.requestId || null, input.preparationJobId || null
      ]);
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (String(row.plan_hash || '') !== input.planHash
          || String(row.generated_version_id) !== input.generatedVersionId
          || String(row.planned_job_id || '') !== input.jobId) {
          throw new AppError('VERSION_CONFLICT', 'OZON publication 幂等身份已绑定不同冻结计划', {
            publicationId: String(row.id), storeId: input.storeId
          }, 409);
        }
        return toPublication(row);
      }
      const active = await client.query<SqlRow>(`SELECT id,state FROM ozon_publish_jobs
        WHERE store_id=$1 AND sku=$2 AND task_kind IN ('STORE_PUBLICATION','LEGACY')
          AND state=ANY($3::text[]) FOR UPDATE`, [input.storeId, input.sku, ACTIVE_JOB_STATES]);
      if (active.rows[0]) throw new AppError('TASK_LOCKED', '同一 OZON 店铺和 SKU 已有活动 publication 任务', {
        storeId: input.storeId, sku: input.sku, jobId: active.rows[0].id, state: active.rows[0].state
      }, 409);
      await client.query(`INSERT INTO ozon_store_publications(
        id,sku,generated_version_id,revision,store_id,store_alias_snapshot,store_display_name_snapshot,status,source,
        credential_binding_mode,credential_version_id,store_config_version,preset_id,preset_snapshot,preset_definition_hash,
        task_id,warehouse_id,warehouse_name,fulfillment_mode,account_currency,offer_ids,offer_contract_hash,
        materialization_hash,preparation_job_id,planned_job_id,request_id,plan_hash,content_policy_version,material_hash,
        material_hash_version,preset_row_version,publication_mode,materialized_product_snapshot
      ) VALUES($1,$2,$3,$4,$5,$6,$7,'PLANNED',$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,
        $20::jsonb,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32::jsonb)`, [
        input.id, input.sku, input.generatedVersionId, input.revision, input.storeId, input.storeAlias,
        input.storeDisplayName, input.source, input.credentialBindingMode, input.credentialVersionId || null,
        input.storeConfigVersion, input.presetId || null, JSON.stringify(input.presetSnapshot || {}),
        input.presetDefinitionHash || '', input.taskId, input.warehouseId, input.warehouseName, input.fulfillmentMode,
        input.accountCurrency, JSON.stringify(input.offerIds), input.offerContractHash, input.materializationHash,
        input.preparationJobId || null, input.jobId, input.requestId || null, input.planHash,
        input.contentPolicyVersion, input.materialHash, input.materialHashVersion,
        input.presetRowVersion || null, input.publicationMode, JSON.stringify(input.materializedProductSnapshot)
      ]);
      const payload = {
        schemaVersion: 4,
        mode: 'MULTISTORE_PUBLICATION',
        attemptPhase: 'PLANNED',
        storeId: input.storeId,
        storeAlias: input.storeAlias,
        publicationId: input.id,
        preparationJobId: input.preparationJobId,
        requestId: input.requestId,
        planHash: input.planHash,
        contentPolicyVersion: input.contentPolicyVersion,
        materialHash: input.materialHash,
        materialHashVersion: input.materialHashVersion,
        presetId: input.presetId,
        presetName: input.presetName,
        presetRowVersion: input.presetRowVersion,
        publicationMode: input.publicationMode,
        credentialVersionId: input.credentialVersionId,
        credentialBindingMode: input.credentialBindingMode,
        storeConfigVersion: input.storeConfigVersion,
        warehouseId: input.warehouseId,
        offerContractHash: input.offerContractHash,
        materializationHash: input.materializationHash
      };
      await client.query(`INSERT INTO ozon_publish_jobs(
        id,sku,state,source,task_id,payload,stage_states,store_alias,offer_ids,product_links,
        listing_revision,store_id,publication_id,credential_version_id,credential_binding_mode,store_config_version,
        warehouse_id,offer_contract_hash,materialization_hash,task_kind
      ) VALUES($1,$2,'WAITING_MEDIA',$3,$4,$5::jsonb,'{}'::jsonb,$6,$7::jsonb,'[]'::jsonb,$8,$9,$10,$11,$12,$13,
        $14,$15,$16,'STORE_PUBLICATION')`, [
        input.jobId, input.sku, input.source === 'AUTOMATION' ? 'AUTO' : 'MANUAL', input.taskId,
        JSON.stringify(payload), input.storeAlias, JSON.stringify(input.offerIds), input.revision, input.storeId,
        input.id, input.credentialVersionId || null, input.credentialBindingMode, input.storeConfigVersion,
        input.warehouseId, input.offerContractHash, input.materializationHash
      ]);
      await client.query(`INSERT INTO ozon_publish_events(
        id,job_id,event_type,to_state,message,payload,store_id,publication_id
      ) VALUES($1,$2,'MULTISTORE_PUBLICATION_PLANNED','WAITING_MEDIA',$3,$4::jsonb,$5,$6)`, [
        randomUUID(), input.jobId, 'OZON 店铺 publication attempt 已按冻结计划持久化',
        JSON.stringify({ planHash: input.planHash, materializationHash: input.materializationHash }), input.storeId, input.id
      ]);
      if (mediaConsumption) {
        await upsertMediaConsumptionWithClient(client, {
          storeId: input.storeId, sku: input.sku, ...mediaConsumption,
          publicationId: input.id, jobId: input.jobId
        });
      }
      const created = await client.query<SqlRow>('SELECT * FROM ozon_store_publications WHERE id=$1', [input.id]);
      return toPublication(created.rows[0]!);
    });
  }

  async materializePublicationAttempt(input: {
    publicationId: string;
    jobId: string;
    planHash: string;
    materializationHash: string;
    packageRelPath: string;
    packageSignature: string;
    productJsonPath: string;
  }): Promise<OzonStorePublication> {
    return this.transaction(async (client) => {
      const publicationResult = await client.query<SqlRow>(
        'SELECT * FROM ozon_store_publications WHERE id=$1 FOR UPDATE', [input.publicationId]
      );
      const publication = publicationResult.rows[0];
      if (!publication) throw new AppError('NOT_FOUND', 'OZON publication attempt 不存在', { publicationId: input.publicationId }, 404);
      const jobResult = await client.query<SqlRow>(
        'SELECT * FROM ozon_publish_jobs WHERE id=$1 AND publication_id=$2 FOR UPDATE', [input.jobId, input.publicationId]
      );
      const job = jobResult.rows[0];
      if (!job) throw new AppError('VERSION_CONFLICT', 'OZON publication attempt 缺少原固定 job', undefined, 409);
      if (String(publication.plan_hash || '') !== input.planHash
        || String(publication.materialization_hash || '') !== input.materializationHash) {
        throw new AppError('VERSION_CONFLICT', 'OZON publication 发布包与冻结计划不一致', undefined, 409);
      }
      if (['QUEUED', 'RUNNING', 'SUCCEEDED'].includes(String(publication.status))) {
        if (String(publication.package_signature || '') !== input.packageSignature) {
          throw new AppError('VERSION_CONFLICT', 'OZON publication 已有不同的不可变发布包', undefined, 409);
        }
        return toPublication(publication);
      }
      if (!['PLANNED', 'NEEDS_ATTENTION'].includes(String(publication.status))
        || !['WAITING_MEDIA', 'NEEDS_ATTENTION'].includes(String(job.state))) {
        throw new AppError('TASK_LOCKED', 'OZON publication attempt 当前状态不可物化', {
          publicationStatus: publication.status, jobState: job.state
        }, 409);
      }
      const gateway = await client.query<{ exists: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM ozon_gateway_requests WHERE publication_id=$1
      ) exists`, [input.publicationId]);
      if (gateway.rows[0]?.exists) {
        throw new AppError('OZON_READBACK_REQUIRED', 'publication attempt 已有网关证据，只允许按原身份回读', undefined, 409);
      }
      await client.query(`UPDATE ozon_store_publications SET status='MATERIALIZED',package_rel_path=$2,
        package_signature=$3,error_code='',error_message='',row_version=row_version+1,updated_at=NOW()
        WHERE id=$1`, [input.publicationId, input.packageRelPath, input.packageSignature]);
      await client.query(`UPDATE ozon_publish_jobs SET state='READY',payload=payload || jsonb_build_object(
          'attemptPhase','MATERIALIZED','productJsonPath',$2::text,'packageRelPath',$3::text
        ),task_folder=$4,work_rel_path=$3,directory_stage='INBOX',directory_signature=$5,
        last_error_code=NULL,last_error_message=NULL,next_attempt_at=NULL,row_version=row_version+1,updated_at=NOW()
        WHERE id=$1`, [input.jobId, input.productJsonPath, input.packageRelPath,
        `${publication.sku}__r${publication.revision}`, input.packageSignature]);
      await client.query(`INSERT INTO ozon_publish_events(
        id,job_id,event_type,from_state,to_state,message,payload,store_id,publication_id
      ) VALUES($1,$2,'MULTISTORE_PUBLICATION_MATERIALIZED',$3,'READY',$4,$5::jsonb,$6,$7)`, [
        randomUUID(), input.jobId, job.state, 'OZON 店铺 publication 已物化并加入调度队列',
        JSON.stringify({ packageSignature: input.packageSignature, materializationHash: input.materializationHash }),
        publication.store_id, input.publicationId
      ]);
      const queued = await client.query<SqlRow>(`UPDATE ozon_store_publications SET status='QUEUED',
        row_version=row_version+1,updated_at=NOW() WHERE id=$1 RETURNING *`, [input.publicationId]);
      return toPublication(queued.rows[0]!);
    });
  }

  async failPublicationAttempt(input: {
    publicationId: string;
    jobId: string;
    errorCode: string;
    errorMessage: string;
    phase: string;
    errorDetails?: JsonRecord;
  }): Promise<OzonStorePublication> {
    return this.transaction(async (client) => {
      const publication = (await client.query<SqlRow>(
        'SELECT * FROM ozon_store_publications WHERE id=$1 FOR UPDATE', [input.publicationId]
      )).rows[0];
      if (!publication) throw new AppError('NOT_FOUND', 'OZON publication attempt 不存在', undefined, 404);
      const job = (await client.query<SqlRow>(
        'SELECT * FROM ozon_publish_jobs WHERE id=$1 AND publication_id=$2 FOR UPDATE', [input.jobId, input.publicationId]
      )).rows[0];
      if (!job) throw new AppError('VERSION_CONFLICT', 'OZON publication attempt 缺少原 job', undefined, 409);
      const remoteEvidence = await client.query<{ exists: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM ozon_gateway_requests WHERE publication_id=$1
          AND (delivery_state='UNKNOWN' OR delegation_state='RECEIPT_RECORDED')
      ) exists`, [input.publicationId]);
      if (remoteEvidence.rows[0]?.exists) {
        throw new AppError('OZON_READBACK_REQUIRED', 'publication attempt 存在 UNKNOWN/已委托网关证据，禁止改写为本地失败', undefined, 409);
      }
      const errorMessage = input.errorMessage.slice(0, 2_000);
      await client.query(`UPDATE ozon_publish_jobs SET state='NEEDS_ATTENTION',last_error_code=$2,
        last_error_message=$3,payload=payload || jsonb_build_object(
          'attemptPhase',$4::text,
          'attemptFailureEvidence',$5::jsonb
        ),
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,row_version=row_version+1,updated_at=NOW()
        WHERE id=$1`, [
        input.jobId,
        input.errorCode,
        errorMessage,
        input.phase,
        JSON.stringify(redactCredentialLikeKeys(input.errorDetails || {}))
      ]);
      const updated = await client.query<SqlRow>(`UPDATE ozon_store_publications SET status='NEEDS_ATTENTION',
        error_code=$2,error_message=$3,row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 RETURNING *`, [input.publicationId, input.errorCode, errorMessage]);
      await client.query(`INSERT INTO ozon_publish_events(
        id,job_id,event_type,from_state,to_state,message,payload,store_id,publication_id
      ) VALUES($1,$2,'MULTISTORE_PUBLICATION_NEEDS_ATTENTION',$3,'NEEDS_ATTENTION',$4,$5::jsonb,$6,$7)`, [
        randomUUID(), input.jobId, job.state, errorMessage,
        JSON.stringify({
          errorCode: input.errorCode,
          phase: input.phase,
          errorDetails: redactCredentialLikeKeys(input.errorDetails || {})
        }), publication.store_id, input.publicationId
      ]);
      return toPublication(updated.rows[0]!);
    });
  }

  async createPublication(
    input: OzonPublicationInsert,
    mediaConsumption?: OzonPublicationMediaConsumption
  ): Promise<OzonStorePublication> {
    return this.transaction(async (client) => {
      const existing = await client.query<SqlRow>(`SELECT * FROM ozon_store_publications
        WHERE store_id=$1 AND generated_version_id=$2 FOR UPDATE`, [input.storeId, input.generatedVersionId]);
      if (existing.rows[0]) {
        if (mediaConsumption) {
          await upsertMediaConsumptionWithClient(client, {
            storeId: input.storeId,
            sku: input.sku,
            ...mediaConsumption,
            publicationId: String(existing.rows[0].id),
            decision: 'ALREADY_BOUND',
            reason: '当前生成版本已绑定该店铺 publication'
          });
        }
        return toPublication(existing.rows[0]);
      }
      const active = await client.query<SqlRow>(`SELECT id,state FROM ozon_publish_jobs
        WHERE store_id=$1 AND sku=$2 AND state=ANY($3::text[]) FOR UPDATE`, [input.storeId, input.sku, ACTIVE_JOB_STATES]);
      if (active.rows[0]) throw new AppError('TASK_LOCKED', '同一 OZON 店铺和 SKU 已有活动任务', {
        storeId: input.storeId, sku: input.sku, jobId: active.rows[0].id, state: active.rows[0].state
      }, 409);
      await client.query(`INSERT INTO ozon_store_publications(
        id,sku,generated_version_id,revision,store_id,store_alias_snapshot,store_display_name_snapshot,status,source,
        credential_binding_mode,credential_version_id,store_config_version,preset_id,preset_snapshot,preset_definition_hash,
        task_id,warehouse_id,warehouse_name,fulfillment_mode,account_currency,offer_ids,offer_contract_hash,
        materialization_hash,package_rel_path,package_signature
      ) VALUES($1,$2,$3,$4,$5,$6,$7,'MATERIALIZED',$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,
        $20::jsonb,$21,$22,$23,$24)`, [
        input.id, input.sku, input.generatedVersionId, input.revision, input.storeId, input.storeAlias,
        input.storeDisplayName, input.source, input.credentialBindingMode, input.credentialVersionId || null,
        input.storeConfigVersion, input.presetId || null, JSON.stringify(input.presetSnapshot || {}),
        input.presetDefinitionHash || '', input.taskId, input.warehouseId, input.warehouseName, input.fulfillmentMode,
        input.accountCurrency, JSON.stringify(input.offerIds), input.offerContractHash, input.materializationHash,
        input.packageRelPath, input.packageSignature
      ]);
      const payload = {
        schemaVersion: 3,
        mode: 'MULTISTORE_PUBLICATION',
        productJsonPath: input.productJsonPath,
        packageRelPath: input.packageRelPath,
        storeId: input.storeId,
        storeAlias: input.storeAlias,
        publicationId: input.id,
        presetId: input.presetId,
        presetName: input.presetName,
        presetRowVersion: input.presetRowVersion,
        credentialVersionId: input.credentialVersionId,
        credentialBindingMode: input.credentialBindingMode,
        storeConfigVersion: input.storeConfigVersion,
        warehouseId: input.warehouseId,
        offerContractHash: input.offerContractHash,
        materializationHash: input.materializationHash
      };
      await client.query(`INSERT INTO ozon_publish_jobs(
        id,sku,state,source,task_id,payload,stage_states,store_alias,offer_ids,product_links,
        task_folder,work_rel_path,directory_stage,directory_signature,listing_revision,
        store_id,publication_id,credential_version_id,credential_binding_mode,store_config_version,
        warehouse_id,offer_contract_hash,materialization_hash
      ) VALUES($1,$2,'READY',$3,$4,$5::jsonb,'{}'::jsonb,$6,$7::jsonb,'[]'::jsonb,$8,$9,'INBOX',$10,$11,
        $12,$13,$14,$15,$16,$17,$18,$19)`, [
        input.jobId, input.sku, input.source === 'AUTOMATION' ? 'AUTO' : 'MANUAL', input.taskId, JSON.stringify(payload),
        input.storeAlias, JSON.stringify(input.offerIds), `${input.sku}__r${input.revision}`, input.packageRelPath, input.packageSignature,
        input.revision, input.storeId, input.id, input.credentialVersionId || null, input.credentialBindingMode,
        input.storeConfigVersion, input.warehouseId, input.offerContractHash, input.materializationHash
      ]);
      await client.query(`INSERT INTO ozon_publish_events(
        id,job_id,event_type,to_state,message,payload,store_id,publication_id
      ) VALUES($1,$2,'MULTISTORE_PUBLICATION_CREATED','READY',$3,$4::jsonb,$5,$6)`, [
        randomUUID(), input.jobId, 'OZON 店铺 publication 已物化并加入调度队列',
        JSON.stringify({ taskId: input.taskId, materializationHash: input.materializationHash }), input.storeId, input.id
      ]);
      if (mediaConsumption) {
        await upsertMediaConsumptionWithClient(client, {
          storeId: input.storeId,
          sku: input.sku,
          ...mediaConsumption,
          publicationId: input.id,
          jobId: input.jobId
        });
      }
      const created = await client.query<SqlRow>(`UPDATE ozon_store_publications
        SET status='QUEUED',row_version=row_version+1,updated_at=NOW() WHERE id=$1 RETURNING *`, [input.id]);
      return toPublication(created.rows[0]!);
    });
  }

  async persistVersionMaterialContract(
    generatedVersionId: string,
    basePresetId: string | undefined,
    materialOverrides: JsonRecord
  ): Promise<void> {
    const result = await this.query(`UPDATE ozon_listing_versions SET
      base_preset_id=COALESCE(base_preset_id,(SELECT id FROM ozon_listing_presets WHERE id=$2::uuid)),
      material_overrides=$3::jsonb
      WHERE id=$1`, [generatedVersionId, basePresetId || null, JSON.stringify(materialOverrides)]);
    if (!result.rowCount) throw new AppError('VERSION_CONFLICT', 'OZON 生成版本已不存在', { generatedVersionId }, 409);
  }

  async listPublications(input: { sku?: string; skus?: string[]; storeId?: string; status?: string; source?: string } = {}): Promise<OzonStorePublication[]> {
    const values: unknown[] = [];
    const predicates: string[] = [];
    if (input.sku) { values.push(normalizeSku(input.sku)); predicates.push(`p.sku=$${values.length}`); }
    if (input.skus?.length) {
      const skus = [...new Set(input.skus.map(normalizeSku))];
      values.push(skus);
      predicates.push(`p.sku=ANY($${values.length}::text[])`);
    }
    if (input.storeId) { values.push(input.storeId); predicates.push(`p.store_id=$${values.length}::uuid`); }
    if (input.status) { values.push(input.status); predicates.push(`p.status=$${values.length}`); }
    if (input.source) { values.push(input.source); predicates.push(`p.source=$${values.length}`); }
    const result = await this.query<SqlRow>(`SELECT p.* FROM ozon_store_publications p
      ${predicates.length ? `WHERE ${predicates.join(' AND ')}` : ''}
      ORDER BY p.updated_at DESC,p.id DESC LIMIT 1000`, values);
    return result.rows.map(toPublication);
  }

  async listLatestManualPublicationTaskSummaries(skusInput: string[]): Promise<OzonPublicationTaskSummary[]> {
    const skus = [...new Set(skusInput.map(normalizeSku))];
    if (!skus.length) return [];
    const result = await this.query<SqlRow>(`WITH scoped AS (
        SELECT p.*,COALESCE(NULLIF(p.plan_hash,''),'legacy:'||p.generated_version_id::text) batch_key
        FROM ozon_store_publications p
        WHERE p.source='MANUAL' AND p.sku=ANY($1::text[])
      ),batches AS (
        SELECT sku,batch_key,MAX(created_at) batch_created_at FROM scoped GROUP BY sku,batch_key
      ),latest AS (
        SELECT DISTINCT ON (sku) sku,batch_key FROM batches
        ORDER BY sku,batch_created_at DESC,batch_key DESC
      )
      SELECT p.*,product.product_name,current_draft.revision current_material_revision,
        current_version.id current_generated_version_id,
        job.id summary_job_id,job.task_id summary_task_id,job.payload summary_job_payload,
        job.product_links summary_job_product_links,job.import_task_id summary_import_task_id,
        job.ozon_product_id summary_ozon_product_id,job.directory_stage summary_directory_stage,
        job.state summary_job_state,source_preset.id source_preset_id,
        store.enabled summary_store_enabled,store.archived_at summary_store_archived_at,
        COALESCE(gateway.unsafe_count,0) summary_unsafe_gateway_count
      FROM scoped p
      JOIN latest ON latest.sku=p.sku AND latest.batch_key=p.batch_key
      LEFT JOIN products product ON product.sku=p.sku
      LEFT JOIN ozon_listing_drafts current_draft ON current_draft.sku=p.sku
      LEFT JOIN LATERAL (
        SELECT id FROM ozon_listing_versions version
        WHERE version.sku=p.sku AND version.revision=current_draft.revision
        ORDER BY version.created_at DESC LIMIT 1
      ) current_version ON TRUE
      LEFT JOIN LATERAL (
        SELECT candidate.* FROM ozon_publish_jobs candidate
        WHERE candidate.publication_id=p.id
        ORDER BY candidate.updated_at DESC,candidate.id DESC LIMIT 1
      ) job ON TRUE
      LEFT JOIN ozon_listing_presets source_preset ON source_preset.id=p.preset_id
      LEFT JOIN ozon_stores store ON store.id=p.store_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::integer unsafe_count FROM ozon_gateway_requests request
        WHERE request.publication_id=p.id
          AND (request.delivery_state='UNKNOWN' OR request.retry_class='READBACK_REQUIRED')
      ) gateway ON TRUE
      ORDER BY p.updated_at DESC,p.id DESC`, [skus]);
    return result.rows.map(toPublicationTaskSummary);
  }

  async getSuccessfulOfferUnion(storeId: string, skuInput: string): Promise<string[]> {
    const sku = normalizeSku(skuInput);
    const result = await this.query<{ offer_id: string }>(`SELECT DISTINCT offer_id FROM (
      SELECT jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(p.offer_ids)='array' THEN p.offer_ids ELSE '[]'::jsonb END
      ) offer_id
      FROM ozon_store_publications p
      WHERE p.store_id=$1 AND p.sku=$2 AND p.status='SUCCEEDED'
      UNION
      SELECT m.offer_id FROM ozon_product_mappings m
      WHERE m.store_id=$1 AND m.sku=$2 AND NULLIF(m.ozon_product_id,'') IS NOT NULL
    ) preserved ORDER BY offer_id`, [storeId, sku]);
    return result.rows.map((row) => String(row.offer_id)).filter(Boolean);
  }

  async listEligibleAutoStores(deliveredAt: string): Promise<OzonEligibleAutoStore[]> {
    const delivered = new Date(deliveredAt);
    if (!Number.isFinite(delivered.getTime())) throw new AppError('CONFIG_INVALID', '媒体投递时间无效');
    // The capability flag is a deployment boundary, not only a UI hint. When
    // it is rolled back, no store (including the fixed default store) may
    // create a package that the still-legacy fleet cannot safely consume.
    if (!fleetCapabilityReady()) return [];
    const result = await this.query<SqlRow>(`${storeSelect()}
      WHERE s.enabled=true AND s.auto_publish_enabled=true AND s.archived_at IS NULL
        AND s.auto_publish_activated_at IS NOT NULL AND s.auto_publish_activated_at<=$1::timestamptz
      ORDER BY s.auto_publish_activated_at,s.id`, [delivered.toISOString()]);
    const stores: OzonEligibleAutoStore[] = [];
    for (const row of result.rows) {
      const store = toStore(row);
      if (!store.readiness.ready || !store.defaultPresetId) continue;
      const preset = await this.query<SqlRow>('SELECT definition,row_version FROM ozon_listing_presets WHERE id=$1', [store.defaultPresetId]);
      if (!preset.rows[0]) continue;
      stores.push({
        ...store,
        presetSnapshot: jsonObject(preset.rows[0].definition),
        presetRowVersion: Number(preset.rows[0].row_version)
      });
    }
    return stores;
  }

  async recordMediaConsumption(input: {
    storeId: string;
    sku: string;
    sourceStageId: string;
    submissionId: string;
    variantId?: string;
    deliveredAt: string;
    publicationId?: string;
    decision: string;
    reason?: string;
  }): Promise<void> {
    const pool = this.requirePool();
    await upsertMediaConsumptionWithClient(pool, input);
  }

  async finalizeMediaFanout(input: {
    sku: string;
    sourceStageId: string;
    submissionId: string;
    variantId?: string;
    publicationIds: string[];
    storeIds: string[];
  }): Promise<boolean> {
    const result = await this.query(`UPDATE ozon_media_deliveries SET
      payload=payload || jsonb_build_object(
        'autoPublishDecision','FANNED_OUT',
        'fanoutPublicationIds',$5::jsonb,
        'fanoutStoreIds',$6::jsonb,
        'fanoutCompletedAt',NOW()::text
      ),updated_at=NOW()
      WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4
        AND COALESCE(payload->>'autoPublishDecision','') IN ('ACCEPTED','DEFERRED')`, [
      normalizeSku(input.sku), String(input.sourceStageId), String(input.submissionId), String(input.variantId || ''),
      JSON.stringify([...new Set(input.publicationIds)]), JSON.stringify([...new Set(input.storeIds)])
    ]);
    return Boolean(result.rowCount);
  }

  async finalizeMediaFanoutBatch(input: {
    jobId: string;
    sku: string;
    deliveries: Array<{
      sourceStageId: string;
      submissionId: string;
      variantId?: string;
    }>;
    publicationIds: string[];
    storeIds: string[];
  }): Promise<boolean> {
    const sku = normalizeSku(input.sku);
    const identities = [...new Map(input.deliveries.map((delivery) => {
      const normalized = {
        sourceStageId: String(delivery.sourceStageId || '').trim(),
        submissionId: String(delivery.submissionId || '').trim(),
        variantId: String(delivery.variantId || '').trim()
      };
      return [`${normalized.sourceStageId}\u0000${normalized.submissionId}\u0000${normalized.variantId}`, normalized];
    })).values()];
    if (!identities.length || identities.some((identity) => !identity.sourceStageId || !identity.submissionId)) {
      throw new AppError('CONFIG_INVALID', 'OZON fan-out 媒体账本身份不完整', { jobId: input.jobId }, 409);
    }
    const publicationIds = [...new Set(input.publicationIds.map(String).filter(Boolean))];
    const storeIds = [...new Set(input.storeIds.map(String).filter(Boolean))];
    if (!publicationIds.length || publicationIds.length !== storeIds.length) {
      throw new AppError('CONFIG_INVALID', 'OZON fan-out 仅允许在每个目标店铺均有 publication 后完成媒体账本', {
        jobId: input.jobId,
        publicationCount: publicationIds.length,
        storeCount: storeIds.length
      }, 409);
    }
    return this.transaction(async (client) => {
      const rows = await client.query<SqlRow>(`WITH expected(source_stage_id,submission_id,variant_id) AS (
          SELECT * FROM unnest($2::text[],$3::text[],$4::text[])
        )
        SELECT d.* FROM ozon_media_deliveries d JOIN expected e
          ON e.source_stage_id=d.source_stage_id
         AND e.submission_id=d.submission_id
         AND e.variant_id=d.variant_id
        WHERE d.sku=$1
        FOR UPDATE OF d`, [
        sku,
        identities.map((identity) => identity.sourceStageId),
        identities.map((identity) => identity.submissionId),
        identities.map((identity) => identity.variantId)
      ]);
      if (rows.rows.length !== identities.length) {
        throw new AppError('OZON_MEDIA_DELIVERY_IDENTITY_DRIFT', 'OZON fan-out 冻结媒体账本数量已变化', {
          jobId: input.jobId,
          expected: identities.length,
          actual: rows.rows.length
        }, 409);
      }
      const publications = await client.query<SqlRow>(`SELECT id,store_id,preparation_job_id,status
        FROM ozon_store_publications
        WHERE id=ANY($1::uuid[])
        FOR SHARE`, [publicationIds]);
      const publicationStoreIds = publications.rows.map((row) => String(row.store_id || '')).sort();
      if (publications.rows.length !== publicationIds.length
        || stableJson(publicationStoreIds) !== stableJson([...storeIds].sort())
        || publications.rows.some((row) => (
          String(row.preparation_job_id || '') !== input.jobId
          || !['QUEUED', 'RUNNING', 'SUCCEEDED'].includes(String(row.status || ''))
        ))) {
        throw new AppError('VERSION_CONFLICT', 'OZON fan-out publication 集合未完整持久化，禁止完成媒体账本', {
          jobId: input.jobId,
          expectedPublicationIds: publicationIds,
          expectedStoreIds: storeIds
        }, 409);
      }
      let alreadyCompleted = 0;
      for (const row of rows.rows) {
        if (String(row.job_id || '') !== input.jobId) {
          throw new AppError('OZON_MEDIA_DELIVERY_IDENTITY_DRIFT', 'OZON fan-out 媒体账本已绑定其他准备任务', {
            jobId: input.jobId,
            mediaJobId: row.job_id || undefined,
            sourceStageId: row.source_stage_id,
            submissionId: row.submission_id,
            variantId: row.variant_id
          }, 409);
        }
        const payload = jsonObject(row.payload);
        const decision = String(payload.autoPublishDecision || '');
        if (decision === 'FANNED_OUT') {
          const samePublications = stableJson(normalizeStringArray(payload.fanoutPublicationIds).sort())
            === stableJson([...publicationIds].sort());
          const sameStores = stableJson(normalizeStringArray(payload.fanoutStoreIds).sort())
            === stableJson([...storeIds].sort());
          if (!samePublications || !sameStores) {
            throw new AppError('VERSION_CONFLICT', 'OZON fan-out 媒体账本已按不同 publication 集合完成', {
              jobId: input.jobId
            }, 409);
          }
          alreadyCompleted += 1;
        } else if (!['ACCEPTED', 'DEFERRED'].includes(decision)) {
          throw new AppError('OZON_MEDIA_DELIVERY_IDENTITY_DRIFT', 'OZON fan-out 媒体账本状态已变化', {
            jobId: input.jobId,
            decision
          }, 409);
        }
      }
      if (alreadyCompleted === identities.length) return true;
      if (alreadyCompleted > 0) {
        throw new AppError('VERSION_CONFLICT', 'OZON fan-out 媒体账本出现部分完成，已停止并要求人工核验', {
          jobId: input.jobId,
          completed: alreadyCompleted,
          expected: identities.length
        }, 409);
      }
      const updated = await client.query(`WITH expected(source_stage_id,submission_id,variant_id) AS (
          SELECT * FROM unnest($2::text[],$3::text[],$4::text[])
        )
        UPDATE ozon_media_deliveries d SET
          payload=d.payload || jsonb_build_object(
            'autoPublishDecision','FANNED_OUT',
            'fanoutPublicationIds',$5::jsonb,
            'fanoutStoreIds',$6::jsonb,
            'fanoutCompletedAt',NOW()::text
          ),updated_at=NOW()
        FROM expected e
        WHERE d.sku=$1
          AND e.source_stage_id=d.source_stage_id
          AND e.submission_id=d.submission_id
          AND e.variant_id=d.variant_id
          AND d.job_id=$7::uuid
          AND COALESCE(d.payload->>'autoPublishDecision','') IN ('ACCEPTED','DEFERRED')`, [
        sku,
        identities.map((identity) => identity.sourceStageId),
        identities.map((identity) => identity.submissionId),
        identities.map((identity) => identity.variantId),
        JSON.stringify(publicationIds),
        JSON.stringify(storeIds),
        input.jobId
      ]);
      if (updated.rowCount !== identities.length) {
        throw new AppError('TASK_LOCKED', 'OZON fan-out 媒体账本原子 CAS 未完整命中', {
          jobId: input.jobId,
          expected: identities.length,
          actual: updated.rowCount
        }, 409);
      }
      return true;
    });
  }

  async reconcileRepresentedMediaFanoutPreparation(input: {
    jobId: string;
    expectedRowVersion: number;
    dryRun: boolean;
  }): Promise<OzonRepresentedMediaFanoutReconciliationResult> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.jobId)) {
      throw new AppError('CONFIG_INVALID', 'OZON fan-out 准备任务 ID 无效');
    }
    if (!Number.isSafeInteger(input.expectedRowVersion) || input.expectedRowVersion < 1) {
      throw new AppError('CONFIG_INVALID', 'OZON fan-out 准备任务 rowVersion 必须是正整数');
    }
    const client = await this.requirePool().connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const jobResult = await client.query<SqlRow>(
        'SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE', [input.jobId]
      );
      const job = jobResult.rows[0];
      if (!job) throw new AppError('NOT_FOUND', 'OZON fan-out 准备任务不存在', { jobId: input.jobId }, 404);
      const sku = normalizeSku(job.sku);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ozon-represented-media:${sku}`]);
      const jobPayload = jsonObject(job.payload);
      const prior = jsonObject(jobPayload.representedMediaFanoutReconciliation);
      const alreadyReconciled = String(job.state) === 'SUCCEEDED'
        && prior.completed === true
        && String(prior.evidenceHash || '').startsWith('sha256:');
      if (alreadyReconciled) {
        const acceptedVersion = Number(prior.expectedRowVersion);
        if (input.expectedRowVersion !== Number(job.row_version) && input.expectedRowVersion !== acceptedVersion) {
          assertRowVersion(input.expectedRowVersion, job.row_version, 'OZON fan-out 准备任务');
        }
      } else {
        assertRowVersion(input.expectedRowVersion, job.row_version, 'OZON fan-out 准备任务');
        assertRepresentedMediaPreparationJob(job);
      }

      const frozenDeliveries = normalizeArray(jobPayload.mediaDeliveries).map((entry) => {
        const payload = jsonObject(entry);
        const identity = representedMediaIdentity(payload);
        assertDurablyAcceptedPreparationDelivery(payload, identity, input.jobId);
        return { identity, payload, acceptedPayloadHash: sha256(payload) };
      });
      if (!frozenDeliveries.length) {
        throw new AppError('VERSION_CONFLICT', 'OZON fan-out 准备任务没有冻结媒体投递', { jobId: input.jobId }, 409);
      }
      const deliveryKeys = frozenDeliveries.map((entry) => representedMediaIdentityKey(entry.identity));
      if (new Set(deliveryKeys).size !== deliveryKeys.length) {
        throw new AppError('VERSION_CONFLICT', 'OZON fan-out 准备任务存在重复媒体投递身份', { jobId: input.jobId }, 409);
      }
      const lockedTargetDeliveries = new Map<string, SqlRow>();
      for (const delivery of [...frozenDeliveries].sort((left, right) =>
        representedMediaIdentityKey(left.identity).localeCompare(representedMediaIdentityKey(right.identity)))) {
        const locked = await client.query<SqlRow>(`SELECT * FROM ozon_media_deliveries
          WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4 FOR UPDATE`, [
          sku, delivery.identity.sourceStageId, delivery.identity.submissionId, delivery.identity.variantId
        ]);
        const row = locked.rows[0];
        if (locked.rows.length !== 1 || !row || String(row.job_id || '') !== input.jobId) {
          throw new AppError('TASK_LOCKED', 'OZON 目标媒体账本身份或归属已变化', {
            jobId: input.jobId, delivery: delivery.identity
          }, 409);
        }
        const rowPayload = jsonObject(row.payload);
        if (alreadyReconciled) {
          const marker = jsonObject(rowPayload.representedMediaFanoutReconciliation);
          if (String(rowPayload.autoPublishDecision || '') !== 'FANNED_OUT'
            || String(marker.evidenceHash || '') !== String(prior.evidenceHash || '')
            || String(marker.acceptedPayloadHash || '') !== delivery.acceptedPayloadHash) {
            throw new AppError('TASK_LOCKED', 'OZON 已收口媒体账本证据已漂移', {
              jobId: input.jobId, delivery: delivery.identity
            }, 409);
          }
        } else if (String(rowPayload.autoPublishDecision || '') !== 'ACCEPTED'
          || stableJson(rowPayload) !== stableJson(delivery.payload)) {
          throw new AppError('TASK_LOCKED', 'OZON 目标媒体账本内容已变化', {
            jobId: input.jobId, delivery: delivery.identity
          }, 409);
        }
        lockedTargetDeliveries.set(representedMediaIdentityKey(delivery.identity), row);
      }

      const anchorRows = await client.query<SqlRow>(`SELECT * FROM ozon_media_deliveries
        WHERE sku=$1 AND job_id IS NOT NULL AND job_id<>$2
          AND payload->>'autoPublishDecision'='FANNED_OUT'
        ORDER BY source_stage_id,submission_id,variant_id FOR UPDATE`, [sku, input.jobId]);
      const anchorJobIds = normalizeStringArray(anchorRows.rows.map((row) => row.job_id));
      if (!anchorJobIds.length) {
        throw new AppError('VERSION_CONFLICT', 'OZON 找不到已完成的 fan-out 键点证据', { jobId: input.jobId }, 409);
      }
      const anchorJobs = await client.query<SqlRow>(`SELECT * FROM ozon_publish_jobs
        WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [anchorJobIds]);
      const anchorJobById = new Map(anchorJobs.rows.map((row) => [String(row.id), row]));
      const candidates = anchorRows.rows.flatMap((anchor) => {
        const anchorPayload = jsonObject(anchor.payload);
        const anchorJob = anchorJobById.get(String(anchor.job_id));
        const fanout = jsonObject(jsonObject(anchorJob?.payload).multistoreFanout);
        const publicationIds = normalizeStringArray(anchorPayload.fanoutPublicationIds).sort();
        const storeIds = normalizeStringArray(anchorPayload.fanoutStoreIds).sort();
        const jobPublicationIds = normalizeStringArray(fanout.publicationIds).sort();
        const jobStoreIds = normalizeStringArray(fanout.storeIds).sort();
        if (!anchorJob || String(anchorJob.sku) !== sku || String(anchorJob.state) !== 'SUCCEEDED'
          || jsonObject(anchorJob.payload).multistorePreparation !== true || fanout.completed !== true
          || normalizeArray(fanout.failures).length || !publicationIds.length || !storeIds.length
          || stableJson(publicationIds) !== stableJson(jobPublicationIds)
          || stableJson(storeIds) !== stableJson(jobStoreIds)) return [];
        return [{ anchor, anchorJob, publicationIds, storeIds }];
      });
      const candidatePublicationIds = normalizeStringArray(candidates.flatMap((candidate) => candidate.publicationIds));
      const publicationRows = candidatePublicationIds.length
        ? await client.query<SqlRow>(`SELECT * FROM ozon_store_publications
            WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [candidatePublicationIds])
        : { rows: [] as SqlRow[] };
      const publicationById = new Map(publicationRows.rows.map((row) => [String(row.id), row]));
      const structurallyValid = candidates.flatMap((candidate) => {
        const publications = candidate.publicationIds.map((id) => publicationById.get(id)).filter(Boolean) as SqlRow[];
        const versionIds = normalizeStringArray(publications.map((row) => row.generated_version_id));
        const actualStores = normalizeStringArray(publications.map((row) => row.store_id)).sort();
        if (publications.length !== candidate.publicationIds.length || versionIds.length !== 1
          || publications.some((row) => String(row.sku) !== sku || String(row.status) !== 'SUCCEEDED')
          || stableJson(actualStores) !== stableJson(candidate.storeIds)) return [];
        return [{ ...candidate, publications, generatedVersionId: versionIds[0]! }];
      });
      const versionIds = normalizeStringArray(structurallyValid.map((candidate) => candidate.generatedVersionId));
      const versions = versionIds.length
        ? await client.query<SqlRow>(`SELECT * FROM ozon_listing_versions
            WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE`, [versionIds])
        : { rows: [] as SqlRow[] };
      const versionById = new Map(versions.rows.map((row) => [String(row.id), row]));
      const publicationJobs = candidatePublicationIds.length
        ? await client.query<SqlRow>(`SELECT * FROM ozon_publish_jobs
            WHERE publication_id=ANY($1::uuid[]) ORDER BY publication_id,created_at,id FOR UPDATE`, [candidatePublicationIds])
        : { rows: [] as SqlRow[] };
      const validCandidates: Array<(typeof structurallyValid)[number] & {
        version: SqlRow;
        publicationJobs: SqlRow[];
        deliveryEvidence: ReturnType<typeof proveSnapshotRepresentsDelivery>[];
      }> = [];
      for (const candidate of structurallyValid) {
        const version = versionById.get(candidate.generatedVersionId);
        if (!version || String(version.sku) !== sku) continue;
        const allForVersion = await client.query<SqlRow>(`SELECT id FROM ozon_store_publications
          WHERE sku=$1 AND generated_version_id=$2 ORDER BY id FOR UPDATE`, [sku, candidate.generatedVersionId]);
        if (stableJson(normalizeStringArray(allForVersion.rows.map((row) => row.id)).sort())
          !== stableJson(candidate.publicationIds)) continue;
        const jobs = publicationJobs.rows.filter((row) => candidate.publicationIds.includes(String(row.publication_id)));
        if (jobs.length !== candidate.publications.length || candidate.publications.some((publication) => {
          const matches = jobs.filter((jobRow) => String(jobRow.publication_id) === String(publication.id));
          return matches.length !== 1 || String(matches[0]!.state) !== 'SUCCEEDED'
            || String(matches[0]!.store_id) !== String(publication.store_id)
            || String(matches[0]!.task_id) !== String(publication.task_id)
            || Number(matches[0]!.listing_revision) !== Number(publication.revision);
        })) continue;
        try {
          const deliveryEvidence = frozenDeliveries.map((delivery) =>
            proveSnapshotRepresentsDelivery(version.snapshot, delivery.identity, delivery.payload));
          proveSnapshotRepresentsDelivery(version.snapshot, representedMediaIdentity(jsonObject(candidate.anchor.payload)), jsonObject(candidate.anchor.payload));
          validCandidates.push({ ...candidate, version, publicationJobs: jobs, deliveryEvidence });
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
        }
      }
      const candidateKeys = new Set(validCandidates.map((candidate) => stableJson({
        generatedVersionId: candidate.generatedVersionId,
        publicationIds: candidate.publicationIds,
        storeIds: candidate.storeIds
      })));
      if (candidateKeys.size !== 1 || !validCandidates.length) {
        throw new AppError('VERSION_CONFLICT', 'OZON 无法唯一证明媒体已被原 fan-out publication 引用', {
          jobId: input.jobId, candidateCount: candidateKeys.size
        }, 409);
      }
      const candidate = validCandidates.sort((left, right) => String(left.anchor.received_at)
        .localeCompare(String(right.anchor.received_at)))[0]!;
      const mappings = await client.query<SqlRow>(`SELECT * FROM ozon_product_mappings
        WHERE sku=$1 AND store_id=ANY($2::uuid[]) ORDER BY store_id,offer_id FOR SHARE`, [sku, candidate.storeIds]);
      for (const publication of candidate.publications) {
        const offerIds = normalizeStringArray(publication.offer_ids);
        const validOffers = mappings.rows.filter((mapping) => String(mapping.store_id) === String(publication.store_id)
          && offerIds.includes(String(mapping.offer_id)) && /^\d+$/.test(String(mapping.ozon_product_id || ''))
          && /^\d+$/.test(String(mapping.ozon_sku || ''))
          && Number(mapping.last_applied_revision) >= Number(publication.revision));
        if (!offerIds.length || validOffers.length !== offerIds.length) {
          throw new AppError('VERSION_CONFLICT', 'OZON publication 缺少完整的成功平台映射', {
            publicationId: publication.id
          }, 409);
        }
      }
      const evidence = {
        schemaVersion: 1,
        jobId: input.jobId,
        sku,
        expectedRowVersion: alreadyReconciled ? Number(prior.expectedRowVersion) : input.expectedRowVersion,
        acceptedPayloadHashes: frozenDeliveries.map((delivery) => delivery.acceptedPayloadHash).sort(),
        deliveryIdentities: frozenDeliveries.map((delivery) => delivery.identity)
          .sort((left, right) => representedMediaIdentityKey(left).localeCompare(representedMediaIdentityKey(right))),
        anchorJobId: String(candidate.anchorJob.id),
        anchorDelivery: representedMediaIdentity(jsonObject(candidate.anchor.payload)),
        generatedVersionId: candidate.generatedVersionId,
        revision: Number(candidate.version.revision),
        versionSnapshotHash: sha256(candidate.version.snapshot),
        publicationIds: candidate.publicationIds,
        storeIds: candidate.storeIds,
        publicationJobIds: candidate.publicationJobs.map((row) => String(row.id)).sort(),
        assets: candidate.deliveryEvidence.flatMap((entry) => entry.assets)
      };
      const evidenceHash = sha256(evidence);
      if (alreadyReconciled) {
        if (String(prior.evidenceHash || '') !== evidenceHash) {
          throw new AppError('TASK_LOCKED', 'OZON 已收口任务的 immutable evidence 已漂移', { jobId: input.jobId }, 409);
        }
        await client.query('COMMIT');
        return representedMediaReconciliationResult('ALREADY_RECONCILED', input.dryRun, job, candidate, evidence, evidenceHash);
      }
      if (input.dryRun) {
        await client.query('COMMIT');
        return representedMediaReconciliationResult('DRY_RUN', true, job, candidate, evidence, evidenceHash);
      }

      const reconciledAt = new Date().toISOString();
      for (let index = 0; index < frozenDeliveries.length; index += 1) {
        const delivery = frozenDeliveries[index]!;
        const ledger = lockedTargetDeliveries.get(representedMediaIdentityKey(delivery.identity))!;
        const marker = { completed: true, completedAt: reconciledAt, evidenceHash, acceptedPayloadHash: delivery.acceptedPayloadHash };
        const updated = await client.query(`UPDATE ozon_media_deliveries SET
          payload=payload || jsonb_build_object(
            'autoPublishDecision','FANNED_OUT','fanoutPublicationIds',$6::jsonb,'fanoutStoreIds',$7::jsonb,
            'fanoutGeneratedVersionId',$8::text,'fanoutCompletedAt',$9::text,
            'representedMediaFanoutReconciliation',$10::jsonb
          ),updated_at=NOW()
          WHERE sku=$1 AND source_stage_id=$2 AND submission_id=$3 AND variant_id=$4
            AND job_id=$5 AND payload=$11::jsonb AND payload->>'autoPublishDecision'='ACCEPTED'`, [
          sku, delivery.identity.sourceStageId, delivery.identity.submissionId, delivery.identity.variantId,
          input.jobId, JSON.stringify(candidate.publicationIds), JSON.stringify(candidate.storeIds),
          candidate.generatedVersionId, reconciledAt, JSON.stringify(marker), JSON.stringify(ledger.payload)
        ]);
        if (updated.rowCount !== 1) throw new AppError('TASK_LOCKED', 'OZON 目标媒体账本 CAS 失败', { delivery: delivery.identity }, 409);
      }
      for (const publication of candidate.publications.sort((left, right) => String(left.store_id).localeCompare(String(right.store_id)))) {
        const publicationJob = candidate.publicationJobs.find((row) => String(row.publication_id) === String(publication.id))!;
        for (const delivery of frozenDeliveries) {
          const inserted = await client.query(`INSERT INTO ozon_store_media_consumptions(
            store_id,sku,source_stage_id,submission_id,variant_id,decision,publication_id,job_id,reason
          ) VALUES($1,$2,$3,$4,$5,'ALREADY_BOUND',$6,$7,$8)
          ON CONFLICT(store_id,sku,source_stage_id,submission_id,variant_id) DO UPDATE SET
            decision=EXCLUDED.decision,publication_id=EXCLUDED.publication_id,job_id=EXCLUDED.job_id,
            reason=EXCLUDED.reason,updated_at=NOW()
          WHERE (ozon_store_media_consumptions.publication_id IS NULL
              OR ozon_store_media_consumptions.publication_id=EXCLUDED.publication_id)
            AND (ozon_store_media_consumptions.job_id IS NULL
              OR ozon_store_media_consumptions.job_id=EXCLUDED.job_id)
          RETURNING store_id`, [
            publication.store_id, sku, delivery.identity.sourceStageId,
            delivery.identity.submissionId, delivery.identity.variantId,
            publication.id, publicationJob.id, 'immutable generated version 已引用该媒体投递'
          ]);
          if (inserted.rowCount !== 1) {
            throw new AppError('TASK_LOCKED', 'OZON 每店媒体消费记录已绑定其他 publication', {
              storeId: publication.store_id, delivery: delivery.identity
            }, 409);
          }
        }
      }
      const completion = {
        completed: true,
        completedAt: reconciledAt,
        expectedRowVersion: input.expectedRowVersion,
        evidenceHash,
        generatedVersionId: candidate.generatedVersionId,
        anchorJobId: String(candidate.anchorJob.id),
        publicationIds: candidate.publicationIds,
        storeIds: candidate.storeIds,
        deliveryIdentities: evidence.deliveryIdentities
      };
      const updatedJob = await client.query<SqlRow>(`UPDATE ozon_publish_jobs SET
        state='SUCCEEDED',finished_at=NOW(),last_error_code=NULL,last_error_message=NULL,next_attempt_at=NULL,
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
        payload=payload || jsonb_build_object(
          'multistoreFanout',$3::jsonb,'representedMediaFanoutReconciliation',$4::jsonb
        ),row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 AND row_version=$2 AND state='NEEDS_ATTENTION' AND payload=$5::jsonb
        RETURNING *`, [
        input.jobId, input.expectedRowVersion,
        JSON.stringify({ completed: true, completedAt: reconciledAt, publicationIds: candidate.publicationIds, storeIds: candidate.storeIds, failures: [] }),
        JSON.stringify(completion), JSON.stringify(job.payload)
      ]);
      if (updatedJob.rowCount !== 1) throw new AppError('TASK_LOCKED', 'OZON fan-out 准备任务 CAS 失败', { jobId: input.jobId }, 409);
      await client.query(`INSERT INTO ozon_publish_events(
        id,job_id,event_type,from_state,to_state,message,payload,store_id,publication_id
      ) VALUES($1,$2,'MULTISTORE_REPRESENTED_MEDIA_RECONCILED','NEEDS_ATTENTION','SUCCEEDED',$3,$4::jsonb,$5,NULL)`, [
        randomUUID(), input.jobId, '已由 immutable generated version 证明媒体被原多店 publication 引用并原子收口',
        JSON.stringify(completion), job.store_id
      ]);
      await client.query('COMMIT');
      return representedMediaReconciliationResult('RECONCILED', false, updatedJob.rows[0]!, candidate, evidence, evidenceHash, Number(job.row_version));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeFanoutPreparation(jobId: string, input: {
    publicationIds: string[];
    storeIds: string[];
    failures?: unknown[];
  }): Promise<void> {
    await this.transaction(async (client) => {
      const result = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE', [jobId]);
      const job = result.rows[0];
      if (!job) throw new AppError('NOT_FOUND', 'OZON fan-out 准备任务不存在', { jobId }, 404);
      const payload = jsonObject(job.payload);
      if (payload.multistorePreparation !== true) {
        throw new AppError('CONFIG_INVALID', '任务不是 OZON 多店铺 fan-out 准备任务', { jobId }, 409);
      }
      const priorCompletion = jsonObject(payload.multistoreFanout);
      if (String(job.state) === 'SUCCEEDED' && priorCompletion.completed === true) {
        const samePublications = stableJson(normalizeStringArray(priorCompletion.publicationIds).sort())
          === stableJson([...new Set(input.publicationIds)].sort());
        const sameStores = stableJson(normalizeStringArray(priorCompletion.storeIds).sort())
          === stableJson([...new Set(input.storeIds)].sort());
        if (!samePublications || !sameStores || (input.failures?.length)) {
          throw new AppError('VERSION_CONFLICT', '已完成的 OZON fan-out 冻结结果不允许改写', { jobId }, 409);
        }
        return;
      }
      if (['FAILED', 'CANCELLED'].includes(String(job.state))) {
        throw new AppError('TASK_LOCKED', 'OZON fan-out 准备任务已终止', { jobId, state: job.state }, 409);
      }
      const publicationIds = [...new Set(input.publicationIds)];
      const storeIds = [...new Set(input.storeIds)];
      const failures = Array.isArray(input.failures) ? input.failures : [];
      const completed = storeIds.length > 0 && publicationIds.length === storeIds.length && failures.length === 0;
      const nextState = completed ? 'SUCCEEDED' : 'NEEDS_ATTENTION';
      const completion = {
        completed,
        completedAt: new Date().toISOString(),
        publicationIds,
        storeIds,
        failures
      };
      const fanoutSummary = {
        phase: completed ? 'COMPLETED' : 'NEEDS_ATTENTION',
        targetStoreCount: storeIds.length,
        publicationCount: publicationIds.length,
        failureCount: failures.length || Math.max(0, storeIds.length - publicationIds.length),
        canRecheck: !completed,
        canManualTakeover: !completed,
        recoveryMode: completed ? 'NONE' : 'RECHECK',
        ...(!completed ? { blockedReason: failures.length ? 'STORE_MATERIALIZATION_FAILED' : 'FANOUT_INCOMPLETE' } : {})
      };
      await client.query(`UPDATE ozon_publish_jobs SET state=$2,finished_at=CASE WHEN $2='SUCCEEDED' THEN NOW() ELSE NULL END,
        last_error_code=CASE WHEN $2='NEEDS_ATTENTION' THEN 'OZON_AUTOMATIC_FANOUT_INCOMPLETE' ELSE NULL END,
        last_error_message=CASE WHEN $2='NEEDS_ATTENTION' THEN 'OZON 逐店 publication 未全部建立，请按原冻结计划重检' ELSE NULL END,
        payload=payload || jsonb_build_object('multistoreFanout',$3::jsonb,'fanoutSummary',$4::jsonb),
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,row_version=row_version+1,updated_at=NOW()
        WHERE id=$1`, [jobId, nextState, JSON.stringify(completion), JSON.stringify(fanoutSummary)]);
      await client.query(`INSERT INTO ozon_publish_events(
        id,job_id,event_type,from_state,to_state,message,payload,store_id,publication_id
      ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`, [
        randomUUID(), jobId, completed ? 'MULTISTORE_FANOUT_COMPLETED' : 'MULTISTORE_FANOUT_NEEDS_ATTENTION',
        job.state, nextState, completed ? 'OZON 共享媒体 fan-out 准备任务已完成' : 'OZON 共享媒体 fan-out 存在未完成店铺',
        JSON.stringify({ ...completion, fanoutSummary }), job.store_id, job.publication_id || null
      ]);
    });
  }

  async freezePreparationFanoutPlan(jobId: string, expectedRowVersion: number, plan: JsonRecord): Promise<JsonRecord> {
    return this.transaction(async (client) => {
      const result = await client.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE', [jobId]);
      const job = result.rows[0];
      if (!job) throw new AppError('NOT_FOUND', 'OZON 共享准备任务不存在', { jobId }, 404);
      if (String(job.task_kind || '') !== 'SHARED_PREPARATION'
        && jsonObject(job.payload).multistorePreparation !== true) {
        throw new AppError('CONFIG_INVALID', '任务不是 OZON 共享准备协调任务', { jobId }, 409);
      }
      const payload = jsonObject(job.payload);
      const frozen = jsonObject(payload.fanoutPlan);
      const planItems = normalizeArray(plan.items).map(jsonObject);
      const planStoreIds = normalizeStringArray(planItems.map((item) => item.storeId));
      const planPublicationIds = normalizeStringArray(planItems.map((item) => item.publicationId));
      const planJobIds = normalizeStringArray(planItems.map((item) => item.plannedJobId));
      const planTaskIds = normalizeStringArray(planItems.map((item) => item.taskId));
      if (Object.keys(frozen).length) {
        const frozenStoreIds = normalizeStringArray(normalizeArray(frozen.items).map((item) => jsonObject(item).storeId));
        if (String(frozen.planHash || '') !== String(plan.planHash || '')
          || stableJson(frozenStoreIds.sort()) !== stableJson([...planStoreIds].sort())) {
          throw new AppError('VERSION_CONFLICT', '共享准备任务已冻结不同的逐店 fan-out 计划', { jobId }, 409);
        }
        return frozen;
      }
      if (Number(job.row_version) !== expectedRowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 共享准备任务在冻结 fan-out 前已变化', {
          jobId, expected: Number(job.row_version), actual: expectedRowVersion
        }, 409);
      }
      if (!/^sha256:[a-f0-9]{64}$/.test(String(plan.planHash || ''))
        || !/^sha256:[a-f0-9]{64}$/.test(String(plan.frozenContractHash || ''))
        || !planStoreIds.length
        || planStoreIds.length !== planPublicationIds.length
        || planStoreIds.length !== planJobIds.length
        || planStoreIds.length !== planTaskIds.length) {
        throw new AppError('CONFIG_INVALID', 'OZON fan-out 冻结计划缺少完整的固定身份', { jobId }, 409);
      }
      // Persist the signed contract byte-for-byte. Operational timestamps and
      // the parent CAS version belong to the event/summary, not inside the
      // signed object consumed by createAutomaticPublicationsFromFrozenPlan.
      const frozenPlan = structuredClone(plan);
      const nextState = ['NEEDS_ATTENTION', 'FAILED'].includes(String(job.state)) ? 'READY' : String(job.state);
      const summary = {
        phase: 'PLANNED',
        targetStoreCount: planStoreIds.length,
        publicationCount: 0,
        failureCount: 0,
        canRecheck: false,
        canManualTakeover: false,
        recoveryMode: 'NONE'
      };
      const updated = await client.query(`UPDATE ozon_publish_jobs SET
        payload=payload || jsonb_build_object('fanoutPlan',$3::jsonb,'fanoutSummary',$4::jsonb),
        state=$5,last_error_code=NULL,last_error_message=NULL,next_attempt_at=NULL,finished_at=NULL,
        row_version=row_version+1,updated_at=NOW() WHERE id=$1 AND row_version=$2`, [
        jobId, expectedRowVersion, JSON.stringify(frozenPlan), JSON.stringify(summary), nextState
      ]);
      if (updated.rowCount !== 1) throw new AppError('TASK_LOCKED', 'OZON fan-out 冻结 CAS 失败', { jobId }, 409);
      await client.query(`INSERT INTO ozon_publish_events(
        id,job_id,event_type,from_state,to_state,message,payload,store_id,publication_id
      ) VALUES($1,$2,'MULTISTORE_FANOUT_PLAN_FROZEN',$3,$7,$4,$5::jsonb,$6,NULL)`, [
        randomUUID(), jobId, job.state, 'OZON 逐店 fan-out 计划与子任务身份已冻结',
        JSON.stringify({
          planHash: plan.planHash,
          frozenContractHash: plan.frozenContractHash,
          frozenAt: new Date().toISOString(),
          frozenByJobRowVersion: expectedRowVersion,
          storeIds: planStoreIds,
          publicationIds: planPublicationIds,
          plannedJobIds: planJobIds,
          taskIds: planTaskIds
        }), job.store_id, nextState
      ]);
      return frozenPlan;
    });
  }

  async getPublication(publicationId: string): Promise<OzonStorePublication> {
    const result = await this.query<SqlRow>('SELECT * FROM ozon_store_publications WHERE id=$1', [publicationId]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'OZON publication 不存在', { publicationId }, 404);
    return toPublication(result.rows[0]);
  }

  async getPublicationRecoveryArtifact(publicationId: string): Promise<{
    publication: OzonStorePublication;
    materializedProductSnapshot: JsonRecord;
  }> {
    const result = await this.query<SqlRow>(`SELECT * FROM ozon_store_publications WHERE id=$1`, [publicationId]);
    const row = result.rows[0];
    if (!row) throw new AppError('NOT_FOUND', 'OZON publication 不存在', { publicationId }, 404);
    return {
      publication: toPublication(row),
      materializedProductSnapshot: jsonObject(row.materialized_product_snapshot)
    };
  }

  async getPublicationTaskDetail(publicationId: string): Promise<OzonPublicationTaskDetail> {
    const result = await this.query<SqlRow>(`SELECT p.*,row_to_json(j) job_row,
        settings.enabled system_enabled,settings.admin_api_webhook_url,
        COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.created_at,e.id)
          FROM ozon_publish_events e WHERE e.publication_id=p.id),'[]'::jsonb) events,
        COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.created_at,g.request_ref)
          FROM ozon_gateway_requests g WHERE g.publication_id=p.id),'[]'::jsonb) gateway_rows
      FROM ozon_store_publications p
      LEFT JOIN ozon_publish_jobs j ON j.id=p.planned_job_id AND j.publication_id=p.id
      LEFT JOIN ozon_system_settings settings ON settings.id='default'
      WHERE p.id=$1`, [publicationId]);
    const row = result.rows[0];
    if (!row) throw new AppError('NOT_FOUND', 'OZON publication 不存在', { publicationId }, 404);
    const jobRow = jsonObject(row.job_row);
    const gateways = normalizeArray(row.gateway_rows).map(jsonObject);
    const jobPayload = jsonObject(jobRow.payload);
    const hasUnknown = gateways.some((gateway) => gateway.delivery_state === 'UNKNOWN'
      || (gateway.delegation_state === 'RECEIPT_RECORDED' && gateway.retry_class === 'READBACK_REQUIRED'));
    const prePlatform = ['PLANNED', 'NEEDS_ATTENTION'].includes(String(row.status))
      && !gateways.length
      && !jobRow.import_task_id
      && !jobRow.ozon_product_id
      && !['PROCESSING', 'SUCCESS'].includes(String(jobRow.directory_stage || '').toUpperCase())
      && jobPayload.platformWriteAttempted !== true;
    const remoteReadbackAvailable = !prePlatform && !hasUnknown
      && Boolean(row.system_enabled && String(row.admin_api_webhook_url || '').trim())
      && !['SUCCEEDED', 'CANCELLED'].includes(String(row.status));
    const events: OzonPublishEvent[] = normalizeArray(row.events).map((event) => {
      const value = jsonObject(event);
      return {
        id: String(value.id || ''),
        jobId: String(value.job_id || ''),
        eventType: String(value.event_type || ''),
        ...(value.from_state ? { fromState: String(value.from_state) as OzonPublishEvent['fromState'] } : {}),
        ...(value.to_state ? { toState: String(value.to_state) as OzonPublishEvent['toState'] } : {}),
        message: String(value.message || ''),
        ...(Object.keys(jsonObject(value.payload)).length ? { payload: jsonObject(value.payload) } : {}),
        createdAt: iso(value.created_at)
      };
    });
    const publication = toPublication(row);
    return {
      publication,
      ...(Object.keys(jobRow).length ? { job: { ...toPublicationJob(jobRow), events } } : {}),
      events,
      frozenContract: {
        planHash: String(row.plan_hash || ''),
        contentPolicyVersion: normalizeStoredContentPolicyVersion(row.content_policy_version),
        materialHash: String(row.material_hash || ''),
        ...(row.material_hash_version === OZON_SHARED_MATERIAL_HASH_VERSION
          ? { materialHashVersion: OZON_SHARED_MATERIAL_HASH_VERSION }
          : {}),
        presetId: row.preset_id ? String(row.preset_id) : undefined,
        presetRowVersion: Number(row.preset_row_version || 0) || undefined,
        presetDefinitionHash: String(row.preset_definition_hash || ''),
        ...(Object.keys(jsonObject(row.preset_snapshot)).length
          ? { presetDefinitionSnapshot: jsonObject(row.preset_snapshot) }
          : {}),
        storeConfigVersion: Number(row.store_config_version),
        credentialVersionId: row.credential_version_id ? String(row.credential_version_id) : undefined,
        warehouseId: String(row.warehouse_id || ''),
        fulfillmentMode: normalizeFulfillmentMode(row.fulfillment_mode),
        accountCurrency: normalizeAccountCurrency(row.account_currency),
        publicationMode: normalizePublicationMode(row.publication_mode),
        materializationHash: String(row.materialization_hash || ''),
        ...(row.request_id ? { requestId: String(row.request_id) } : {})
      },
      readback: {
        required: hasUnknown,
        canRecheck: remoteReadbackAvailable,
        gatewayRequestCount: gateways.length,
        deliveryStates: [...new Set(gateways.map((gateway) => String(gateway.delivery_state || '')))].filter(Boolean)
      },
      recovery: {
        canRecheck: prePlatform || remoteReadbackAvailable,
        canManualTakeover: prePlatform,
        recoveryMode: hasUnknown ? 'READBACK_REQUIRED' : prePlatform ? 'RECHECK' : remoteReadbackAvailable ? 'READBACK_REQUIRED' : 'NONE',
        blockedReason: hasUnknown ? 'GATEWAY_UNKNOWN' : prePlatform || remoteReadbackAvailable ? undefined : 'PLATFORM_OR_TERMINAL_EVIDENCE_PRESENT'
      }
    };
  }

  async getAutomaticListingSnapshotContext(jobId: string): Promise<OzonAutomaticListingSnapshotContext> {
    const result = await this.query<SqlRow>(`SELECT j.*,row_to_json(p) publication_row,
        v.id generated_version_id,v.snapshot listing_snapshot,s.account_currency current_account_currency
      FROM ozon_publish_jobs j
      LEFT JOIN ozon_store_publications p ON p.id=j.publication_id
      LEFT JOIN ozon_listing_versions v ON v.id=p.generated_version_id
      LEFT JOIN ozon_stores s ON s.id=j.store_id
      WHERE j.id=$1`, [jobId]);
    const row = result.rows[0];
    if (!row) throw new AppError('NOT_FOUND', 'OZON 自动任务不存在', { jobId }, 404);
    const publicationRow = jsonObject(row.publication_row);
    const listingSnapshot = jsonObject(row.listing_snapshot);
    const generatedVersionId = String(row.generated_version_id || '').trim();
    if (!Object.keys(publicationRow).length || !generatedVersionId || !Object.keys(listingSnapshot).length) {
      throw new AppError('VERSION_CONFLICT', 'OZON 自动任务缺少冻结 publication 或生成版本快照', {
        jobId,
        publicationId: row.publication_id || undefined,
        noFallback: true
      }, 409);
    }
    const currentAccountCurrency = row.current_account_currency === 'CNY'
      ? 'CNY'
      : row.current_account_currency === 'RUB' ? 'RUB' : undefined;
    return {
      job: {
        id: String(row.id),
        source: String(row.source || ''),
        taskId: String(row.task_id || ''),
        storeId: String(row.store_id || ''),
        storeAlias: String(row.store_alias || ''),
        publicationId: String(row.publication_id || ''),
        ...(row.credential_version_id ? { credentialVersionId: String(row.credential_version_id) } : {}),
        credentialBindingMode: normalizeBindingMode(row.credential_binding_mode),
        storeConfigVersion: Number(row.store_config_version || 0),
        warehouseId: String(row.warehouse_id || ''),
        sku: String(row.sku || ''),
        revision: Number(row.listing_revision || 0),
        offerIds: normalizeStringArray(row.offer_ids),
        offerContractHash: String(row.offer_contract_hash || ''),
        materializationHash: String(row.materialization_hash || ''),
        payload: jsonObject(row.payload),
        taskFolder: String(row.task_folder || ''),
        workRelPath: String(row.work_rel_path || ''),
        directoryStage: String(row.directory_stage || ''),
        directorySignature: String(row.directory_signature || '')
      },
      publication: toPublication(publicationRow),
      generatedVersionId,
      listingSnapshot: toGeneratedListingSnapshot(listingSnapshot),
      ...(currentAccountCurrency ? { currentAccountCurrency } : {})
    };
  }

  async assertLegacySkuRefreshAllowed(skuInput: string): Promise<void> {
    const sku = normalizeSku(skuInput);
    const result = await this.query<{ blocked: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM ozon_publish_jobs
      WHERE sku=$1 AND (store_id<>$2::uuid OR publication_id IS NOT NULL OR credential_binding_mode<>'PURE_LEGACY')
    ) blocked`, [sku, OZON_DEFAULT_STORE_ID]);
    if (result.rows[0]?.blocked) {
      throw new AppError('CONFIG_INVALID', '多店铺 publication 必须按 publicationId 同步，禁止使用全局 SKU 平台状态刷新', { sku }, 409);
    }
  }

  async assertLegacyJobRouteAllowed(
    jobId: string,
    action: 'DETAIL' | 'CANCEL' | 'RECHECK' | 'RETURN_TO_EDIT'
  ): Promise<void | { expectedRowVersion: number }> {
    const result = await this.query<SqlRow>('SELECT * FROM ozon_publish_jobs WHERE id=$1', [jobId]);
    const job = result.rows[0];
    if (!job) throw new AppError('NOT_FOUND', 'OZON 任务不存在', { jobId }, 404);
    if (action === 'RECHECK' && isExactPrePlatformMultistorePreparation(job)) {
      return { expectedRowVersion: Number(job.row_version) };
    }
    if (String(job.store_id) !== OZON_DEFAULT_STORE_ID || job.publication_id
      || normalizeBindingMode(job.credential_binding_mode) !== 'PURE_LEGACY') {
      throw new AppError('OZON_PUBLICATION_REQUIRED', '多店铺/Vault 任务必须使用 publicationId 详情与操作 API', {
        jobId,
        publicationId: job.publication_id || undefined,
        storeId: job.store_id,
        publicationWorkflowRequired: true
      }, 409);
    }
    if (action === 'RECHECK') {
      throw new AppError('OZON_LEGACY_READBACK_REQUIRED', '旧任务 recheck 可能重新调度平台写入，已停用；请进行人工只读回查', {
        jobId
      }, 409);
    }
    if (action !== 'DETAIL') {
      const payload = jsonObject(job.payload);
      const recovery = jsonObject(payload.networkRecovery);
      const remoteEvidence = Boolean(job.task_id || job.import_task_id || job.ozon_product_id
        || job.directory_stage === 'PROCESSING' || payload.platformWriteAttempted === true
        || ['UNKNOWN', 'RESPONDED'].includes(String(recovery.deliveryState || '')));
      if (remoteEvidence) {
        throw new AppError('OZON_REMOTE_STATE_UNPROVEN', '旧任务已有远端执行证据，禁止通过 storeless job 路由修改', {
          jobId,
          action
        }, 409);
      }
    }
  }

  async recoverImportNoBrandFailure(
    publicationId: string,
    input: OzonImportNoBrandRecoveryInput
  ): Promise<OzonImportNoBrandRecoveryResult> {
    return this.transaction(async (client) => {
      const publicationResult = await client.query<SqlRow>(
        'SELECT * FROM ozon_store_publications WHERE id=$1 FOR UPDATE', [publicationId]
      );
      const publication = publicationResult.rows[0];
      if (!publication) throw new AppError('NOT_FOUND', 'OZON publication 不存在', { publicationId }, 404);
      if (!Number.isInteger(input.publicationRowVersion) || input.publicationRowVersion < 1
        || !Number.isInteger(input.jobRowVersion) || input.jobRowVersion < 1) {
        throw new AppError('CONFIG_INVALID', '无品牌恢复缺少有效的 publication/job rowVersion', { publicationId }, 400);
      }
      assertRowVersion(input.publicationRowVersion, publication.row_version, 'OZON publication');

      const jobResult = await client.query<SqlRow>(`SELECT * FROM ozon_publish_jobs
        WHERE publication_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`, [publicationId]);
      const job = jobResult.rows[0];
      if (!job) throw new AppError('VERSION_CONFLICT', 'OZON publication 缺少绑定任务', { publicationId }, 409);
      if (Number(job.row_version) !== input.jobRowVersion) {
        throw new AppError('VERSION_CONFLICT', 'OZON publication 任务已变化，请刷新后重试', {
          publicationId, expected: input.jobRowVersion, actual: Number(job.row_version)
        }, 409);
      }

      const payload = jsonObject(job.payload);
      const priorRecovery = jsonObject(payload.importNoBrandRecovery);
      const priorRecoveryRecorded = String(priorRecovery.reason || '') === 'IMPORTED_PRODUCT_NO_BRAND_ATTRIBUTE_REJECTED'
        && Boolean(String(priorRecovery.recoveredAt || ''));
      const priorRecoveryRequestId = String(priorRecovery.recoveryRequestId || '').trim();
      const priorRecoveryLedgerCount = priorRecoveryRecorded && priorRecoveryRequestId
        ? Number((await client.query<{ count: string }>(
            'SELECT COUNT(*) count FROM ozon_gateway_requests WHERE request_ref=$1',
            [`${String(job.task_id || '')}:${priorRecoveryRequestId}`]
          )).rows[0]?.count || 0)
        : 0;
      const rearmUnsentRecovery = priorRecoveryRecorded && priorRecoveryLedgerCount === 0
        && String(job.state) === 'NEEDS_ATTENTION'
        && String(publication.status) === 'NEEDS_ATTENTION'
        && String(job.last_error_code) === 'OZON_PLATFORM_STATUS_ABNORMAL'
        && !job.import_task_id
        && String(payload.importTaskId || '') === String(priorRecovery.previousImportTaskId || '')
        && !job.lease_owner && !job.lease_token && !job.lease_expires_at;
      if (priorRecoveryRecorded && !rearmUnsentRecovery) {
        return {
          status: 'ALREADY_RECOVERED', dryRun: input.dryRun, publication: toPublication(publication),
          jobId: String(job.id), jobRowVersion: Number(job.row_version),
          checks: importNoBrandRecoveryChecks(job, publication, [], [])
        };
      }

      const offerIds = normalizeStringArray(job.offer_ids);
      const publicationOfferIds = normalizeStringArray(publication.offer_ids);
      const revision = Number(job.listing_revision);
      const storeAlias = requiredStoreAlias(job.store_alias);
      const expectedTaskId = `${storeAlias}__${String(job.sku)}__r${revision}`;
      const importTaskId = rearmUnsentRecovery
        ? String(priorRecovery.previousImportTaskId || '').trim()
        : String(job.import_task_id || '').trim();
      const recoveryHold = jsonObject(payload.recoveryHold);
      if (String(job.source) !== 'MANUAL' || String(publication.source) !== 'MANUAL'
        || String(job.state) !== 'NEEDS_ATTENTION' || String(publication.status) !== 'NEEDS_ATTENTION'
        || (!rearmUnsentRecovery && String(job.last_error_code) !== 'OZON_IMPORT_PARTIAL_FAILED')
        || (!rearmUnsentRecovery && String(publication.error_code) !== 'OZON_IMPORT_PARTIAL_FAILED')
        || String(job.publication_id) !== String(publication.id)
        || String(job.store_id) !== String(publication.store_id)
        || String(job.offer_contract_hash || '') !== String(publication.offer_contract_hash || '')
        || String(job.credential_binding_mode) !== 'VAULT' || !job.credential_version_id
        || !Number.isInteger(revision) || revision < 1 || String(job.task_id || '') !== expectedTaskId
        || !/^\d+$/.test(importTaskId) || !offerIds.length
        || JSON.stringify(offerIds) !== JSON.stringify(publicationOfferIds)
        || String(job.directory_stage) !== 'PROCESSING'
        || String(job.work_rel_path || '') !== `processing/${expectedTaskId}`
        || !/^sha256:[a-f0-9]{64}$/i.test(String(job.directory_signature || ''))
        || job.lease_owner || job.lease_token || job.lease_expires_at
        || recoveryHold.active === true) {
        throw new AppError('VERSION_CONFLICT', '该 publication 不符合已创建商品的无品牌属性纠正恢复身份', {
          publicationId, jobId: job.id, state: job.state, publicationStatus: publication.status
        }, 409);
      }
      const importIntent = jsonObject(payload.importIntent);
      if ((!rearmUnsentRecovery && String(importIntent.phase) !== 'TASK_ID_BOUND')
        || (rearmUnsentRecovery && (String(importIntent.phase) !== 'RETRY_ALLOWED'
          || String(importIntent.requestId || '') !== priorRecoveryRequestId))
        || (!rearmUnsentRecovery && String(importIntent.importTaskId || '') !== importTaskId)
        || JSON.stringify(normalizeStringArray(importIntent.offerIds)) !== JSON.stringify(offerIds)) {
        throw new AppError('VERSION_CONFLICT', '无品牌恢复缺少与任务一致的 TASK_ID_BOUND 导入意图', {
          publicationId, jobId: job.id
        }, 409);
      }

      const failures = parseImportedNoBrandFailures(rearmUnsentRecovery
        ? JSON.stringify(normalizeArray(priorRecovery.failures).map((entry) => {
            const failure = jsonObject(entry);
            return {
              offer_id: failure.offerId,
              product_id: failure.productId,
              status: 'imported',
              errors: failure.errors
            };
          }))
        : job.last_error_message, offerIds);
      const mappings = (await client.query<SqlRow>(`SELECT * FROM ozon_product_mappings
        WHERE store_id=$1 AND sku=$2 AND offer_id=ANY($3::text[]) ORDER BY offer_id FOR SHARE`, [
        job.store_id, job.sku, offerIds
      ])).rows;
      if (mappings.length !== offerIds.length || failures.some((failure) => {
        const mapping = mappings.find((entry) => String(entry.offer_id) === failure.offerId);
        return !mapping || String(mapping.ozon_product_id || '') !== failure.productId;
      })) {
        throw new AppError('VERSION_CONFLICT', '无品牌恢复的商品映射与导入回读 product_id 不一致', {
          publicationId, jobId: job.id
        }, 409);
      }

      const gatewayRows = (await client.query<SqlRow>(`SELECT operation,delivery_state,retry_class,status_code,COUNT(*)::int count
        FROM ozon_gateway_requests WHERE task_id=$1
        GROUP BY operation,delivery_state,retry_class,status_code ORDER BY operation`, [job.task_id])).rows;
      const count = (operation: string) => gatewayRows
        .filter((entry) => String(entry.operation) === operation)
        .reduce((sum, entry) => sum + Number(entry.count || 0), 0);
      const importProductCount = count('importProduct');
      const importInfoCount = count('importInfo');
      const allowedOperations = new Set(rearmUnsentRecovery
        ? ['importProduct', 'importInfo', 'infoList', 'attributesInfo', 'pricesRead', 'stocksRead', 'picturesInfo']
        : ['importProduct', 'importInfo']);
      const ledgerStrict = gatewayRows.length > 0 && gatewayRows.every((entry) =>
        allowedOperations.has(String(entry.operation))
        && String(entry.delivery_state) === 'RESPONDED'
        && String(entry.retry_class) === 'NONE'
        && Number(entry.status_code) >= 200 && Number(entry.status_code) < 300);
      if (!ledgerStrict || importProductCount !== 1 || importInfoCount < 1) {
        throw new AppError('OZON_REMOTE_STATE_UNPROVEN', '无品牌恢复的 gateway 账本不符合一次导入、只读回查且无未知写入', {
          publicationId, jobId: job.id, importProductCount, importInfoCount
        }, 409);
      }

      const activeSlot = await client.query<{ exists: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM ozon_publish_slots WHERE job_id=$1 OR (lease_expires_at>NOW() AND slot_key='OZON_RUNTIME_WRITE')
      ) exists`, [job.id]);
      const activeRefresh = await client.query<{ exists: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM ozon_platform_status_refresh_leases WHERE store_id=$1 AND sku=$2 AND lease_expires_at>NOW()
      ) exists`, [job.store_id, job.sku]);
      const newerJob = await client.query<SqlRow>(`SELECT id,state FROM ozon_publish_jobs
        WHERE store_id=$1 AND sku=$2 AND id<>$3 AND created_at>$4
        ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE`, [job.store_id, job.sku, job.id, job.created_at]);
      if (activeSlot.rows[0]?.exists || activeRefresh.rows[0]?.exists || newerJob.rows[0]) {
        throw new AppError('TASK_LOCKED', '无品牌恢复检测到运行槽、刷新租约或同店更新任务', {
          publicationId, jobId: job.id, activeSlot: Boolean(activeSlot.rows[0]?.exists),
          activeRefresh: Boolean(activeRefresh.rows[0]?.exists), newerJobId: newerJob.rows[0]?.id
        }, 409);
      }

      const checks = importNoBrandRecoveryChecks(job, publication, gatewayRows, failures);
      if (input.dryRun) {
        return {
          status: 'DRY_RUN', dryRun: true, publication: toPublication(publication),
          jobId: String(job.id), jobRowVersion: Number(job.row_version), checks
        };
      }

      const recoveredAt = new Date().toISOString();
      const recoveryAttempt = Number(priorRecovery.recoveryAttempt || 1);
      const recoveryRequestId = priorRecoveryRequestId
        || `import:${String(job.id)}:r${revision}:no-brand:${recoveryAttempt}`;
      const recovery = {
        ...(rearmUnsentRecovery ? priorRecovery : {}),
        schemaVersion: 1,
        reason: 'IMPORTED_PRODUCT_NO_BRAND_ATTRIBUTE_REJECTED',
        importProductReachable: true,
        recoveryAttempt,
        recoveryRequestId,
        recoveredAt,
        publicationId,
        jobId: String(job.id),
        taskId: String(job.task_id),
        previousImportTaskId: importTaskId,
        offerIds,
        productIds: failures.map((entry) => entry.productId),
        previousJobState: String(job.state),
        previousJobRowVersion: Number(job.row_version),
        previousPublicationState: String(publication.status),
        previousPublicationRowVersion: Number(publication.row_version),
        failures,
        ...(rearmUnsentRecovery ? {
          rearmedAt: recoveredAt,
          rearmCount: Number(priorRecovery.rearmCount || 0) + 1,
          rearmReason: 'CORRECTIVE_IMPORT_NOT_SENT_BECAUSE_STALE_PAYLOAD_IMPORT_TASK_ID_WAS_PROJECTED'
        } : {})
      };
      const retryIntent = {
        ...importIntent,
        requestId: recoveryRequestId,
        phase: 'RETRY_ALLOWED',
        attempt: Number(importIntent.attempt || 0),
        importTaskId: null,
        lastOutcome: {
          deliveryState: 'RESPONDED', retryClass: 'BUSINESS_REJECTED',
          code: 'OZON_IMPORT_NO_BRAND_ATTRIBUTE_REJECTED', at: recoveredAt
        }
      };
      const nextPayload = {
        ...payload,
        importTaskId: null,
        importNoBrandRecovery: recovery,
        importIntent: retryIntent,
        importFailures: [],
        networkRecovery: null,
        finalVerificationLeaseUntil: null
      };
      const nextStageStates = {
        ...jsonObject(job.stage_states),
        import: 'CORRECTIVE_RETRY_PENDING', moderation: 'PENDING',
        price: 'PENDING', stock: 'PENDING'
      };
      const updatedJob = await client.query<SqlRow>(`UPDATE ozon_publish_jobs SET
        state='UPLOADING_MEDIA',payload=$2::jsonb,stage_states=$3::jsonb,import_task_id=NULL,
        last_error_code=NULL,last_error_message=NULL,next_attempt_at=NOW(),finished_at=NULL,
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 AND row_version=$4 RETURNING *`, [
        job.id, JSON.stringify(nextPayload), JSON.stringify(nextStageStates), input.jobRowVersion
      ]);
      if (!updatedJob.rows[0]) throw new AppError('VERSION_CONFLICT', 'OZON publication 任务已变化，请刷新后重试', { publicationId }, 409);
      const updatedPublication = await client.query<SqlRow>(`UPDATE ozon_store_publications SET
        status='RUNNING',error_code='',error_message='',completed_at=NULL,
        result_json=result_json || jsonb_build_object('importNoBrandRecovery',$2::jsonb),
        row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 AND row_version=$3 RETURNING *`, [publicationId, JSON.stringify(recovery), input.publicationRowVersion]);
      if (!updatedPublication.rows[0]) throw new AppError('VERSION_CONFLICT', 'OZON publication 已变化，请刷新后重试', { publicationId }, 409);
      await client.query(`INSERT INTO ozon_publish_events(
        id,job_id,event_type,from_state,to_state,message,payload,store_id,publication_id
      ) VALUES($1,$2,'OZON_IMPORT_NO_BRAND_RECOVERY_STARTED','NEEDS_ATTENTION','UPLOADING_MEDIA',$3,$4::jsonb,$5,$6)`, [
        randomUUID(), job.id,
        '已证明商品创建成功且仅无品牌属性被拒绝；使用新幂等键纠正同一 Offer，禁止复用原失败导入请求',
        JSON.stringify(recovery), job.store_id, publicationId
      ]);
      return {
        status: 'RECOVERED', dryRun: false, publication: toPublication(updatedPublication.rows[0]),
        jobId: String(job.id), jobRowVersion: Number(updatedJob.rows[0].row_version), checks
      };
    });
  }

  async recoverImportPriceFloorFailure(
    publicationId: string,
    input: OzonImportPriceFloorRecoveryInput
  ): Promise<OzonImportPriceFloorRecoveryResult> {
    return this.transaction(async (client) => {
      const publicationResult = await client.query<SqlRow>(
        'SELECT * FROM ozon_store_publications WHERE id=$1 FOR UPDATE', [publicationId]
      );
      const publication = publicationResult.rows[0];
      if (!publication) throw new AppError('NOT_FOUND', 'OZON publication 不存在', { publicationId }, 404);
      if (!Number.isInteger(input.publicationRowVersion) || input.publicationRowVersion < 1
        || !Number.isInteger(input.jobRowVersion) || input.jobRowVersion < 1) {
        throw new AppError('CONFIG_INVALID', '价格下限恢复缺少有效的 publication/job rowVersion', { publicationId }, 400);
      }
      assertRowVersion(input.publicationRowVersion, publication.row_version, 'OZON publication');

      const jobResult = await client.query<SqlRow>(`SELECT * FROM ozon_publish_jobs
        WHERE publication_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`, [publicationId]);
      const job = jobResult.rows[0];
      if (!job) throw new AppError('VERSION_CONFLICT', 'OZON publication 缺少绑定任务', { publicationId }, 409);
      if (Number(job.row_version) !== input.jobRowVersion) {
        throw new AppError('VERSION_CONFLICT', 'OZON publication 任务已变化，请刷新后重试', {
          publicationId,
          expected: input.jobRowVersion,
          actual: Number(job.row_version)
        }, 409);
      }

      const payload = jsonObject(job.payload);
      const priorRecovery = jsonObject(payload.importPriceFloorRecovery);
      const priorReason = String(priorRecovery.reason || '');
      if (priorReason === 'IMPORTED_PRODUCT_PRICE_FLOOR_CONFLICT' && String(priorRecovery.recoveredAt || '')) {
        return {
          status: 'ALREADY_RECOVERED',
          dryRun: input.dryRun,
          publication: toPublication(publication),
          jobId: String(job.id),
          jobRowVersion: Number(job.row_version),
          checks: importPriceFloorRecoveryChecks(job, publication, [], [])
        };
      }

      const offerIds = normalizeStringArray(job.offer_ids);
      const publicationOfferIds = normalizeStringArray(publication.offer_ids);
      const revision = Number(job.listing_revision);
      const storeAlias = requiredStoreAlias(job.store_alias);
      const expectedTaskId = `${storeAlias}__${String(job.sku)}__r${revision}`;
      const importTaskId = String(job.import_task_id || '').trim();
      const recoveryHold = jsonObject(payload.recoveryHold);
      if (String(job.state) !== 'NEEDS_ATTENTION' || String(publication.status) !== 'NEEDS_ATTENTION'
        || String(job.last_error_code) !== 'OZON_IMPORT_PARTIAL_FAILED'
        || String(publication.error_code) !== 'OZON_IMPORT_PARTIAL_FAILED'
        || String(job.publication_id) !== String(publication.id)
        || String(job.store_id) !== String(publication.store_id)
        || String(job.offer_contract_hash || '') !== String(publication.offer_contract_hash || '')
        || String(job.credential_binding_mode) !== 'VAULT' || !job.credential_version_id
        || !Number.isInteger(revision) || revision < 1 || String(job.task_id || '') !== expectedTaskId
        || !/^\d+$/.test(importTaskId) || !offerIds.length
        || JSON.stringify(offerIds) !== JSON.stringify(publicationOfferIds)
        || String(job.directory_stage) !== 'PROCESSING'
        || String(job.work_rel_path || '') !== `processing/${expectedTaskId}`
        || !/^sha256:[a-f0-9]{64}$/i.test(String(job.directory_signature || ''))
        || job.lease_owner || job.lease_token || job.lease_expires_at
        || recoveryHold.active === true) {
        throw new AppError('VERSION_CONFLICT', '该 publication 不符合商品已创建后价格下限冲突的安全恢复身份', {
          publicationId,
          jobId: job.id,
          state: job.state,
          publicationStatus: publication.status
        }, 409);
      }
      const importIntent = jsonObject(payload.importIntent);
      if (String(importIntent.phase) !== 'TASK_ID_BOUND'
        || String(importIntent.importTaskId || '') !== importTaskId
        || JSON.stringify(normalizeStringArray(importIntent.offerIds)) !== JSON.stringify(offerIds)) {
        throw new AppError('VERSION_CONFLICT', '价格下限恢复缺少与任务一致的 TASK_ID_BOUND 导入意图', {
          publicationId,
          jobId: job.id
        }, 409);
      }

      const failures = parseImportedPriceFloorFailures(job.last_error_message, offerIds);
      const mappingResult = await client.query<SqlRow>(`SELECT * FROM ozon_product_mappings
        WHERE store_id=$1 AND sku=$2 AND offer_id=ANY($3::text[]) ORDER BY offer_id FOR SHARE`, [
        job.store_id, job.sku, offerIds
      ]);
      const mappings = mappingResult.rows;
      if (mappings.length !== offerIds.length || failures.some((failure) => {
        const mapping = mappings.find((entry) => String(entry.offer_id) === failure.offerId);
        return !mapping || String(mapping.ozon_product_id || '') !== failure.productId;
      })) {
        throw new AppError('VERSION_CONFLICT', '价格下限恢复的商品映射与导入回读 product_id 不一致', {
          publicationId,
          jobId: job.id
        }, 409);
      }

      const gatewayResult = await client.query<SqlRow>(`SELECT operation,delivery_state,retry_class,status_code,COUNT(*)::int count
        FROM ozon_gateway_requests WHERE task_id=$1
        GROUP BY operation,delivery_state,retry_class,status_code ORDER BY operation`, [job.task_id]);
      const gatewayRows = gatewayResult.rows;
      const successfulCount = (operation: string) => gatewayRows
        .filter((entry) => String(entry.operation) === operation
          && String(entry.delivery_state) === 'RESPONDED'
          && String(entry.retry_class) === 'NONE'
          && Number(entry.status_code) >= 200 && Number(entry.status_code) < 300)
        .reduce((sum, entry) => sum + Number(entry.count || 0), 0);
      const operationCount = (operation: string) => gatewayRows
        .filter((entry) => String(entry.operation) === operation)
        .reduce((sum, entry) => sum + Number(entry.count || 0), 0);
      const importProductCount = successfulCount('importProduct');
      const importInfoCount = successfulCount('importInfo');
      const pricesWriteCount = operationCount('pricesWrite');
      const stocksWriteCount = operationCount('stocksWrite');
      if (importProductCount !== 1 || importInfoCount < 1 || pricesWriteCount !== 0 || stocksWriteCount !== 0
        || gatewayRows.some((entry) => !['importProduct', 'importInfo'].includes(String(entry.operation)))) {
        throw new AppError('OZON_REMOTE_STATE_UNPROVEN', '价格下限恢复的 gateway 账本不符合一次导入、只读回查且尚未价格库存写入', {
          publicationId,
          jobId: job.id,
          importProductCount,
          importInfoCount,
          pricesWriteCount,
          stocksWriteCount
        }, 409);
      }

      const activeSlot = await client.query<{ exists: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM ozon_publish_slots WHERE job_id=$1 OR (lease_expires_at>NOW() AND slot_key='OZON_RUNTIME_WRITE')
      ) exists`, [job.id]);
      const activeRefresh = await client.query<{ exists: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM ozon_platform_status_refresh_leases
        WHERE store_id=$1 AND sku=$2 AND lease_expires_at>NOW()
      ) exists`, [job.store_id, job.sku]);
      const newerJob = await client.query<SqlRow>(`SELECT id,state FROM ozon_publish_jobs
        WHERE store_id=$1 AND sku=$2 AND id<>$3 AND created_at>$4
        ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE`, [job.store_id, job.sku, job.id, job.created_at]);
      if (activeSlot.rows[0]?.exists || activeRefresh.rows[0]?.exists || newerJob.rows[0]) {
        throw new AppError('TASK_LOCKED', '价格下限恢复检测到运行槽、刷新租约或同店更新任务', {
          publicationId,
          jobId: job.id,
          activeSlot: Boolean(activeSlot.rows[0]?.exists),
          activeRefresh: Boolean(activeRefresh.rows[0]?.exists),
          newerJobId: newerJob.rows[0]?.id
        }, 409);
      }

      const checks = importPriceFloorRecoveryChecks(job, publication, gatewayRows, failures);
      if (input.dryRun) {
        return {
          status: 'DRY_RUN', dryRun: true, publication: toPublication(publication),
          jobId: String(job.id), jobRowVersion: Number(job.row_version), checks
        };
      }

      const recoveredAt = new Date().toISOString();
      const recovery = {
        schemaVersion: 1,
        reason: 'IMPORTED_PRODUCT_PRICE_FLOOR_CONFLICT',
        importProductReachable: false,
        recoveredAt,
        publicationId,
        jobId: String(job.id),
        taskId: String(job.task_id),
        importTaskId,
        offerIds,
        productIds: failures.map((entry) => entry.productId),
        previousJobState: String(job.state),
        previousJobRowVersion: Number(job.row_version),
        previousPublicationState: String(publication.status),
        previousPublicationRowVersion: Number(publication.row_version),
        failures
      };
      const pendingProgress = {
        pricesWrite: { succeededOfferIds: [], pendingOfferIds: offerIds, failedOfferIds: [], errorsByOffer: {} },
        stocksWrite: { succeededOfferIds: [], pendingOfferIds: offerIds, failedOfferIds: [], errorsByOffer: {} }
      };
      const nextPayload = {
        ...payload,
        importPriceFloorRecovery: recovery,
        importFailures: failures,
        priceStockWriteProgress: pendingProgress,
        priceStockWriteFailures: [],
        networkRecovery: null,
        finalVerificationLeaseUntil: null
      };
      const nextStageStates = {
        ...jsonObject(job.stage_states),
        import: 'IMPORTED_WITH_PRICE_FLOOR_CONFLICT',
        price: 'PENDING',
        stock: 'PENDING'
      };
      const updatedJob = await client.query<SqlRow>(`UPDATE ozon_publish_jobs SET
        state='IMPORTING',payload=$2::jsonb,stage_states=$3::jsonb,
        last_error_code=NULL,last_error_message=NULL,next_attempt_at=NOW(),finished_at=NULL,
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 AND row_version=$4 RETURNING *`, [
        job.id, JSON.stringify(nextPayload), JSON.stringify(nextStageStates), input.jobRowVersion
      ]);
      if (!updatedJob.rows[0]) throw new AppError('VERSION_CONFLICT', 'OZON publication 任务已变化，请刷新后重试', { publicationId }, 409);
      const updatedPublication = await client.query<SqlRow>(`UPDATE ozon_store_publications SET
        status='RUNNING',error_code='',error_message='',completed_at=NULL,
        result_json=result_json || jsonb_build_object('importPriceFloorRecovery',$2::jsonb),
        row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 AND row_version=$3 RETURNING *`, [publicationId, JSON.stringify(recovery), input.publicationRowVersion]);
      if (!updatedPublication.rows[0]) throw new AppError('VERSION_CONFLICT', 'OZON publication 已变化，请刷新后重试', { publicationId }, 409);
      await client.query(`INSERT INTO ozon_publish_events(
        id,job_id,event_type,from_state,to_state,message,payload,store_id,publication_id
      ) VALUES($1,$2,'OZON_IMPORT_PRICE_FLOOR_RECOVERY_STARTED','NEEDS_ATTENTION','IMPORTING',$3,$4::jsonb,$5,$6)`, [
        randomUUID(), job.id,
        '商品已创建且仅价格/最低价相互约束失败；保持 importTaskId，只读回查后仅补价格库存一致性写入',
        JSON.stringify(recovery), job.store_id, publicationId
      ]);
      return {
        status: 'RECOVERED', dryRun: false, publication: toPublication(updatedPublication.rows[0]),
        jobId: String(job.id), jobRowVersion: Number(updatedJob.rows[0].row_version), checks
      };
    });
  }

  async syncPublicationFromJob(publicationId: string, expectedRowVersion: number): Promise<OzonStorePublication> {
    return this.transaction(async (client) => {
      const publication = await client.query<SqlRow>('SELECT * FROM ozon_store_publications WHERE id=$1 FOR UPDATE', [publicationId]);
      if (!publication.rows[0]) throw new AppError('NOT_FOUND', 'OZON publication 不存在', { publicationId }, 404);
      assertRowVersion(expectedRowVersion, publication.rows[0].row_version, 'OZON publication');
      const job = await client.query<SqlRow>(`SELECT * FROM ozon_publish_jobs WHERE publication_id=$1
        ORDER BY updated_at DESC,id DESC LIMIT 1 FOR SHARE`, [publicationId]);
      if (!job.rows[0]) return toPublication(publication.rows[0]);
      const state = publicationStateFromJob(String(job.rows[0].state));
      const links = normalizeArray(job.rows[0].product_links);
      const productIds = normalizeStringArray(links.map((link) => jsonObject(link).ozonProductId));
      const ozonSkus = normalizeStringArray(links.map((link) => jsonObject(link).ozonSku));
      const productLinks = normalizeStringArray(links.map((link) => jsonObject(link).url));
      const updated = await client.query<SqlRow>(`UPDATE ozon_store_publications SET
        status=$2,result_json=$3::jsonb,product_ids=$4::jsonb,ozon_skus=$5::jsonb,product_links=$6::jsonb,
        error_code=$7,error_message=$8,completed_at=CASE WHEN $2=ANY($9::text[]) THEN COALESCE(completed_at,NOW()) ELSE NULL END,
        row_version=row_version+1,updated_at=NOW() WHERE id=$1 RETURNING *`, [
        publicationId, state, JSON.stringify({ jobId: job.rows[0].id, state: job.rows[0].state }),
        JSON.stringify(productIds), JSON.stringify(ozonSkus), JSON.stringify(productLinks),
        job.rows[0].last_error_code || '', job.rows[0].last_error_message || '',
        ['SUCCEEDED', 'FAILED', 'CANCELLED']
      ]);
      return toPublication(updated.rows[0]!);
    });
  }

  async beginPublicationReadback(
    publicationId: string,
    expectedRowVersion: number
  ): Promise<OzonPublicationReadbackContext> {
    return this.transaction(async (client) => {
      const publicationResult = await client.query<SqlRow>(
        'SELECT * FROM ozon_store_publications WHERE id=$1 FOR UPDATE', [publicationId]
      );
      const publication = publicationResult.rows[0];
      if (!publication) throw new AppError('NOT_FOUND', 'OZON publication 不存在', { publicationId }, 404);
      assertRowVersion(expectedRowVersion, publication.row_version, 'OZON publication');
      const job = (await client.query<SqlRow>(`SELECT * FROM ozon_publish_jobs WHERE publication_id=$1
        ORDER BY updated_at DESC,id DESC LIMIT 1 FOR UPDATE`, [publicationId])).rows[0];
      if (!job || !job.task_id || String(job.store_id) !== String(publication.store_id)
        || String(job.offer_contract_hash || '') !== String(publication.offer_contract_hash || '')) {
        throw new AppError('VERSION_CONFLICT', 'OZON publication 缺少完整的冻结 readback 任务身份', { publicationId }, 409);
      }
      if (job.lease_expires_at && new Date(job.lease_expires_at).getTime() > Date.now()) {
        throw new AppError('TASK_LOCKED', 'OZON publication 仍由运行时租约处理，拒绝并发平台回查', {
          publicationId,
          jobId: job.id
        }, 409);
      }
      const existingHold = jsonObject(jsonObject(job.payload).recoveryHold);
      const expiredReadbackHold = existingHold.active === true
        && existingHold.kind === 'PUBLICATION_READBACK'
        && Number.isFinite(Date.parse(String(existingHold.expiresAt || '')))
        && Date.parse(String(existingHold.expiresAt)) <= Date.now();
      if (existingHold.active === true && !expiredReadbackHold) {
        throw new AppError('TASK_LOCKED', 'OZON publication 任务已有运行时恢复或回查 hold', {
          publicationId,
          jobId: job.id
        }, 409);
      }
      const version = (await client.query<SqlRow>(
        'SELECT snapshot FROM ozon_listing_versions WHERE id=$1 FOR SHARE', [publication.generated_version_id]
      )).rows[0];
      if (!version?.snapshot) throw new AppError('VERSION_CONFLICT', 'OZON publication 生成版本快照不存在', { publicationId }, 409);
      const mappingRows = await client.query<SqlRow>(`SELECT * FROM ozon_product_mappings
        WHERE store_id=$1 AND sku=$2 AND offer_id=ANY($3::text[]) FOR SHARE`, [
        publication.store_id, publication.sku, normalizeStringArray(publication.offer_ids)
      ]);
      const requestRef = `ozon-readback:${publicationId}:${randomUUID()}`;
      const startedAt = new Date().toISOString();
      await client.query(`UPDATE ozon_publish_jobs SET
        payload=$2::jsonb,row_version=row_version+1,updated_at=NOW() WHERE id=$1`, [
        job.id,
        JSON.stringify({
          ...jsonObject(job.payload),
          recoveryHold: {
            active: true,
            kind: 'PUBLICATION_READBACK',
            requestRef,
            publicationId,
            startedAt,
            expiresAt: new Date(Date.now() + PUBLICATION_READBACK_HOLD_MS).toISOString()
          }
        })
      ]);
      const resultJson = {
        ...jsonObject(publication.result_json),
        readback: {
          requestRef,
          deliveryState: 'UNKNOWN',
          retryClass: 'READBACK_REQUIRED',
          startedAt,
          taskId: String(job.task_id),
          publicationId,
          storeId: String(publication.store_id),
          offerContractHash: String(publication.offer_contract_hash),
          offerIds: normalizeStringArray(publication.offer_ids)
        }
      };
      const updated = await client.query<SqlRow>(`UPDATE ozon_store_publications SET
        result_json=$2::jsonb,row_version=row_version+1,updated_at=NOW() WHERE id=$1 RETURNING *`, [
        publicationId, JSON.stringify(resultJson)
      ]);
      return {
        publication: toPublication(updated.rows[0]!),
        dispatchRowVersion: Number(updated.rows[0]!.row_version),
        requestRef,
        taskId: String(job.task_id),
        listing: version.snapshot as OzonListingDraft,
        mappings: mappingRows.rows.map(toScopedProductMapping)
      };
    });
  }

  async completePublicationReadback(input: {
    publicationId: string;
    dispatchRowVersion: number;
    requestRef: string;
    readAt: string;
    businessState: 'PUBLISHED' | 'MODERATING' | 'NEEDS_ATTENTION';
    offers: OzonPlatformOfferStatus[];
    warnings: string[];
    stageStates: Record<string, string>;
  }): Promise<OzonStorePublication> {
    return this.transaction(async (client) => {
      const publicationResult = await client.query<SqlRow>(
        'SELECT * FROM ozon_store_publications WHERE id=$1 FOR UPDATE', [input.publicationId]
      );
      const publication = publicationResult.rows[0];
      if (!publication) throw new AppError('NOT_FOUND', 'OZON publication 不存在', { publicationId: input.publicationId }, 404);
      assertRowVersion(input.dispatchRowVersion, publication.row_version, 'OZON publication readback');
      if (String(jsonObject(jsonObject(publication.result_json).readback).requestRef || '') !== input.requestRef) {
        throw new AppError('VERSION_CONFLICT', 'OZON publication readback requestRef 已变化', { publicationId: input.publicationId }, 409);
      }
      const expectedOffers = new Set(normalizeStringArray(publication.offer_ids));
      if (input.offers.length !== expectedOffers.size
        || input.offers.some((offer) => !expectedOffers.has(offer.offerId))) {
        throw new AppError('VERSION_CONFLICT', 'OZON readback Offer 集合与 publication 冻结合同不一致', {
          publicationId: input.publicationId
        }, 409);
      }
      const job = (await client.query<SqlRow>(`SELECT * FROM ozon_publish_jobs WHERE publication_id=$1
        ORDER BY updated_at DESC,id DESC LIMIT 1 FOR UPDATE`, [input.publicationId])).rows[0];
      if (!job || String(job.store_id) !== String(publication.store_id)) {
        throw new AppError('VERSION_CONFLICT', 'OZON publication readback 任务身份已变化', {
          publicationId: input.publicationId
        }, 409);
      }
      if (job.lease_expires_at && new Date(job.lease_expires_at).getTime() > Date.now()) {
        throw new AppError('TASK_LOCKED', 'OZON publication readback 完成前任务已被运行时重新领取', {
          publicationId: input.publicationId,
          jobId: job.id
        }, 409);
      }
      const jobPayload = jsonObject(job.payload);
      const readbackHold = jsonObject(jobPayload.recoveryHold);
      if (readbackHold.active !== true || readbackHold.kind !== 'PUBLICATION_READBACK'
        || String(readbackHold.requestRef || '') !== input.requestRef) {
        throw new AppError('VERSION_CONFLICT', 'OZON publication readback hold 已变化', {
          publicationId: input.publicationId,
          jobId: job.id
        }, 409);
      }
      delete jobPayload.recoveryHold;
      const conflicting = await client.query<SqlRow>(`SELECT offer_id,sku FROM ozon_product_mappings
        WHERE store_id=$1 AND offer_id=ANY($2::text[]) AND sku<>$3 FOR SHARE`, [
        publication.store_id, [...expectedOffers], publication.sku
      ]);
      if (conflicting.rows.length) {
        throw new AppError('VERSION_CONFLICT', 'OZON readback Offer 已绑定同店其他 SKU', {
          publicationId: input.publicationId,
          offerIds: conflicting.rows.map((row) => row.offer_id)
        }, 409);
      }
      for (const offer of input.offers) {
        await client.query(`INSERT INTO ozon_product_mappings(
          store_id,store_alias,offer_id,sku,ozon_product_id,ozon_sku,warehouse_id,last_applied_revision,
          status,status_snapshot,last_verified_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::timestamptz,NOW())
        ON CONFLICT(store_id,offer_id) DO UPDATE SET
          sku=EXCLUDED.sku,
          ozon_product_id=COALESCE(EXCLUDED.ozon_product_id,ozon_product_mappings.ozon_product_id),
          ozon_sku=COALESCE(EXCLUDED.ozon_sku,ozon_product_mappings.ozon_sku),
          warehouse_id=COALESCE(EXCLUDED.warehouse_id,ozon_product_mappings.warehouse_id),
          last_applied_revision=GREATEST(ozon_product_mappings.last_applied_revision,EXCLUDED.last_applied_revision),
          status=EXCLUDED.status,status_snapshot=EXCLUDED.status_snapshot,
          last_verified_at=EXCLUDED.last_verified_at,updated_at=NOW()`, [
          publication.store_id, publication.store_alias_snapshot, offer.offerId, publication.sku,
          offer.ozonProductId || null, offer.ozonSku || null, publication.warehouse_id,
          Number(publication.revision), offer.displayState, JSON.stringify(offer), input.readAt
        ]);
      }
      const publicationStatus = input.businessState === 'PUBLISHED'
        ? 'SUCCEEDED'
        : input.businessState === 'NEEDS_ATTENTION' ? 'NEEDS_ATTENTION' : 'RUNNING';
      const jobState = input.businessState === 'PUBLISHED'
        ? 'SUCCEEDED'
        : input.businessState === 'NEEDS_ATTENTION' ? 'NEEDS_ATTENTION' : 'MODERATING';
      await client.query(`UPDATE ozon_publish_jobs SET state=$2,stage_states=$3::jsonb,
          product_links=$4::jsonb,last_error_code=CASE WHEN $2='NEEDS_ATTENTION' THEN 'OZON_PLATFORM_NEEDS_ATTENTION' ELSE NULL END,
          last_error_message=CASE WHEN $2='NEEDS_ATTENTION' THEN '平台只读回查发现需要处理的商品状态' ELSE NULL END,
          finished_at=CASE WHEN $2='SUCCEEDED' THEN NOW() ELSE NULL END,
          payload=$5::jsonb,row_version=row_version+1,updated_at=NOW() WHERE id=$1`, [
        job.id, jobState, JSON.stringify(input.stageStates), JSON.stringify(readbackProductLinks(input.offers)),
        JSON.stringify(jobPayload)
      ]);
      await client.query(`INSERT INTO ozon_publish_events(
          id,job_id,event_type,from_state,to_state,message,payload,store_id,publication_id
        ) VALUES($1,$2,'PUBLICATION_READBACK_COMPLETED',$3,$4,$5,$6::jsonb,$7,$8)`, [
          randomUUID(), job.id, job.state, jobState, 'OZON publication 已完成 store-scoped 只读回查',
          JSON.stringify({ requestRef: input.requestRef, readAt: input.readAt, businessState: input.businessState }),
        publication.store_id, input.publicationId
      ]);
      const resultJson = {
        ...jsonObject(publication.result_json),
        readback: {
          requestRef: input.requestRef,
          deliveryState: 'RESPONDED',
          retryClass: 'NONE',
          statusCode: 200,
          completedAt: new Date().toISOString(),
          readAt: input.readAt,
          businessState: input.businessState,
          warnings: input.warnings,
          offers: input.offers
        }
      };
      const productIds = normalizeStringArray(input.offers.map((offer) => offer.ozonProductId));
      const ozonSkus = normalizeStringArray(input.offers.map((offer) => offer.ozonSku));
      const updated = await client.query<SqlRow>(`UPDATE ozon_store_publications SET
        status=$2,result_json=$3::jsonb,product_ids=$4::jsonb,ozon_skus=$5::jsonb,product_links=$6::jsonb,
        error_code=CASE WHEN $2='NEEDS_ATTENTION' THEN 'OZON_PLATFORM_NEEDS_ATTENTION' ELSE '' END,
        error_message=CASE WHEN $2='NEEDS_ATTENTION' THEN '平台只读回查发现需要处理的商品状态' ELSE '' END,
        completed_at=CASE WHEN $2='SUCCEEDED' THEN NOW() ELSE NULL END,
        row_version=row_version+1,updated_at=NOW() WHERE id=$1 RETURNING *`, [
        input.publicationId, publicationStatus, JSON.stringify(resultJson), JSON.stringify(productIds),
        JSON.stringify(ozonSkus), JSON.stringify(readbackProductLinks(input.offers))
      ]);
      return toPublication(updated.rows[0]!);
    });
  }

  async failPublicationReadback(input: {
    publicationId: string;
    dispatchRowVersion: number;
    requestRef: string;
    deliveryState: 'NOT_SENT' | 'UNKNOWN' | 'RESPONDED';
    retryClass: 'RETRYABLE' | 'READBACK_REQUIRED' | 'PERMANENT';
    statusCode?: number;
    errorCode: string;
    errorMessage: string;
  }): Promise<void> {
    await this.transaction(async (client) => {
      const result = await client.query<SqlRow>('SELECT * FROM ozon_store_publications WHERE id=$1 FOR UPDATE', [input.publicationId]);
      const publication = result.rows[0];
      if (!publication) return;
      assertRowVersion(input.dispatchRowVersion, publication.row_version, 'OZON publication readback');
      if (String(jsonObject(jsonObject(publication.result_json).readback).requestRef || '') !== input.requestRef) return;
      const job = (await client.query<SqlRow>(`SELECT * FROM ozon_publish_jobs WHERE publication_id=$1
        ORDER BY updated_at DESC,id DESC LIMIT 1 FOR UPDATE`, [input.publicationId])).rows[0];
      if (!job) throw new AppError('VERSION_CONFLICT', 'OZON publication readback 任务不存在', {
        publicationId: input.publicationId
      }, 409);
      const jobPayload = jsonObject(job.payload);
      const readbackHold = jsonObject(jobPayload.recoveryHold);
      if (readbackHold.active !== true || readbackHold.kind !== 'PUBLICATION_READBACK'
        || String(readbackHold.requestRef || '') !== input.requestRef) {
        throw new AppError('VERSION_CONFLICT', 'OZON publication readback hold 已变化', {
          publicationId: input.publicationId,
          jobId: job.id
        }, 409);
      }
      delete jobPayload.recoveryHold;
      const resultJson = {
        ...jsonObject(publication.result_json),
        readback: {
          requestRef: input.requestRef,
          deliveryState: input.deliveryState,
          retryClass: input.retryClass,
          ...(input.statusCode ? { statusCode: input.statusCode } : {}),
          completedAt: new Date().toISOString(),
          error: { code: input.errorCode, message: input.errorMessage.slice(0, 1_000) }
        }
      };
      await client.query(`UPDATE ozon_store_publications SET result_json=$2::jsonb,
        row_version=row_version+1,updated_at=NOW() WHERE id=$1`, [input.publicationId, JSON.stringify(resultJson)]);
      await client.query(`UPDATE ozon_publish_jobs SET payload=$2::jsonb,
        row_version=row_version+1,updated_at=NOW() WHERE id=$1`, [job.id, JSON.stringify(jobPayload)]);
    });
  }

  async cancelPublication(publicationId: string, expectedRowVersion: number): Promise<OzonStorePublication> {
    return this.transaction(async (client) => {
      const publication = await client.query<SqlRow>('SELECT * FROM ozon_store_publications WHERE id=$1 FOR UPDATE', [publicationId]);
      const row = publication.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'OZON publication 不存在', { publicationId }, 404);
      assertRowVersion(expectedRowVersion, row.row_version, 'OZON publication');
      if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(String(row.status))) return toPublication(row);
      const job = await client.query<SqlRow>(`SELECT * FROM ozon_publish_jobs WHERE publication_id=$1
        ORDER BY updated_at DESC,id DESC LIMIT 1 FOR UPDATE`, [publicationId]);
      if (job.rows[0]) {
        const blockers = publicationCancellationBlockers(job.rows[0]);
        if (blockers.length) {
          throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON publication 已有运行时或平台写入证据，必须先只读回查，禁止直接取消', {
            publicationId,
            jobId: job.rows[0].id,
            blockers
          }, 409);
        }
        await client.query(`UPDATE ozon_publish_jobs SET state='CANCELLED',last_error_code=NULL,last_error_message=NULL,
          lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,finished_at=NOW(),row_version=row_version+1,updated_at=NOW()
          WHERE id=$1`, [job.rows[0].id]);
        await client.query(`INSERT INTO ozon_publish_events(
          id,job_id,event_type,from_state,to_state,message,payload,store_id,publication_id
        ) VALUES($1,$2,'PUBLICATION_CANCELLED',$3,'CANCELLED',$4,'{}'::jsonb,$5,$6)`, [
          randomUUID(), job.rows[0].id, job.rows[0].state, 'OZON publication 已由操作员取消', row.store_id, publicationId
        ]);
      }
      const updated = await client.query<SqlRow>(`UPDATE ozon_store_publications SET
        status='CANCELLED',error_code='',error_message='',completed_at=NOW(),row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 RETURNING *`, [publicationId]);
      return toPublication(updated.rows[0]!);
    });
  }

  async republishPublication(publicationId: string, expectedRowVersion: number): Promise<OzonStorePublication> {
    return this.transaction(async (client) => {
      const publication = await client.query<SqlRow>('SELECT * FROM ozon_store_publications WHERE id=$1 FOR UPDATE', [publicationId]);
      const row = publication.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'OZON publication 不存在', { publicationId }, 404);
      assertRowVersion(expectedRowVersion, row.row_version, 'OZON publication');
      if (!['FAILED', 'CANCELLED', 'NEEDS_ATTENTION', 'PAUSED'].includes(String(row.status))) {
        throw new AppError('TASK_LOCKED', '当前 publication 状态不允许重新发布', { publicationId, status: row.status }, 409);
      }
      const jobResult = await client.query<SqlRow>(`SELECT * FROM ozon_publish_jobs WHERE publication_id=$1
        ORDER BY updated_at DESC,id DESC LIMIT 1 FOR UPDATE`, [publicationId]);
      const job = jobResult.rows[0];
      if (!job) throw new AppError('NOT_FOUND', 'OZON publication 任务不存在', { publicationId }, 404);
      const unsafe = Boolean(job.import_task_id || job.ozon_product_id || job.directory_stage === 'PROCESSING'
        || jsonObject(job.payload).platformWriteAttempted === true);
      if (unsafe) {
        throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON 平台可能已接收写入，必须先回查，禁止盲目重发', {
          publicationId, jobId: job.id
        }, 409);
      }
      await client.query(`UPDATE ozon_publish_jobs SET state='READY',retry_count=retry_count+1,
        last_error_code=NULL,last_error_message=NULL,next_attempt_at=NOW(),finished_at=NULL,
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,row_version=row_version+1,updated_at=NOW()
        WHERE id=$1`, [job.id]);
      await client.query(`INSERT INTO ozon_publish_events(
        id,job_id,event_type,from_state,to_state,message,payload,store_id,publication_id
      ) VALUES($1,$2,'PUBLICATION_REPUBLISH_QUEUED',$3,'READY',$4,'{}'::jsonb,$5,$6)`, [
        randomUUID(), job.id, job.state, 'OZON publication 已在明确未写入平台的证据下重新入队', row.store_id, publicationId
      ]);
      const updated = await client.query<SqlRow>(`UPDATE ozon_store_publications SET
        status='QUEUED',error_code='',error_message='',completed_at=NULL,
        row_version=row_version+1,updated_at=NOW() WHERE id=$1 RETURNING *`, [publicationId]);
      return toPublication(updated.rows[0]!);
    });
  }

  async getGatewayIdentity(input: {
    taskId?: string;
    storeId?: string;
    publicationId?: string;
    leaseToken?: string;
    requireActiveLease?: boolean;
  }): Promise<OzonGatewayIdentity> {
    if (input.taskId) {
      const result = await this.query<SqlRow>(`SELECT
          j.id job_id,j.task_id,j.import_task_id,j.ozon_product_id,j.lease_expires_at,j.lease_token,j.store_id,j.store_alias,j.publication_id,
          j.credential_version_id,j.credential_binding_mode,j.store_config_version,j.warehouse_id,
          j.offer_contract_hash,j.materialization_hash,j.offer_ids,s.enabled store_enabled,
          c.id credential_id,c.version_no,c.status credential_status,c.ciphertext,c.nonce,c.auth_tag,c.fingerprint,c.key_version,
          c.validated_at credential_validated_at,p.product_ids publication_product_ids,
          COALESCE((SELECT jsonb_agg(DISTINCT m.ozon_product_id) FROM ozon_product_mappings m
            WHERE m.store_id=j.store_id AND NULLIF(m.ozon_product_id,'') IS NOT NULL
              AND m.offer_id IN (SELECT jsonb_array_elements_text(
                CASE WHEN jsonb_typeof(j.offer_ids)='array' THEN j.offer_ids ELSE '[]'::jsonb END
              ))),'[]'::jsonb) mapped_product_ids
        FROM ozon_publish_jobs j
        JOIN ozon_stores s ON s.id=j.store_id
        LEFT JOIN ozon_store_publications candidate_publication ON candidate_publication.id=j.publication_id
        LEFT JOIN ozon_store_credential_versions c ON c.id=j.credential_version_id
        LEFT JOIN ozon_store_publications p ON p.id=j.publication_id
        WHERE j.task_id=$1 AND j.publication_id=$2 LIMIT 1`, [input.taskId, input.publicationId]);
      const row = result.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'OZON 网关任务绑定不存在', undefined, 404);
      const bindingMode = normalizeBindingMode(row.credential_binding_mode);
      if (input.requireActiveLease && (!input.leaseToken || String(row.lease_token || '') !== input.leaseToken
        || !row.lease_expires_at || new Date(row.lease_expires_at).getTime() <= Date.now())) {
        throw new AppError('TASK_LOCKED', 'OZON 网关任务租约已失效或已被新 worker 接管', {
          taskId: input.taskId
        }, 409);
      }
      if (bindingMode === 'VAULT' && !row.credential_id) {
        throw new AppError('OZON_CREDENTIAL_MISSING', 'OZON 任务冻结的 Vault 凭据不存在', undefined, 409);
      }
      if (bindingMode === 'VAULT' && !['ACTIVE', 'RETIRED'].includes(String(row.credential_status))) {
        throw new AppError('OZON_CREDENTIAL_STALE', 'OZON 任务冻结的 Vault 凭据状态无效', {
          credentialVersionId: row.credential_version_id
        }, 409);
      }
      if (bindingMode === 'VAULT' && input.requireActiveLease && (!row.credential_validated_at
        || new Date(row.credential_validated_at).getTime() <= Date.now() - OZON_PREFLIGHT_TTL_HOURS * 3_600_000)) {
        throw new AppError('OZON_CREDENTIAL_STALE', 'OZON 任务冻结的 Vault 凭据验证已过期', {
          credentialVersionId: row.credential_version_id
        }, 409);
      }
      if (bindingMode !== 'VAULT' && (String(row.store_id) !== OZON_DEFAULT_STORE_ID
        || !['LEGACY_PUBLICATION', 'PURE_LEGACY'].includes(bindingMode))) {
        throw new AppError('OZON_LEGACY_CREDENTIAL_REQUIRED', '仅固定 default 店历史任务可进入 legacy Credential 分支', {
          storeId: row.store_id,
          credentialBindingMode: bindingMode
        }, 409);
      }
      return gatewayIdentityFromRow(row);
    }
    const result = await this.query<SqlRow>(`SELECT
        s.id store_id,s.store_alias,s.enabled store_enabled,s.config_version store_config_version,s.warehouse_id,
        c.id credential_id,c.version_no,c.status credential_status,c.ciphertext,c.nonce,c.auth_tag,c.fingerprint,c.key_version,
        CASE WHEN c.status='PENDING' THEN rs.preflight_lock_expires_at ELSE NULL END lease_expires_at
      FROM ozon_stores s
      JOIN LATERAL (
        SELECT cv.* FROM ozon_store_credential_versions cv
        LEFT JOIN ozon_store_runtime_state runtime_lock ON runtime_lock.store_id=s.id
        WHERE cv.store_id=s.id AND (
          cv.status='ACTIVE'
          OR (cv.status='PENDING' AND runtime_lock.preflight_credential_version_id=cv.id
            AND runtime_lock.preflight_store_config_version=s.config_version AND runtime_lock.preflight_lock_expires_at>NOW())
        )
        ORDER BY CASE cv.status WHEN 'PENDING' THEN 0 ELSE 1 END,cv.version_no DESC LIMIT 1
      ) c ON true
      LEFT JOIN ozon_store_runtime_state rs ON rs.store_id=s.id
      WHERE s.id=$1 AND s.archived_at IS NULL`, [input.storeId]);
    const row = result.rows[0];
    if (!row) throw new AppError('NOT_FOUND', 'OZON 预检店铺或凭据不存在', undefined, 404);
    return gatewayIdentityFromRow({
      ...row,
      credential_binding_mode: 'VAULT',
      credential_version_id: row.credential_id,
      publication_id: null,
      task_id: null,
      lease_expires_at: row.lease_expires_at,
      offer_contract_hash: null,
      materialization_hash: null
      ,offer_ids: []
    });
  }

  /**
   * Resolves exactly the store/config/credential tuple frozen by a caller.
   * Unlike getGatewayIdentity({ storeId }), this method never selects a newer
   * ACTIVE or in-flight PENDING credential on the caller's behalf.
   */
  async getExactStoreReadbackIdentity(input: {
    storeId: string;
    expectedStoreConfigVersion: number;
    expectedCredentialVersionId: string;
  }): Promise<OzonExactStoreReadbackIdentity> {
    const storeId = String(input.storeId || '').trim();
    const credentialVersionId = String(input.expectedCredentialVersionId || '').trim();
    if (!UUID_PATTERN.test(storeId) || !UUID_PATTERN.test(credentialVersionId)
      || !Number.isSafeInteger(input.expectedStoreConfigVersion)
      || input.expectedStoreConfigVersion < 1) {
      throw new AppError('CONFIG_INVALID', 'OZON 逐店只读证明缺少有效的店铺、配置或凭据版本身份', {
        storeId,
        expectedStoreConfigVersion: input.expectedStoreConfigVersion,
        expectedCredentialVersionId: credentialVersionId
      }, 400);
    }
    const result = await this.query<SqlRow>(`SELECT
        s.id store_id,s.store_alias,s.enabled store_enabled,s.archived_at,
        s.config_version store_config_version,s.warehouse_id,s.active_credential_version_id,
        c.id credential_id,c.store_id credential_store_id,c.version_no,
        c.status credential_status,c.ciphertext,c.nonce,c.auth_tag,c.fingerprint,c.key_version
      FROM ozon_stores s
      LEFT JOIN ozon_store_credential_versions c
        ON c.store_id=s.id AND c.id=$2::uuid
      WHERE s.id=$1::uuid`, [storeId, credentialVersionId]);
    const row = result.rows[0];
    if (!row) {
      throw new AppError('OZON_STORE_NOT_READY', 'OZON 逐店只读证明的店铺不存在', { storeId }, 409);
    }
    if (row.archived_at || row.store_enabled !== true) {
      throw new AppError('OZON_STORE_NOT_READY', 'OZON 逐店只读证明要求店铺未归档且已启用', {
        storeId,
        enabled: Boolean(row.store_enabled),
        archived: Boolean(row.archived_at)
      }, 409);
    }
    if (Number(row.store_config_version) !== input.expectedStoreConfigVersion) {
      throw new AppError('VERSION_CONFLICT', 'OZON 逐店只读证明的店铺配置版本已变化', {
        storeId,
        expectedStoreConfigVersion: input.expectedStoreConfigVersion,
        actualStoreConfigVersion: Number(row.store_config_version)
      }, 409);
    }
    if (!row.credential_id || String(row.credential_store_id || '') !== storeId) {
      throw new AppError('OZON_CREDENTIAL_MISSING', 'OZON 逐店只读证明的冻结凭据不存在或不属于该店铺', {
        storeId,
        expectedCredentialVersionId: credentialVersionId
      }, 409);
    }
    if (String(row.credential_status || '') !== 'ACTIVE'
      || String(row.active_credential_version_id || '') !== credentialVersionId) {
      throw new AppError('OZON_CREDENTIAL_STALE', 'OZON 逐店只读证明只允许使用该店当前 ACTIVE 的精确凭据版本', {
        storeId,
        expectedCredentialVersionId: credentialVersionId,
        actualActiveCredentialVersionId: row.active_credential_version_id || undefined,
        credentialStatus: row.credential_status || undefined
      }, 409);
    }
    const identity = gatewayIdentityFromRow({
      ...row,
      credential_binding_mode: 'VAULT',
      credential_version_id: row.credential_id,
      publication_id: null,
      task_id: null,
      lease_expires_at: null,
      offer_contract_hash: null,
      materialization_hash: null,
      offer_ids: []
    });
    if (!identity.credential || !identity.credentialVersionId) {
      throw new AppError('OZON_CREDENTIAL_MISSING', 'OZON 逐店只读证明无法构造冻结凭据身份', {
        storeId,
        expectedCredentialVersionId: credentialVersionId
      }, 409);
    }
    return identity as OzonExactStoreReadbackIdentity;
  }

  async beginGatewayRequest(input: {
    requestRef: string;
    requestHash: string;
    payloadHash: string;
    identity: OzonGatewayIdentity;
    operation: string;
  }): Promise<{ existing?: SqlRow }> {
    return this.transaction(async (client) => {
      // SELECT ... FOR UPDATE cannot lock a missing key. Let the unique index
      // serialize concurrent creators, then lock and compare the authoritative
      // row so same-hash requests are idempotent instead of leaking 23505.
      const inserted = await client.query(`INSERT INTO ozon_gateway_requests(
        request_ref,request_hash,payload_hash,task_id,publication_id,store_id,credential_version_id,
        credential_binding_mode,operation,
        delivery_state,retry_class,response_json
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'NOT_SENT','NONE','{}'::jsonb)
      ON CONFLICT(request_ref) DO NOTHING RETURNING request_ref`, [
        input.requestRef, input.requestHash, input.payloadHash, input.identity.taskId || null,
        input.identity.publicationId || null, input.identity.storeId, input.identity.credentialVersionId || null,
        input.identity.credentialBindingMode, input.operation
      ]);
      const locked = await client.query<SqlRow>(
        'SELECT * FROM ozon_gateway_requests WHERE request_ref=$1 FOR UPDATE',
        [input.requestRef]
      );
      const row = locked.rows[0];
      if (!row) throw new AppError('VERSION_CONFLICT', 'OZON 网关 requestRef 创建后不可见', { requestRef: input.requestRef }, 409);
      if (String(row.request_hash) !== input.requestHash) {
        throw new AppError('VERSION_CONFLICT', 'OZON 网关 requestRef 已被不同请求占用', { requestRef: input.requestRef }, 409);
      }
      return inserted.rowCount ? {} : { existing: row };
    });
  }

  async beginVariantColorRepairIntent(
    input: OzonVariantColorRepairIntentInput
  ): Promise<OzonVariantColorRepairIntent> {
    if (!UUID_PATTERN.test(input.publicationId)
      || !UUID_PATTERN.test(input.credentialVersionId)
      || !Number.isSafeInteger(input.publicationRowVersion) || input.publicationRowVersion < 1
      || !Number.isSafeInteger(input.storeConfigVersion) || input.storeConfigVersion < 1
      || !input.taskId || !input.requestRef
      || !/^sha256:[a-f0-9]{64}$/.test(input.requestHash)
      || !/^sha256:[a-f0-9]{64}$/.test(input.payloadHash)
      || !/^sha256:[a-f0-9]{64}$/.test(input.planHash)
      || !input.offerIds.length || new Set(input.offerIds).size !== input.offerIds.length) {
      throw new AppError('CONFIG_INVALID', 'OZON 变体颜色维修 intent 合同无效', undefined, 400);
    }
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('merchroute-ozon-variant-color-repair'),hashtext($1))", [input.publicationId]);
      const selected = await client.query<SqlRow>(`SELECT
          p.*,p.row_version publication_row_version,p.store_config_version frozen_store_config_version,
          j.id job_id,j.state job_state,j.task_id job_task_id,j.lease_owner,j.lease_token,j.lease_expires_at,
          s.store_alias,s.enabled store_enabled,s.archived_at store_archived_at,s.config_version current_store_config_version,
          c.id credential_id,c.version_no,c.status credential_status,c.ciphertext,c.nonce,c.auth_tag,c.fingerprint,c.key_version,
          c.validated_at credential_validated_at,p.product_ids publication_product_ids,'[]'::jsonb mapped_product_ids
        FROM ozon_store_publications p
        JOIN ozon_publish_jobs j ON j.publication_id=p.id AND j.id=p.planned_job_id
        JOIN ozon_stores s ON s.id=p.store_id
        JOIN ozon_store_credential_versions c ON c.id=p.credential_version_id AND c.store_id=p.store_id
        WHERE p.id=$1
        FOR UPDATE OF p,j,s,c`, [input.publicationId]);
      const row = selected.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'OZON 变体颜色维修目标 publication 不存在', { publicationId: input.publicationId }, 404);
      const actualOfferIds = normalizeStringArray(row.offer_ids).sort();
      const expectedOfferIds = [...input.offerIds].sort();
      const mismatch = [
        String(row.status) !== 'SUCCEEDED' ? 'publicationStatus' : '',
        String(row.job_state) !== 'SUCCEEDED' ? 'jobState' : '',
        Number(row.publication_row_version) !== input.publicationRowVersion ? 'publicationRowVersion' : '',
        String(row.job_task_id || '') !== input.taskId || String(row.task_id || '') !== input.taskId ? 'taskId' : '',
        String(row.credential_binding_mode) !== 'VAULT' ? 'credentialBindingMode' : '',
        String(row.credential_id || '') !== input.credentialVersionId ? 'credentialVersionId' : '',
        Number(row.frozen_store_config_version) !== input.storeConfigVersion
          || Number(row.current_store_config_version) !== input.storeConfigVersion ? 'storeConfigVersion' : '',
        !row.store_enabled || row.store_archived_at ? 'storeEnabled' : '',
        !['ACTIVE', 'RETIRED'].includes(String(row.credential_status || '')) ? 'credentialStatus' : '',
        row.lease_owner || row.lease_token || row.lease_expires_at ? 'jobLease' : '',
        actualOfferIds.length !== expectedOfferIds.length
          || actualOfferIds.some((offerId, index) => offerId !== expectedOfferIds[index]) ? 'offerIds' : ''
      ].filter(Boolean);
      if (mismatch.length) {
        throw new AppError('VERSION_CONFLICT', 'OZON 变体颜色维修目标已偏离 dry-run 冻结身份', {
          publicationId: input.publicationId,
          mismatch
        }, 409);
      }
      const existing = (await client.query<SqlRow>(
        'SELECT * FROM ozon_gateway_requests WHERE request_ref=$1 FOR UPDATE',
        [input.requestRef]
      )).rows[0];
      if (existing) {
        if (String(existing.request_hash) !== input.requestHash
          || String(existing.payload_hash) !== input.payloadHash
          || String(existing.publication_id || '') !== input.publicationId
          || String(existing.operation || '') !== 'attributesUpdate') {
          throw new AppError('VERSION_CONFLICT', 'OZON 变体颜色维修 requestRef 已被不同请求占用', {
            requestRef: input.requestRef
          }, 409);
        }
        return {
          requestRef: input.requestRef,
          existing: redactCredentialLikeKeys(existing) as JsonRecord
        };
      }
      const unknown = await client.query<{ exists: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM ozon_gateway_requests
        WHERE publication_id=$1 AND delivery_state='UNKNOWN'
      ) AS exists`, [input.publicationId]);
      if (unknown.rows[0]?.exists) {
        throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON publication 存在 UNKNOWN 网关写入，禁止颜色维修', {
          publicationId: input.publicationId
        }, 409);
      }
      await client.query('DELETE FROM ozon_publish_slots WHERE slot_key=$1 AND lease_expires_at<=NOW()', [OZON_RUNTIME_WRITE_SLOT_KEY]);
      const activeSlot = await client.query<{ exists: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM ozon_publish_slots WHERE slot_key=$1 AND lease_expires_at>NOW()
      ) AS exists`, [OZON_RUNTIME_WRITE_SLOT_KEY]);
      if (activeSlot.rows[0]?.exists) {
        throw new AppError('TASK_LOCKED', 'OZON 平台单写槽正在使用，暂不能执行颜色维修', undefined, 409);
      }
      const leaseToken = randomUUID();
      await client.query(`INSERT INTO ozon_publish_slots(
        slot_key,job_id,lease_owner,lease_token,lease_expires_at,updated_at
      ) VALUES($1,$2,'variant-color-repair',$3::uuid,NOW()+INTERVAL '15 minutes',NOW())`, [
        OZON_RUNTIME_WRITE_SLOT_KEY, row.job_id, leaseToken
      ]);
      await client.query(`INSERT INTO ozon_gateway_requests(
        request_ref,request_hash,payload_hash,task_id,publication_id,store_id,credential_version_id,
        credential_binding_mode,operation,delivery_state,retry_class,response_json
      ) VALUES($1,$2,$3,$4,$5,$6,$7,'VAULT','attributesUpdate','UNKNOWN','READBACK_REQUIRED',$8::jsonb)`, [
        input.requestRef, input.requestHash, input.payloadHash, input.taskId, input.publicationId,
        row.store_id, input.credentialVersionId,
        JSON.stringify({ intent: 'OZON_VARIANT_COLOR_REPAIR', planHash: input.planHash })
      ]);
      await client.query(`INSERT INTO ozon_publish_events(
        id,job_id,event_type,from_state,to_state,message,payload,store_id,publication_id
      ) VALUES($1,$2,'OZON_VARIANT_COLOR_REPAIR_INTENT','SUCCEEDED','SUCCEEDED',$3,$4::jsonb,$5,$6)`, [
        randomUUID(), row.job_id, '已冻结 OZON 变体颜色属性维修意图',
        JSON.stringify(redactCredentialLikeKeys({
          requestRef: input.requestRef,
          requestHash: input.requestHash,
          payloadHash: input.payloadHash,
          planHash: input.planHash,
          offerIds: expectedOfferIds,
          evidence: input.evidence
        })), row.store_id, input.publicationId
      ]);
      return { requestRef: input.requestRef, leaseToken };
    });
  }

  async completeVariantColorRepair(input: {
    requestRef: string;
    leaseToken?: string;
    deliveryState: OzonGatewayDeliveryState;
    retryClass: OzonGatewayRetryClass;
    statusCode?: number;
    response: unknown;
    eventType: 'OZON_VARIANT_COLOR_REPAIR_CONFIRMED' | 'OZON_VARIANT_COLOR_REPAIR_FAILED' | 'OZON_VARIANT_COLOR_REPAIR_UNKNOWN';
    message: string;
  }): Promise<void> {
    await this.transaction(async (client) => {
      const result = await client.query<SqlRow>(`SELECT gateway.*,job.id job_id,job.state job_state
        FROM ozon_gateway_requests gateway
        JOIN ozon_publish_jobs job ON job.task_id=gateway.task_id AND job.publication_id=gateway.publication_id
        WHERE gateway.request_ref=$1 AND gateway.operation='attributesUpdate' FOR UPDATE OF gateway`, [input.requestRef]);
      const row = result.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'OZON 颜色维修网关账本不存在', { requestRef: input.requestRef }, 404);
      if (input.leaseToken) {
        const slot = await client.query<{ exists: boolean }>(`SELECT EXISTS(
          SELECT 1 FROM ozon_publish_slots WHERE slot_key=$1 AND job_id=$2 AND lease_token=$3::uuid AND lease_expires_at>NOW()
        ) AS exists`, [OZON_RUNTIME_WRITE_SLOT_KEY, row.job_id, input.leaseToken]);
        if (!slot.rows[0]?.exists) throw new AppError('TASK_LOCKED', 'OZON 颜色维修写槽已失效', undefined, 409);
      }
      await client.query(`UPDATE ozon_gateway_requests SET
        delivery_state=$2,retry_class=$3,status_code=$4,response_json=$5::jsonb,completed_at=NOW(),updated_at=NOW()
        WHERE request_ref=$1`, [
        input.requestRef, input.deliveryState, input.retryClass, input.statusCode ?? null,
        JSON.stringify(redactCredentialLikeKeys(input.response))
      ]);
      await client.query(`INSERT INTO ozon_publish_events(
        id,job_id,event_type,from_state,to_state,message,payload,store_id,publication_id
      ) VALUES($1,$2,$3,$4,$4,$5,$6::jsonb,$7,$8)`, [
        randomUUID(), row.job_id, input.eventType, row.job_state, input.message,
        JSON.stringify(redactCredentialLikeKeys({
          requestRef: input.requestRef,
          deliveryState: input.deliveryState,
          retryClass: input.retryClass,
          statusCode: input.statusCode,
          response: input.response
        })), row.store_id, row.publication_id
      ]);
      if (input.leaseToken) {
        await client.query(`DELETE FROM ozon_publish_slots
          WHERE slot_key=$1 AND job_id=$2 AND lease_token=$3::uuid`, [
          OZON_RUNTIME_WRITE_SLOT_KEY, row.job_id, input.leaseToken
        ]);
      }
    });
  }

  async markGatewaySending(requestRef: string, leaseToken?: string): Promise<boolean> {
    const result = await this.query(`UPDATE ozon_gateway_requests gateway SET
      delivery_state='UNKNOWN',retry_class='READBACK_REQUIRED',completed_at=NULL,updated_at=NOW()
      WHERE gateway.request_ref=$1 AND gateway.delivery_state='NOT_SENT'
        AND gateway.retry_class IN ('NONE','RETRYABLE') AND gateway.delegation_state='NONE'
        AND ($2::uuid IS NULL OR EXISTS(
          SELECT 1 FROM ozon_publish_jobs job
          JOIN ozon_stores store ON store.id=job.store_id
          WHERE job.task_id=gateway.task_id AND job.publication_id=gateway.publication_id
            AND job.store_id=gateway.store_id AND job.lease_token=$2::uuid
            AND job.lease_expires_at>NOW() AND store.enabled=true AND store.archived_at IS NULL
        ))`, [requestRef, leaseToken || null]);
    return Boolean(result.rowCount);
  }

  async markLegacyDelegationIntent(requestRef: string, leaseToken?: string): Promise<boolean> {
    const result = await this.query(`UPDATE ozon_gateway_requests gateway SET
      delivery_state='UNKNOWN',retry_class='READBACK_REQUIRED',delegation_state='AUTHORIZED_ONCE',
      status_code=NULL,response_json='{"legacyDispatchWithheld":true}'::jsonb,completed_at=NULL,updated_at=NOW()
      WHERE gateway.request_ref=$1 AND gateway.delivery_state='NOT_SENT' AND gateway.retry_class IN ('NONE','RETRYABLE')
        AND gateway.credential_binding_mode IN ('LEGACY_PUBLICATION','PURE_LEGACY') AND gateway.delegation_state='NONE'
        AND ($2::uuid IS NULL OR EXISTS(
          SELECT 1 FROM ozon_publish_jobs job
          JOIN ozon_stores store ON store.id=job.store_id
          WHERE job.task_id=gateway.task_id AND job.publication_id=gateway.publication_id
            AND job.store_id=gateway.store_id AND job.lease_token=$2::uuid
            AND job.lease_expires_at>NOW() AND store.enabled=true AND store.archived_at IS NULL
        ))`, [requestRef, leaseToken || null]);
    return Boolean(result.rowCount);
  }

  async getGatewayRequest(requestRef: string): Promise<SqlRow> {
    const result = await this.query<SqlRow>('SELECT * FROM ozon_gateway_requests WHERE request_ref=$1', [requestRef]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'OZON 网关 requestRef 不存在', { requestRef }, 404);
    return result.rows[0];
  }

  async getProvisionalImportProductIds(input: {
    taskId: string;
    publicationId: string;
    storeId: string;
  }): Promise<string[]> {
    const result = await this.query<SqlRow>(`SELECT
        gateway.task_id,gateway.publication_id,gateway.store_id,gateway.operation,
        gateway.delivery_state,gateway.retry_class,gateway.status_code,gateway.response_json,
        job.offer_ids job_offer_ids,publication.offer_ids publication_offer_ids
      FROM ozon_gateway_requests gateway
      JOIN ozon_publish_jobs job ON job.task_id=gateway.task_id
        AND job.publication_id=gateway.publication_id AND job.store_id=gateway.store_id
      JOIN ozon_store_publications publication ON publication.id=gateway.publication_id
        AND publication.store_id=gateway.store_id AND publication.task_id=gateway.task_id
      WHERE gateway.task_id=$1 AND gateway.publication_id=$2 AND gateway.store_id=$3
        AND gateway.operation='importInfo' AND gateway.delivery_state='RESPONDED'
        AND gateway.retry_class='NONE' AND gateway.status_code BETWEEN 200 AND 299`, [
      input.taskId, input.publicationId, input.storeId
    ]);
    return provisionalImportProductIds(result.rows, input);
  }

  async recordLegacyGatewayReceipt(input: OzonGatewayLegacyReceipt): Promise<SqlRow> {
    return this.transaction(async (client) => {
      const result = await client.query<SqlRow>('SELECT * FROM ozon_gateway_requests WHERE request_ref=$1 FOR UPDATE', [input.requestRef]);
      const row = result.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'OZON legacy 网关回执不存在', { requestRef: input.requestRef }, 404);
      if (!['LEGACY_PUBLICATION', 'PURE_LEGACY'].includes(String(row.credential_binding_mode))
        || String(row.operation) !== input.operation || String(row.payload_hash) !== input.payloadHash) {
        throw new AppError('VERSION_CONFLICT', 'OZON legacy 回执与冻结授权不一致', { requestRef: input.requestRef }, 409);
      }
      if (row.delegation_state === 'RECEIPT_RECORDED') return row;
      if (row.delegation_state !== 'AUTHORIZED_ONCE' || row.delivery_state !== 'UNKNOWN') {
        throw new AppError('VERSION_CONFLICT', 'OZON legacy 回执没有可消耗的单次授权', { requestRef: input.requestRef }, 409);
      }
      if (LEGACY_WRITE_OPERATIONS.has(String(row.operation))
        && input.deliveryState === 'NOT_SENT'
        && ![0, 425, 429].includes(input.statusCode)) {
        throw new AppError('VERSION_CONFLICT', 'OZON legacy 写回执缺少明确未发送证据，必须进入 UNKNOWN 回查', {
          requestRef: input.requestRef,
          operation: row.operation,
          statusCode: input.statusCode
        }, 409);
      }
      const updated = await client.query<SqlRow>(`UPDATE ozon_gateway_requests SET
        delivery_state=$2,retry_class=$3,retry_after_ms=$4,status_code=$5,response_json=$6::jsonb,
        delegation_state='RECEIPT_RECORDED',completed_at=NOW(),updated_at=NOW()
        WHERE request_ref=$1 RETURNING *`, [
        input.requestRef, input.deliveryState, input.retryClass, input.retryAfterMs ?? null,
        input.statusCode || null, JSON.stringify(redactCredentialLikeKeys(input.result))
      ]);
      return updated.rows[0]!;
    });
  }

  async completeGatewayRequest(input: {
    requestRef: string;
    deliveryState: OzonGatewayDeliveryState;
    retryClass: OzonGatewayRetryClass;
    retryAfterMs?: number;
    statusCode?: number;
    response: unknown;
  }): Promise<void> {
    await this.query(`UPDATE ozon_gateway_requests SET delivery_state=$2,retry_class=$3,retry_after_ms=$4,
      status_code=$5,response_json=$6::jsonb,completed_at=NOW(),updated_at=NOW() WHERE request_ref=$1`, [
      input.requestRef, input.deliveryState, input.retryClass, input.retryAfterMs ?? null,
      input.statusCode ?? null, JSON.stringify(redactCredentialLikeKeys(input.response))
    ]);
  }

  async claimRuntimeJobs(input: {
    leaseOwner: string;
    leaseSeconds: number;
    limit: number;
    states?: string[];
  }): Promise<OzonRuntimeClaimJob[]> {
    if (!fleetCapabilityReady()) return [];
    const states = input.states?.length ? input.states.filter((state) => CLAIMABLE_JOB_STATES.includes(state as any)) : [...CLAIMABLE_JOB_STATES];
    if (!states.length) return [];
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('merchroute-ozon-multistore-claim'))");
      await client.query(`UPDATE ozon_publish_jobs SET lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
        row_version=row_version+1,updated_at=NOW() WHERE lease_expires_at<=NOW()`);
      await client.query(`UPDATE ozon_publish_jobs SET
        payload=payload-'recoveryHold',row_version=row_version+1,updated_at=NOW()
        WHERE payload @> '{"recoveryHold":{"active":true,"kind":"PUBLICATION_READBACK"}}'::jsonb
          AND (payload#>>'{recoveryHold,expiresAt}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
          AND NULLIF(payload#>>'{recoveryHold,expiresAt}','')::timestamptz<=NOW()`);
      const settings = await client.query<SqlRow>("SELECT enabled,global_concurrency FROM ozon_system_settings WHERE id='default' FOR SHARE");
      if (!settings.rows[0]?.enabled) return [];
      const occupied = await client.query<{ count: string }>('SELECT COUNT(*) count FROM ozon_publish_jobs WHERE lease_expires_at>NOW()');
      const available = Math.max(0, Number(settings.rows[0].global_concurrency || 2) - Number(occupied.rows[0]?.count || 0));
      const limit = Math.min(available, Math.max(1, Math.min(2, input.limit)));
      if (!limit) return [];
      const candidates = await client.query<SqlRow>(`WITH ranked AS (
        SELECT j.id,j.store_id,
          rs.last_dispatched_at,
          ROW_NUMBER() OVER(PARTITION BY j.store_id ORDER BY COALESCE(j.next_attempt_at,j.updated_at),j.id) store_rank
        FROM ozon_publish_jobs j
        JOIN ozon_stores s ON s.id=j.store_id
        LEFT JOIN ozon_store_publications candidate_publication ON candidate_publication.id=j.publication_id
        LEFT JOIN ozon_store_credential_versions frozen_credential
          ON frozen_credential.id=j.credential_version_id AND frozen_credential.store_id=j.store_id
        LEFT JOIN ozon_store_runtime_state rs ON rs.store_id=s.id
        WHERE j.state=ANY($1::text[])
          AND j.task_kind<>'SHARED_PREPARATION'
          AND (j.task_kind<>'STORE_PUBLICATION' OR (
            j.payload->>'contentPolicyVersion' IN ('merchroute-ozon-content-v2','merchroute-ozon-content-v3')
            AND COALESCE(j.payload->>'materialHash','') ~ '^sha256:[a-f0-9]{64}$'
            AND j.payload->>'materialHashVersion'='ozon-shared-material-v1'
            AND candidate_publication.content_policy_version=j.payload->>'contentPolicyVersion'
            AND candidate_publication.material_hash=j.payload->>'materialHash'
            AND candidate_publication.material_hash_version=j.payload->>'materialHashVersion'
            AND candidate_publication.plan_hash=j.payload->>'planHash'
            AND candidate_publication.preset_row_version::text=j.payload->>'presetRowVersion'
            AND candidate_publication.publication_mode=j.payload->>'publicationMode'
          ))
          AND (j.next_attempt_at IS NULL OR j.next_attempt_at<=NOW())
          AND (j.lease_expires_at IS NULL OR j.lease_expires_at<=NOW())
          AND NOT (j.payload @> '{"recoveryHold":{"active":true}}'::jsonb)
          AND NOT EXISTS(SELECT 1 FROM ozon_publish_jobs leased WHERE leased.store_id=j.store_id AND leased.lease_expires_at>NOW())
          AND (
            (j.credential_binding_mode='VAULT' AND s.enabled=true AND s.archived_at IS NULL
              AND s.preflight_status='PASSED' AND s.preflight_expires_at>NOW()
              AND frozen_credential.status IN ('ACTIVE','RETIRED')
              AND frozen_credential.validated_at>NOW()-make_interval(hours=>$3))
            OR
            (j.credential_binding_mode<>'VAULT' AND (
              NULLIF(j.task_id,'') IS NOT NULL OR NULLIF(j.import_task_id,'') IS NOT NULL
              OR NULLIF(j.ozon_product_id,'') IS NOT NULL OR j.directory_stage='PROCESSING'
            ))
          )
      ) SELECT j.*,ranked.last_dispatched_at,
          p.content_policy_version publication_content_policy_version,
          p.material_hash publication_material_hash,
          p.material_hash_version publication_material_hash_version,
          p.plan_hash publication_plan_hash,
          p.preset_row_version publication_preset_row_version,
          p.publication_mode publication_mode
        FROM ranked
        JOIN ozon_publish_jobs j ON j.id=ranked.id
        LEFT JOIN ozon_store_publications p ON p.id=j.publication_id
        WHERE ranked.store_rank=1
        ORDER BY COALESCE(ranked.last_dispatched_at,'epoch'::timestamptz),COALESCE(j.next_attempt_at,j.updated_at),j.id
        FOR UPDATE OF j SKIP LOCKED LIMIT $2`, [states, limit, OZON_PREFLIGHT_TTL_HOURS]);
      const jobs: OzonRuntimeClaimJob[] = [];
      for (const row of candidates.rows) {
        const leaseToken = randomUUID();
        const updated = await client.query<SqlRow>(`UPDATE ozon_publish_jobs SET
          lease_owner=$2,lease_token=$3,lease_expires_at=NOW()+make_interval(secs=>$4),
          row_version=row_version+1,updated_at=NOW() WHERE id=$1 AND row_version=$5 RETURNING *,
          $6::text publication_content_policy_version,
          $7::text publication_material_hash,
          $8::text publication_material_hash_version,
          $9::text publication_plan_hash,
          $10::integer publication_preset_row_version,
          $11::text publication_mode`, [
          row.id, input.leaseOwner, leaseToken, input.leaseSeconds, Number(row.row_version),
          row.publication_content_policy_version || null,
          row.publication_material_hash || null,
          row.publication_material_hash_version || null,
          row.publication_plan_hash || null,
          row.publication_preset_row_version || null,
          row.publication_mode || null
        ]);
        if (!updated.rows[0]) continue;
        await client.query(`UPDATE ozon_store_runtime_state SET last_dispatched_at=NOW(),updated_at=NOW() WHERE store_id=$1`, [row.store_id]);
        await client.query(`INSERT INTO ozon_publish_events(
          id,job_id,event_type,from_state,to_state,message,payload,store_id,publication_id
        ) VALUES($1,$2,'RUNTIME_LEASE_CLAIMED',$3,$3,$4,$5::jsonb,$6,$7)`, [
          randomUUID(), row.id, row.state, 'OZON 多店运行时已领取独立租约',
          JSON.stringify({ leaseOwner: input.leaseOwner, leaseToken, leaseSeconds: input.leaseSeconds }),
          row.store_id, row.publication_id
        ]);
        jobs.push(toRuntimeJob(updated.rows[0]));
      }
      return jobs;
    });
  }

  async assertRuntimeBinding(jobId: string, input: {
    storeId: string;
    publicationId?: string;
    credentialVersionId?: string;
    credentialBindingMode: OzonCredentialBindingMode;
    storeConfigVersion: number;
    warehouseId: string;
    offerContractHash: string;
    materializationHash?: string;
    contentPolicyVersion: string;
    materialHash: string;
    materialHashVersion: string;
    rowVersion: number;
    leaseOwner: string;
    leaseToken: string;
  }): Promise<void> {
    const result = await this.query<SqlRow>(`SELECT j.*,
        p.content_policy_version publication_content_policy_version,
        p.material_hash publication_material_hash,
        p.material_hash_version publication_material_hash_version
      FROM ozon_publish_jobs j
      JOIN ozon_store_publications p ON p.id=j.publication_id
      WHERE j.id=$1`, [jobId]);
    const job = result.rows[0];
    if (!job) throw new AppError('NOT_FOUND', 'OZON 任务不存在', { jobId }, 404);
    const mismatches: string[] = [];
    if (String(job.store_id) !== input.storeId) mismatches.push('storeId');
    if (String(job.publication_id || '') !== String(input.publicationId || '')) mismatches.push('publicationId');
    if (String(job.credential_version_id || '') !== String(input.credentialVersionId || '')) mismatches.push('credentialVersionId');
    if (String(job.credential_binding_mode) !== input.credentialBindingMode) mismatches.push('credentialBindingMode');
    if (Number(job.store_config_version) !== input.storeConfigVersion) mismatches.push('storeConfigVersion');
    if (String(job.warehouse_id || '') !== input.warehouseId) mismatches.push('warehouseId');
    if (String(job.offer_contract_hash || '') !== input.offerContractHash) mismatches.push('offerContractHash');
    if (String(job.materialization_hash || '') !== String(input.materializationHash || '')) mismatches.push('materializationHash');
    if (String(job.publication_content_policy_version || '') !== input.contentPolicyVersion) mismatches.push('contentPolicyVersion');
    if (String(job.publication_material_hash || '') !== input.materialHash) mismatches.push('materialHash');
    if (String(job.publication_material_hash_version || '') !== input.materialHashVersion) mismatches.push('materialHashVersion');
    if (Number(job.row_version) !== input.rowVersion) mismatches.push('rowVersion');
    if (String(job.lease_owner || '') !== input.leaseOwner) mismatches.push('leaseOwner');
    if (String(job.lease_token || '') !== input.leaseToken) mismatches.push('leaseToken');
    if (!job.lease_expires_at || new Date(job.lease_expires_at).getTime() <= Date.now()) mismatches.push('leaseExpiresAt');
    if (mismatches.length) throw new AppError('VERSION_CONFLICT', 'OZON 运行时回调与冻结任务绑定不一致', { jobId, mismatches }, 409);
  }

  async verifyIntake(input: OzonIntakeVerify): Promise<{
    jobId: string;
    taskId: string;
    storeId: string;
    publicationId: string;
    sku: string;
    revision: number;
  }> {
    const result = await this.query<SqlRow>(`SELECT j.*,p.plan_hash publication_plan_hash,
        p.content_policy_version publication_content_policy_version,p.material_hash publication_material_hash,
        p.material_hash_version publication_material_hash_version,
        p.preset_row_version publication_preset_row_version,p.publication_mode
      FROM ozon_publish_jobs j JOIN ozon_store_publications p ON p.id=j.publication_id
      WHERE j.id=$1 AND j.lease_expires_at>NOW()`, [input.jobId]);
    const job = result.rows[0];
    if (!job) throw new AppError('TASK_LOCKED', 'OZON intake 任务不存在或租约已过期', { jobId: input.jobId }, 409);
    const mismatches: string[] = [];
    if (String(job.task_id || '') !== input.taskId) mismatches.push('taskId');
    if (String(job.store_id || '') !== input.storeId) mismatches.push('storeId');
    if (String(job.store_alias || '') !== input.storeAlias) mismatches.push('storeAlias');
    if (String(job.publication_id || '') !== input.publicationId) mismatches.push('publicationId');
    if (String(job.credential_version_id || '') !== String(input.credentialVersionId || '')) mismatches.push('credentialVersionId');
    if (String(job.credential_binding_mode || '') !== input.credentialBindingMode) mismatches.push('credentialBindingMode');
    if (Number(job.store_config_version) !== input.storeConfigVersion) mismatches.push('storeConfigVersion');
    if (String(job.warehouse_id || '') !== input.warehouseId) mismatches.push('warehouseId');
    if (String(job.sku) !== input.sku) mismatches.push('sku');
    if (Number(job.listing_revision) !== input.revision) mismatches.push('revision');
    if (String(job.publication_plan_hash || '') !== input.planHash) mismatches.push('planHash');
    if (String(job.publication_content_policy_version || '') !== input.contentPolicyVersion) mismatches.push('contentPolicyVersion');
    if (String(job.publication_material_hash || '') !== input.materialHash) mismatches.push('materialHash');
    if (String(job.publication_material_hash_version || '') !== input.materialHashVersion) mismatches.push('materialHashVersion');
    if (Number(job.publication_preset_row_version || 0) !== Number(input.presetRowVersion || 0)) mismatches.push('presetRowVersion');
    if (String(job.publication_mode || '') !== input.publicationMode) mismatches.push('publicationMode');
    if (String(job.directory_signature || '') !== input.productContentHash) mismatches.push('productContentHash');
    if (String(job.materialization_hash || '') !== input.materializationHash) mismatches.push('materializationHash');
    if (String(job.offer_contract_hash || '') !== input.offerContractHash) mismatches.push('offerContractHash');
    if (Number(job.row_version) !== input.rowVersion) mismatches.push('rowVersion');
    if (String(job.lease_token || '') !== input.leaseToken) mismatches.push('leaseToken');
    if (mismatches.length) {
      throw new AppError('VERSION_CONFLICT', 'OZON intake 票据与冻结任务身份不一致', {
        jobId: input.jobId,
        mismatches
      }, 409);
    }
    return {
      jobId: String(job.id),
      taskId: String(job.task_id),
      storeId: String(job.store_id),
      publicationId: String(job.publication_id),
      sku: String(job.sku),
      revision: Number(job.listing_revision)
    };
  }

  async getCredential(credentialVersionId: string): Promise<OzonStoreCredentialRecord> {
    const result = await this.query<SqlRow>('SELECT * FROM ozon_store_credential_versions WHERE id=$1', [credentialVersionId]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'OZON 凭据版本不存在', undefined, 404);
    return toCredential(result.rows[0]);
  }

  async upsertMediaConsumption(input: {
    storeId: string;
    sku: string;
    sourceStageId: string;
    submissionId: string;
    variantId: string;
    decision: string;
    publicationId?: string;
    jobId?: string;
    reason?: string;
  }): Promise<boolean> {
    const result = await this.query(`INSERT INTO ozon_store_media_consumptions(
      store_id,sku,source_stage_id,submission_id,variant_id,decision,publication_id,job_id,reason
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`, [
      input.storeId, normalizeSku(input.sku), input.sourceStageId, input.submissionId, input.variantId,
      input.decision, input.publicationId || null, input.jobId || null, input.reason || ''
    ]);
    return Boolean(result.rowCount);
  }

  private async getStoreWithClient(client: PoolClient, storeId: string, includeArchived = false): Promise<OzonStore> {
    const result = await client.query<SqlRow>(`${storeSelect()} WHERE s.id=$1 ${includeArchived ? '' : 'AND s.archived_at IS NULL'} LIMIT 1`, [storeId]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'OZON 店铺不存在', { storeId }, 404);
    return toStore(result.rows[0]);
  }

  private requirePool(): Pool {
    if (!this.pool) throw new AppError('DATABASE_UNAVAILABLE', 'OZON 多店铺尚未配置 PostgreSQL DATABASE_URL', undefined, 503);
    return this.pool;
  }

  private query<T extends QueryResultRow = any>(text: string, values?: unknown[]) {
    return this.requirePool().query<T>(text, values);
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.requirePool().connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function appendPreflightFailureRunWithClient(
  client: PoolClient,
  input: {
    storeId: string;
    storeConfigVersion: number;
    credentialVersionId: string;
    errorCode: string;
    errorMessage: string;
    source: 'LOCK_TIMEOUT' | 'DISPATCH_REJECTED';
    lockExpiresAt?: unknown;
  }
): Promise<boolean> {
  if (!input.credentialVersionId || !Number.isInteger(input.storeConfigVersion) || input.storeConfigVersion < 1) return false;
  const report = {
    source: `MERCHROUTE_${input.source}`,
    result: 'FAILED',
    ...(input.lockExpiresAt ? { lockExpiredAt: iso(input.lockExpiresAt) } : {})
  };
  const result = await client.query(`INSERT INTO ozon_store_preflight_runs(
      id,store_id,store_config_version,credential_version_id,result,report,observed_at,error_code,error_message
    ) SELECT $1,$2,$3,cv.id,'FAILED',$5::jsonb,NOW(),$6,$7
      FROM ozon_store_credential_versions cv WHERE cv.id=$4 AND cv.store_id=$2
    RETURNING id`, [
    randomUUID(), input.storeId, input.storeConfigVersion, input.credentialVersionId,
    JSON.stringify(report), input.errorCode, input.errorMessage
  ]);
  return Boolean(result.rowCount);
}

async function upsertMediaConsumptionWithClient(
  client: Pool | PoolClient,
  input: {
    storeId: string;
    sku: string;
    sourceStageId: string;
    submissionId: string;
    variantId?: string;
    publicationId?: string;
    jobId?: string;
    decision: string;
    reason?: string;
  }
): Promise<void> {
  await client.query(`INSERT INTO ozon_store_media_consumptions(
    store_id,sku,source_stage_id,submission_id,variant_id,decision,publication_id,job_id,reason
  ) VALUES($1,$2,$3,$4,$5,$6,$7,
    COALESCE($8::uuid,(SELECT id FROM ozon_publish_jobs WHERE publication_id=$7 ORDER BY created_at DESC LIMIT 1)),$9)
  ON CONFLICT(store_id,sku,source_stage_id,submission_id,variant_id) DO UPDATE SET
    decision=EXCLUDED.decision,publication_id=EXCLUDED.publication_id,job_id=EXCLUDED.job_id,
    reason=EXCLUDED.reason,updated_at=NOW()`, [
    input.storeId, normalizeSku(input.sku), String(input.sourceStageId), String(input.submissionId),
    String(input.variantId || ''), String(input.decision), input.publicationId || null, input.jobId || null,
    String(input.reason || '').slice(0, 1_000)
  ]);
}

export function publicationCancellationBlockers(job: JsonRecord): string[] {
  const payload = jsonObject(job.payload);
  const recovery = jsonObject(payload.networkRecovery);
  const blockers: string[] = [];
  if (!['WAITING_MEDIA', 'READY'].includes(String(job.state || ''))) blockers.push('runtimeState');
  if (job.import_task_id) blockers.push('importTaskId');
  if (job.ozon_product_id) blockers.push('ozonProductId');
  if (normalizeArray(job.product_links).length) blockers.push('productLinks');
  if (job.directory_stage === 'PROCESSING' || job.directory_stage === 'SUCCESS') blockers.push('directoryStage');
  if (payload.platformWriteAttempted === true) blockers.push('platformWriteAttempted');
  if (['UNKNOWN', 'RESPONDED'].includes(String(recovery.deliveryState || ''))) blockers.push('networkDeliveryState');
  if (job.lease_owner || job.lease_token || (job.lease_expires_at && new Date(String(job.lease_expires_at)).getTime() > Date.now())) {
    blockers.push('runtimeLease');
  }
  return [...new Set(blockers)];
}

function toScopedProductMapping(row: SqlRow): OzonProductMapping {
  return {
    storeAlias: String(row.store_alias || ''),
    offerId: String(row.offer_id || ''),
    sku: String(row.sku || ''),
    ...(row.ozon_product_id ? { ozonProductId: String(row.ozon_product_id) } : {}),
    ...(row.ozon_sku ? { ozonSku: String(row.ozon_sku) } : {}),
    ...(row.warehouse_id ? { warehouseId: String(row.warehouse_id) } : {}),
    lastAppliedRevision: Number(row.last_applied_revision || 0),
    status: String(row.status || 'UNKNOWN'),
    ...(Object.keys(jsonObject(row.status_snapshot)).length ? { statusSnapshot: jsonObject(row.status_snapshot) } : {}),
    ...(row.last_verified_at ? { lastVerifiedAt: iso(row.last_verified_at) } : {}),
    updatedAt: iso(row.updated_at)
  };
}

function readbackProductLinks(offers: OzonPlatformOfferStatus[]): JsonRecord[] {
  return offers.flatMap((offer) => offer.ozonProductId ? [{
    offerId: offer.offerId,
    ozonProductId: offer.ozonProductId,
    ...(offer.ozonSku ? { ozonSku: offer.ozonSku } : {}),
    url: `https://www.ozon.ru/product/${encodeURIComponent(offer.ozonProductId)}`,
    displayState: offer.displayState,
    ...(offer.platformMessage ? { platformMessage: offer.platformMessage } : {}),
    ...(offer.warnings?.length ? { warnings: offer.warnings } : {}),
    lastVerifiedAt: offer.readAt
  }] : []);
}

function storeSelect(): string {
  return `SELECT s.*,
    active.id active_credential_id,active.version_no active_credential_version,active.fingerprint active_fingerprint,
    active.updated_at active_credential_updated_at,pending.id pending_credential_id,pending.version_no pending_credential_version,
    runtime.network_attempt,runtime.network_next_attempt_at,runtime.network_last_error_code,runtime.network_last_error_message,
    (SELECT COUNT(*) FROM ozon_publish_jobs j WHERE j.store_id=s.id AND j.lease_expires_at>NOW()) active_task_count,
    (SELECT COUNT(*) FROM ozon_publish_jobs j WHERE j.store_id=s.id AND j.state=ANY(ARRAY['WAITING_MEDIA','READY']::text[])) queued_task_count
    ,(SELECT COUNT(*) FROM ozon_stores duplicate
      WHERE duplicate.id<>s.id AND duplicate.enabled=true AND duplicate.archived_at IS NULL
        AND duplicate.seller_id<>'' AND duplicate.seller_id=s.seller_id) duplicate_seller_count
  FROM ozon_stores s
  LEFT JOIN ozon_store_credential_versions active ON active.id=s.active_credential_version_id
  LEFT JOIN ozon_store_credential_versions pending ON pending.store_id=s.id AND pending.status='PENDING'
  LEFT JOIN ozon_store_runtime_state runtime ON runtime.store_id=s.id`;
}

function toSettings(row: SqlRow): OzonStoreSystemSettings {
  return {
    enabled: Boolean(row.enabled),
    rootDirectory: String(row.root_directory || ''),
    timezone: String(row.timezone || 'Asia/Shanghai'),
    globalConcurrency: Number(row.global_concurrency || 2),
    perStoreConcurrency: OZON_PER_STORE_CONCURRENCY,
    taskApiWebhookUrl: String(row.task_api_webhook_url || ''),
    adminApiWebhookUrl: String(row.admin_api_webhook_url || ''),
    preflightWebhookUrl: String(row.preflight_webhook_url || ''),
    imageUploaderWorkflowId: String(row.image_uploader_workflow_id || ''),
    storeGatewayWorkflowId: String(row.store_gateway_workflow_id || ''),
    imageUploadConcurrency: Number(row.image_upload_concurrency || 7),
    videoUploadConcurrency: Number(row.video_upload_concurrency || 2),
    videoPrewarmEnabled: Boolean(row.video_prewarm_enabled),
    videoUploadReady: Boolean(row.video_upload_ready),
    publicationReadbackEnabled: fleetCapabilityReady() && Boolean(row.admin_api_webhook_url),
    ...(row.video_upload_checked_at ? { videoUploadCheckedAt: iso(row.video_upload_checked_at) } : {}),
    ...(row.video_upload_message ? { videoUploadMessage: String(row.video_upload_message) } : {}),
    preflightTtlHours: OZON_PREFLIGHT_TTL_HOURS,
    preflightDueHours: OZON_PREFLIGHT_DUE_HOURS,
    rowVersion: Number(row.row_version),
    createdAt: iso(row.created_at || row.updated_at),
    updatedAt: iso(row.updated_at)
  };
}

function toStore(row: SqlRow): OzonStore {
  const blockers = readinessBlockers(row);
  const scoreParts = [
    Boolean(row.active_credential_version_id),
    Boolean(row.seller_id),
    Boolean(row.warehouse_id) && Boolean(row.account_currency),
    blockers.length === 0
  ];
  const checkedAt = row.preflight_checked_at ? iso(row.preflight_checked_at) : undefined;
  const dueAt = row.preflight_due_at ? iso(row.preflight_due_at) : undefined;
  const expiresAt = row.preflight_expires_at ? iso(row.preflight_expires_at) : undefined;
  const currencyEvidence = jsonObject(jsonObject(row.preflight_report).currencyVerification);
  const currencyVerification = String(currencyEvidence.status || '');
  const configuredCurrency = row.account_currency === 'CNY' ? 'CNY' : 'RUB';
  const verifiedCurrencyMatches = currencyVerification === 'VERIFIED'
    && String(currencyEvidence.currency || '') === configuredCurrency;
  return {
    id: String(row.id),
    storeAlias: String(row.store_alias),
    displayName: String(row.display_name),
    enabled: Boolean(row.enabled),
    autoPublishEnabled: Boolean(row.auto_publish_enabled),
    ...(row.auto_publish_activated_at ? { autoPublishActivatedAt: iso(row.auto_publish_activated_at) } : {}),
    autoPublishMode: row.auto_publish_mode === 'COMPATIBLE_UPSERT' ? 'COMPATIBLE_UPSERT' : 'CREATE_ONLY',
    ...(row.default_preset_id ? { defaultPresetId: String(row.default_preset_id) } : {}),
    warehouseId: String(row.warehouse_id || ''),
    warehouseName: String(row.warehouse_name || ''),
    fulfillmentMode: row.fulfillment_mode === 'RFBS' ? 'RFBS' : 'FBS',
    accountCurrency: row.account_currency === 'CNY' ? 'CNY' : 'RUB',
    maxDailyStyles: Number(row.max_daily_styles || 100),
    credential: {
      state: ['MISSING', 'LEGACY_EXTERNAL', 'PENDING', 'ACTIVE'].includes(String(row.credential_state))
        ? row.credential_state : 'MISSING',
      bindingMode: normalizeBindingMode(row.credential_binding_mode),
      configured: Boolean(row.active_credential_version_id || row.pending_credential_id),
      ...(row.active_credential_id ? { activeVersionId: String(row.active_credential_id) } : {}),
      ...(row.pending_credential_id ? { pendingVersionId: String(row.pending_credential_id) } : {}),
      ...(row.active_fingerprint ? { fingerprint: String(row.active_fingerprint) } : {}),
      ...(row.active_credential_version ? { version: Number(row.active_credential_version) } : {}),
      ...(row.active_credential_updated_at ? { updatedAt: iso(row.active_credential_updated_at) } : {})
    },
    seller: {
      ...(row.seller_id ? { id: String(row.seller_id) } : {}),
      ...(row.seller_name ? { name: String(row.seller_name) } : {})
    },
    permissions: normalizeStringArray(row.permissions),
    limits: jsonObject(row.limits),
    warehouses: normalizeArray(row.warehouses).map((entry) => {
      const warehouse = jsonObject(entry);
      return {
        id: String(warehouse.id || ''),
        name: String(warehouse.name || ''),
        fulfillmentModes: normalizeStringArray(warehouse.fulfillmentModes).filter((mode) => mode === 'FBS' || mode === 'RFBS') as Array<'FBS' | 'RFBS'>,
        ...(warehouse.status ? { status: String(warehouse.status) } : {})
      };
    }).filter((warehouse) => warehouse.id && warehouse.fulfillmentModes.length),
    preflight: {
      status: ['NOT_RUN', 'PENDING', 'PASSED', 'FAILED', 'STALE'].includes(String(row.preflight_status))
        ? row.preflight_status : 'NOT_RUN',
      currencyVerified: verifiedCurrencyMatches,
      ...(currencyVerification ? { currencyVerification: currencyVerification.includes('DEFERRED') ? 'DEFERRED_EMPTY_CATALOG' as const : currencyVerification.includes('FAILED') ? 'FAILED' as const : 'VERIFIED' as const } : {}),
      ...(checkedAt ? { checkedAt } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(dueAt ? { dueAt } : {}),
      ...(row.preflight_error_code ? { errorCode: String(row.preflight_error_code) } : {}),
      ...(row.preflight_error_message ? { errorMessage: String(row.preflight_error_message) } : {})
    },
    network: {
      status: row.network_next_attempt_at && new Date(row.network_next_attempt_at).getTime() > Date.now()
        ? 'WAITING'
        : row.network_last_error_code ? 'ERROR' : 'READY',
      ...(row.network_next_attempt_at ? { nextAttemptAt: iso(row.network_next_attempt_at) } : {}),
      ...(row.network_last_error_code ? { errorCode: String(row.network_last_error_code) } : {}),
      ...(row.network_last_error_message ? { errorMessage: String(row.network_last_error_message) } : {})
    },
    readiness: {
      ready: blockers.length === 0,
      score: Math.round((scoreParts.filter(Boolean).length / scoreParts.length) * 100),
      blockers
    },
    taskLoad: { running: Number(row.active_task_count || 0), queued: Number(row.queued_task_count || 0) },
    configVersion: Number(row.config_version || 1),
    rowVersion: Number(row.row_version || 1),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.archived_at ? { archivedAt: iso(row.archived_at) } : {})
  };
}

function readinessBlockers(row: SqlRow): string[] {
  const blockers: string[] = [];
  if (row.archived_at) blockers.push('店铺已归档');
  const vaultReady = Boolean(row.active_credential_version_id) && row.credential_binding_mode === 'VAULT';
  if (!vaultReady) blockers.push('Client-Id + Api-Key 尚未激活');
  if (row.preflight_status !== 'PASSED') blockers.push('店铺连接检查尚未通过');
  if (!row.preflight_expires_at || new Date(row.preflight_expires_at).getTime() <= Date.now()) blockers.push('店铺连接检查已过期');
  if (!row.seller_id) blockers.push('Seller 身份未确认');
  if (Number(row.duplicate_seller_count || 0)>0) blockers.push('该 Seller 身份已由另一家启用店铺使用');
  const currencyEvidence = jsonObject(jsonObject(row.preflight_report).currencyVerification);
  const currencyVerification = String(currencyEvidence.status || '');
  const configuredCurrency = row.account_currency === 'CNY' ? 'CNY' : 'RUB';
  const observedCurrency = String(currencyEvidence.currency || '');
  if (currencyVerification === 'VERIFIED' && observedCurrency && observedCurrency !== configuredCurrency) {
    blockers.push(`OZON 账户验证币种 ${observedCurrency} 与店铺配置 ${configuredCurrency} 不一致`);
  } else if (currencyVerification !== 'VERIFIED' || observedCurrency !== configuredCurrency) {
    blockers.push('店铺币种证据尚未完成验证');
  }
  if (!row.warehouse_id) blockers.push('默认仓库未配置');
  if (!row.default_preset_id) blockers.push('默认上品预设未配置');
  return blockers;
}

function toPublication(row: SqlRow): OzonStorePublication {
  return {
    id: String(row.id),
    sku: String(row.sku),
    generatedVersionId: String(row.generated_version_id),
    revision: Number(row.revision),
    storeId: String(row.store_id),
    storeAliasSnapshot: String(row.store_alias_snapshot),
    storeDisplayNameSnapshot: String(row.store_display_name_snapshot || row.store_alias_snapshot),
    status: row.status,
    source: row.source,
    credentialBindingMode: normalizeBindingMode(row.credential_binding_mode),
    ...(row.credential_version_id ? { credentialVersionId: String(row.credential_version_id) } : {}),
    storeConfigVersion: Number(row.store_config_version || 1),
    ...(row.preset_id ? { presetId: String(row.preset_id) } : {}),
    ...(Number(row.preset_row_version || 0) > 0 ? { presetRowVersion: Number(row.preset_row_version) } : {}),
    ...(row.preset_definition_hash ? { presetDefinitionHash: String(row.preset_definition_hash) } : {}),
    ...(Object.keys(jsonObject(row.preset_snapshot)).length ? { presetDefinitionSnapshot: jsonObject(row.preset_snapshot) } : {}),
    ...(row.publication_mode ? {
      publicationMode: row.publication_mode === 'COMPATIBLE_UPSERT' ? 'COMPATIBLE_UPSERT' as const : 'CREATE_ONLY' as const
    } : {}),
    ...(row.preparation_job_id ? { preparationJobId: String(row.preparation_job_id) } : {}),
    ...(row.planned_job_id ? { plannedJobId: String(row.planned_job_id) } : {}),
    ...(row.request_id ? { requestId: String(row.request_id) } : {}),
    ...(row.plan_hash ? { planHash: String(row.plan_hash) } : {}),
    ...(['merchroute-ozon-content-v2', 'merchroute-ozon-content-v3', 'LEGACY_UNKNOWN'].includes(String(row.content_policy_version))
      ? { contentPolicyVersion: row.content_policy_version as OzonStorePublication['contentPolicyVersion'] }
      : {}),
    ...(row.material_hash ? { materialHash: String(row.material_hash) } : {}),
    ...(row.material_hash_version === 'ozon-shared-material-v1'
      ? { materialHashVersion: 'ozon-shared-material-v1' as const }
      : {}),
    ...(row.task_id ? { taskId: String(row.task_id) } : {}),
    warehouseId: String(row.warehouse_id || ''),
    warehouseName: String(row.warehouse_name || ''),
    fulfillmentMode: row.fulfillment_mode === 'RFBS' ? 'RFBS' : 'FBS',
    accountCurrency: row.account_currency === 'CNY' ? 'CNY' : 'RUB',
    offerIds: normalizeStringArray(row.offer_ids),
    offerContractHash: String(row.offer_contract_hash || ''),
    materializationHash: String(row.materialization_hash || ''),
    ...(row.package_rel_path ? { packageRelPath: String(row.package_rel_path) } : {}),
    ...(row.package_signature ? { packageSignature: String(row.package_signature) } : {}),
    productIds: normalizeStringArray(row.product_ids),
    ozonSkus: normalizeStringArray(row.ozon_skus),
    productLinks: normalizeStringArray(row.product_links),
    result: jsonObject(row.result_json),
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
    ...(row.error_message ? { errorMessage: String(row.error_message) } : {}),
    rowVersion: Number(row.row_version || 1),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {})
  };
}

function toPublicationTaskSummary(row: SqlRow): OzonPublicationTaskSummary {
  const offerIds = normalizeStringArray(row.offer_ids);
  const { links, legacyUrls, warning } = publicationTaskLinks(row, offerIds);
  const presetId = String(row.preset_id || '').trim();
  const presetName = frozenPublicationPresetName(row);
  const currentMaterialRevision = Number(row.current_material_revision || 0);
  const currentGeneratedVersionId = String(row.current_generated_version_id || '').trim();
  const storeAvailable = Boolean(row.summary_store_enabled) && !row.summary_store_archived_at;
  const remoteStateUnproven = Number(row.summary_unsafe_gateway_count || 0) > 0;
  const hasNewMaterial = currentMaterialRevision > Number(row.revision || 0)
    && Boolean(currentGeneratedVersionId)
    && currentGeneratedVersionId !== String(row.generated_version_id || '');
  const status = String(row.status) as OzonPublicationTaskSummary['status'];
  const publicationMode = row.publication_mode === 'COMPATIBLE_UPSERT'
    ? 'COMPATIBLE_UPSERT' as const
    : row.publication_mode === 'CREATE_ONLY' ? 'CREATE_ONLY' as const : undefined;
  const canRepublish = storeAvailable && !remoteStateUnproven && hasNewMaterial
    && ['SUCCEEDED', 'FAILED', 'NEEDS_ATTENTION'].includes(status);
  const canCompatibleAppend = storeAvailable && !remoteStateUnproven && hasNewMaterial
    && status === 'SUCCEEDED' && publicationMode === 'COMPATIBLE_UPSERT';
  const blockedReason = !storeAvailable
    ? '冻结店铺当前不可用'
    : remoteStateUnproven
      ? '平台写入状态尚未完成安全回读'
      : !hasNewMaterial
        ? '请先保存新的公共素材 revision'
        : ['PLANNED', 'MATERIALIZED', 'QUEUED', 'RUNNING'].includes(status)
          ? '当前店铺任务仍在执行'
          : undefined;
  return {
    publicationId: String(row.id),
    ...(row.summary_job_id ? { jobId: String(row.summary_job_id) } : {}),
    ...(row.summary_task_id ? { taskId: String(row.summary_task_id) } : {}),
    sku: String(row.sku),
    generatedVersionId: String(row.generated_version_id),
    revision: Number(row.revision),
    ...(row.plan_hash ? { planHash: String(row.plan_hash) } : {}),
    storeId: String(row.store_id),
    storeAlias: String(row.store_alias_snapshot),
    storeDisplayName: String(row.store_display_name_snapshot || row.store_alias_snapshot),
    status,
    ...(publicationMode ? { publicationMode } : {}),
    ...(presetId ? {
      presetBinding: {
        presetId,
        ...(presetName ? { presetName } : {}),
        ...(Number(row.preset_row_version || 0) > 0 ? { presetRowVersion: Number(row.preset_row_version) } : {}),
        sourcePresetExists: Boolean(row.source_preset_id)
      }
    } : {}),
    offerIds,
    productLinks: links,
    legacyProductUrls: legacyUrls,
    ...(warning ? { linkWarning: warning } : {}),
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
    ...(row.error_message ? { errorMessage: String(row.error_message) } : {}),
    rowVersion: Number(row.row_version || 1),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(currentMaterialRevision > 0 ? { currentMaterialRevision } : {}),
    ...(currentGeneratedVersionId ? { currentGeneratedVersionId } : {}),
    capabilities: {
      canOpenWorkspace: true,
      canRepublish,
      canCompatibleAppend,
      ...(blockedReason ? { blockedReason } : {})
    }
  };
}

function frozenPublicationPresetName(row: SqlRow): string | undefined {
  const payload = jsonObject(row.summary_job_payload);
  const candidates = [
    payload.presetName,
    jsonObject(jsonObject(payload.materialSnapshot).preset).name,
    jsonObject(jsonObject(jsonObject(payload.product).materialSnapshot).preset).name,
    jsonObject(jsonObject(jsonObject(row.materialized_product_snapshot).materialSnapshot).preset).name
  ];
  return candidates.map((value) => String(value || '').trim()).find(Boolean);
}

function publicationTaskLinks(row: SqlRow, offerIds: string[]): {
  links: OzonProductLink[];
  legacyUrls: string[];
  warning?: string;
} {
  const allowedOffers = new Set(offerIds);
  const candidates = normalizeArray(row.summary_job_product_links).map(jsonObject);
  const accepted = new Map<string, OzonProductLink>();
  const conflicted = new Set<string>();
  let invalid = false;
  for (const candidate of candidates) {
    const offerId = String(candidate.offerId || '').trim();
    const ozonProductId = String(candidate.ozonProductId || '').trim();
    const ozonSku = String(candidate.ozonSku || '').trim();
    const url = strictOzonTaskProductUrl(candidate.url, ozonSku, ozonProductId);
    if (!offerId || !ozonProductId || !url || (allowedOffers.size > 0 && !allowedOffers.has(offerId))) {
      invalid = true;
      continue;
    }
    const link: OzonProductLink = { offerId, ozonProductId, ...(ozonSku ? { ozonSku } : {}), url };
    const previous = accepted.get(offerId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(link)) {
      conflicted.add(offerId);
      accepted.delete(offerId);
      continue;
    }
    if (!conflicted.has(offerId)) accepted.set(offerId, link);
  }
  const structuredUrls = new Set([...accepted.values()].map((link) => link.url));
  const legacyUrls = normalizeStringArray(row.product_links)
    .map((value) => strictOzonTaskProductUrl(value))
    .filter((value): value is string => Boolean(value) && !structuredUrls.has(value!));
  const warning = conflicted.size
    ? `商品链接身份冲突：${[...conflicted].join('、')}`
    : invalid ? '部分商品链接缺少可证明的 Offer、OZON 身份或有效地址' : undefined;
  return { links: [...accepted.values()], legacyUrls: [...new Set(legacyUrls)], ...(warning ? { warning } : {}) };
}

function strictOzonTaskProductUrl(value: unknown, ozonSku?: string, ozonProductId?: string): string | undefined {
  const candidate = String(value || '').trim();
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || !['ozon.ru', 'www.ozon.ru'].includes(parsed.hostname.toLowerCase())
      || !parsed.pathname.startsWith('/product/')) return undefined;
    if (ozonSku) {
      const canonical = ozonProductUrl(ozonSku, candidate);
      if (!canonical || new URL(canonical).href !== parsed.href) return undefined;
    } else if (ozonProductId && !new RegExp(`(?:-|/)${ozonProductId}/?$`).test(parsed.pathname)) {
      return undefined;
    }
    return parsed.href;
  } catch {
    return undefined;
  }
}

function toGeneratedListingSnapshot(snapshot: JsonRecord): JsonRecord {
  return {
    sku: String(snapshot.sku || ''),
    productName: String(snapshot.productName || snapshot.product_name_snapshot || ''),
    managementSource: String(snapshot.managementSource || snapshot.management_source || ''),
    status: String(snapshot.status || ''),
    rowVersion: Number(snapshot.rowVersion || snapshot.row_version || 0),
    revision: Number(snapshot.revision || 0),
    data: jsonObject(snapshot.data),
    ...(snapshot.lastTaskId || snapshot.last_task_id
      ? { lastTaskId: String(snapshot.lastTaskId || snapshot.last_task_id) }
      : {}),
    ...(snapshot.lastErrorCode || snapshot.last_error_code
      ? { lastErrorCode: String(snapshot.lastErrorCode || snapshot.last_error_code) }
      : {}),
    ...(snapshot.lastErrorMessage || snapshot.last_error_message
      ? { lastErrorMessage: String(snapshot.lastErrorMessage || snapshot.last_error_message) }
      : {}),
    createdAt: iso(snapshot.createdAt || snapshot.created_at),
    updatedAt: iso(snapshot.updatedAt || snapshot.updated_at)
  };
}

function toCredential(row: SqlRow): OzonStoreCredentialRecord {
  return {
    id: String(row.id), storeId: String(row.store_id), version: Number(row.version_no), status: row.status,
    ciphertext: String(row.ciphertext), nonce: String(row.nonce), authTag: String(row.auth_tag),
    fingerprint: String(row.fingerprint), keyVersion: Number(row.key_version || 1)
  };
}

function gatewayIdentityFromRow(row: SqlRow): OzonGatewayIdentity {
  const credentialId = String(row.credential_id || row.credential_version_id || '');
  const identity: OzonGatewayIdentity = {
    storeId: String(row.store_id),
    storeAlias: String(row.store_alias),
    ...(row.task_id ? { taskId: String(row.task_id) } : {}),
    ...(row.publication_id ? { publicationId: String(row.publication_id) } : {}),
    ...(credentialId ? { credentialVersionId: credentialId } : {}),
    credentialBindingMode: normalizeBindingMode(row.credential_binding_mode),
    storeConfigVersion: Number(row.store_config_version || 1),
    warehouseId: String(row.warehouse_id || ''),
    ...(row.offer_contract_hash ? { offerContractHash: String(row.offer_contract_hash) } : {}),
    ...(row.materialization_hash ? { materializationHash: String(row.materialization_hash) } : {}),
    offerIds: normalizeStringArray(row.offer_ids),
    productIds: normalizeStringArray([
      ...normalizeArray(row.publication_product_ids),
      ...normalizeArray(row.mapped_product_ids),
      ...(row.ozon_product_id ? [row.ozon_product_id] : [])
    ]),
    ...(row.import_task_id ? { importTaskId: String(row.import_task_id) } : {}),
    storeEnabled: Boolean(row.store_enabled),
    leaseActive: Boolean(row.lease_expires_at && new Date(row.lease_expires_at).getTime() > Date.now())
  };
  if (credentialId) {
    identity.credential = {
      id: credentialId, storeId: String(row.store_id), version: Number(row.version_no), status: row.credential_status,
      ciphertext: String(row.ciphertext), nonce: String(row.nonce), authTag: String(row.auth_tag),
      fingerprint: String(row.fingerprint), keyVersion: Number(row.key_version || 1)
    };
  }
  return identity;
}

function provisionalImportProductIds(
  rows: SqlRow[],
  expected: { taskId: string; publicationId: string; storeId: string }
): string[] {
  const productIds = new Set<string>();
  for (const row of rows) {
    if (String(row.task_id || '') !== expected.taskId
      || String(row.publication_id || '') !== expected.publicationId
      || String(row.store_id || '') !== expected.storeId
      || String(row.operation || '') !== 'importInfo'
      || String(row.delivery_state || '') !== 'RESPONDED'
      || String(row.retry_class || '') !== 'NONE'
      || Number(row.status_code) < 200 || Number(row.status_code) >= 300) continue;
    const jobOfferIds = new Set(normalizeStringArray(row.job_offer_ids));
    const publicationOfferIds = new Set(normalizeStringArray(row.publication_offer_ids));
    const response = jsonObject(row.response_json);
    const result = jsonObject(response.result);
    for (const itemValue of normalizeArray(result.items)) {
      const item = jsonObject(itemValue);
      const offerId = String(item.offer_id || '').trim();
      const productId = String(item.product_id || '').trim();
      const errors = normalizeArray(item.errors);
      if (!offerId || !jobOfferIds.has(offerId) || !publicationOfferIds.has(offerId)
        || String(item.status || '').toLowerCase() !== 'imported'
        || errors.length || !/^\d+$/.test(productId) || BigInt(productId) <= 0n) continue;
      productIds.add(productId);
    }
  }
  return [...productIds];
}

function toRuntimeJob(row: SqlRow): OzonRuntimeClaimJob {
  const payload = jsonObject(row.payload);
  return ozonRuntimeClaimJobSchema.parse({
    id: String(row.id), sku: String(row.sku), state: String(row.state), source: String(row.source),
    taskKind: String(row.task_kind || (row.publication_id ? 'STORE_PUBLICATION' : 'LEGACY')),
    taskId: String(row.task_id || ''),
    storeId: String(row.store_id), storeAlias: String(row.store_alias),
    publicationId: String(row.publication_id || ''),
    ...(row.credential_version_id ? { credentialVersionId: String(row.credential_version_id) } : {}),
    credentialBindingMode: normalizeBindingMode(row.credential_binding_mode),
    storeConfigVersion: Number(row.store_config_version || 1), warehouseId: String(row.warehouse_id || ''),
    offerContractHash: String(row.offer_contract_hash || ''), materializationHash: String(row.materialization_hash || ''),
    ...(payload.contentPolicyVersion ? { contentPolicyVersion: String(payload.contentPolicyVersion) } : {}),
    ...(row.publication_content_policy_version
      ? { publicationContentPolicyVersion: String(row.publication_content_policy_version) }
      : {}),
    ...(payload.materialHash ? { materialHash: String(payload.materialHash) } : {}),
    ...(payload.materialHashVersion ? { materialHashVersion: String(payload.materialHashVersion) } : {}),
    ...(row.publication_material_hash ? { publicationMaterialHash: String(row.publication_material_hash) } : {}),
    ...(row.publication_material_hash_version
      ? { publicationMaterialHashVersion: String(row.publication_material_hash_version) }
      : {}),
    ...(row.publication_plan_hash ? { planHash: String(row.publication_plan_hash) } : {}),
    ...(Number(row.publication_preset_row_version || 0) > 0
      ? { presetRowVersion: Number(row.publication_preset_row_version) }
      : {}),
    ...(row.publication_mode
      ? { publicationMode: normalizePublicationMode(row.publication_mode) }
      : {}),
    revision: Number(row.listing_revision),
    offerIds: normalizeStringArray(row.offer_ids), payload, stageStates: jsonObject(row.stage_states),
    ...(row.import_task_id ? { importTaskId: String(row.import_task_id) } : {}),
    ...(row.ozon_product_id ? { ozonProductId: String(row.ozon_product_id) } : {}),
    ozonProductLinks: normalizeArray(row.product_links).map((entry) => jsonObject(entry)),
    taskFolder: String(row.task_folder || ''), workRelPath: String(row.work_rel_path || ''),
    directoryStage: String(row.directory_stage || ''), directorySignature: String(row.directory_signature || ''),
    rowVersion: Number(row.row_version), leaseOwner: String(row.lease_owner), leaseToken: String(row.lease_token),
    leaseExpiresAt: iso(row.lease_expires_at), retryCount: Number(row.retry_count || 0),
    ...(row.last_error_code ? { lastErrorCode: String(row.last_error_code) } : {}),
    ...(row.last_error_message ? { lastErrorMessage: String(row.last_error_message) } : {}),
    ...(row.next_attempt_at ? { nextAttemptAt: iso(row.next_attempt_at) } : {})
  });
}

function toPublicationJob(row: SqlRow): OzonPublishJob {
  const payload = jsonObject(row.payload);
  const taskKind: OzonPublishJob['taskKind'] = row.task_kind === 'SHARED_PREPARATION'
    ? 'SHARED_PREPARATION'
    : row.task_kind === 'STORE_PUBLICATION' || row.publication_id
      ? 'STORE_PUBLICATION'
      : 'LEGACY';
  const contentPolicyVersion = normalizeStoredContentPolicyVersion(payload.contentPolicyVersion);
  const materialHash = String(payload.materialHash || '').trim();
  return {
    id: String(row.id),
    taskKind,
    sku: String(row.sku),
    offerIds: normalizeStringArray(row.offer_ids),
    storeAlias: requiredStoreAlias(row.store_alias),
    ...(row.store_id ? { storeId: String(row.store_id) } : {}),
    ...(row.publication_id ? { publicationId: String(row.publication_id) } : {}),
    ...(row.credential_version_id ? { credentialVersionId: String(row.credential_version_id) } : {}),
    credentialBindingMode: normalizeBindingMode(row.credential_binding_mode),
    ...(Number(row.store_config_version || 0) > 0 ? { storeConfigVersion: Number(row.store_config_version) } : {}),
    ...(row.warehouse_id !== null && row.warehouse_id !== undefined ? { warehouseId: String(row.warehouse_id) } : {}),
    ...(row.offer_contract_hash ? { offerContractHash: String(row.offer_contract_hash) } : {}),
    ...(row.materialization_hash ? { materializationHash: String(row.materialization_hash) } : {}),
    ...(contentPolicyVersion ? { contentPolicyVersion } : {}),
    ...(materialHash ? { materialHash } : {}),
    ...(payload.materialHashVersion === OZON_SHARED_MATERIAL_HASH_VERSION
      ? { materialHashVersion: OZON_SHARED_MATERIAL_HASH_VERSION }
      : {}),
    ...(payload.planHash ? { planHash: String(payload.planHash) } : {}),
    ...(payload.requestId ? { requestId: String(payload.requestId) } : {}),
    ...(payload.preparationJobId ? { preparationJobId: String(payload.preparationJobId) } : {}),
    ...(Number(row.listing_revision || 0) > 0 ? { revision: Number(row.listing_revision) } : {}),
    state: String(row.state) as OzonPublishJob['state'],
    source: row.source === 'AUTO' ? 'AUTO' : 'MANUAL',
    payload,
    ...(row.task_id ? { taskId: String(row.task_id) } : {}),
    ...(row.import_task_id ? { importTaskId: String(row.import_task_id) } : {}),
    ...(row.ozon_product_id ? { ozonProductId: String(row.ozon_product_id) } : {}),
    ozonProductLinks: normalizeArray(row.product_links).map((entry) => jsonObject(entry)) as OzonPublishJob['ozonProductLinks'],
    ...(row.task_folder ? { taskFolder: String(row.task_folder) } : {}),
    ...(row.work_rel_path ? { workRelPath: String(row.work_rel_path) } : {}),
    ...(row.directory_stage ? { directoryStage: String(row.directory_stage) as OzonPublishJob['directoryStage'] } : {}),
    ...(row.directory_signature ? { directorySignature: String(row.directory_signature) } : {}),
    stageStates: {
      import: 'PENDING', moderation: 'PENDING', images: 'PENDING', video: 'PENDING', price: 'PENDING', stock: 'PENDING',
      ...jsonObject(row.stage_states)
    },
    retryCount: Number(row.retry_count || 0),
    rowVersion: Number(row.row_version),
    ...(row.lease_owner ? { leaseOwner: String(row.lease_owner) } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    ...(row.lease_token ? { leaseToken: String(row.lease_token) } : {}),
    ...(row.last_error_code ? { lastErrorCode: String(row.last_error_code) } : {}),
    ...(row.last_error_message ? { lastErrorMessage: String(row.last_error_message) } : {}),
    ...(row.next_attempt_at ? { nextAttemptAt: iso(row.next_attempt_at) } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.finished_at ? { finishedAt: iso(row.finished_at) } : {})
  };
}

function normalizeStoredContentPolicyVersion(value: unknown): OzonPublishJob['contentPolicyVersion'] {
  if (value === 'merchroute-ozon-content-v2' || value === 'merchroute-ozon-content-v3' || value === 'LEGACY_UNKNOWN') return value;
  return undefined;
}

function normalizeFulfillmentMode(value: unknown): 'FBS' | 'RFBS' {
  if (value === 'FBS' || value === 'RFBS') return value;
  throw new AppError('VERSION_CONFLICT', 'OZON publication 冻结履约模式无效', { value }, 409);
}

function normalizeAccountCurrency(value: unknown): 'RUB' | 'CNY' {
  if (value === 'RUB' || value === 'CNY') return value;
  throw new AppError('VERSION_CONFLICT', 'OZON publication 冻结币种无效', { value }, 409);
}

function normalizePublicationMode(value: unknown): 'CREATE_ONLY' | 'COMPATIBLE_UPSERT' {
  if (value === 'CREATE_ONLY' || value === 'COMPATIBLE_UPSERT') return value;
  throw new AppError('VERSION_CONFLICT', 'OZON publication 冻结发布模式无效', { value }, 409);
}

function publicationStateFromJob(state: string): OzonStorePublication['status'] {
  if (state === 'SUCCEEDED') return 'SUCCEEDED';
  if (state === 'FAILED') return 'FAILED';
  if (state === 'CANCELLED') return 'CANCELLED';
  if (state === 'NEEDS_ATTENTION') return 'NEEDS_ATTENTION';
  if (['WAITING_MEDIA', 'READY'].includes(state)) return 'QUEUED';
  return 'RUNNING';
}

function normalizeBindingMode(value: unknown): OzonCredentialBindingMode {
  return value === 'VAULT' || value === 'LEGACY_PUBLICATION' ? value : 'PURE_LEGACY';
}

function isExactPrePlatformMultistorePreparation(job: SqlRow): boolean {
  const payload = jsonObject(job.payload);
  const networkRecovery = jsonObject(payload.networkRecovery);
  const remoteEvidence = Boolean(
    job.task_id
    || job.import_task_id
    || job.ozon_product_id
    || ['PROCESSING', 'SUCCESS'].includes(String(job.directory_stage || '').trim().toUpperCase())
    || job.lease_owner
    || job.lease_token
    || job.lease_expires_at
    || normalizeArray(job.product_links).length
    || payload.platformWriteAttempted === true
    || payload.importIntent
    || payload.platformStatusRefresh
    || payload.multistoreFanout
    || ['UNKNOWN', 'RESPONDED'].includes(String(networkRecovery.deliveryState || '').trim().toUpperCase())
  );
  return String(job.source || '').trim().toUpperCase() === 'AUTO'
    && payload.multistorePreparation === true
    && String(job.store_id || '') === OZON_DEFAULT_STORE_ID
    && !job.publication_id
    && ['NEEDS_ATTENTION', 'FAILED'].includes(String(job.state || '').trim().toUpperCase())
    && !remoteEvidence;
}

function fleetCapabilityReady(): boolean {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MERCHROUTE_OZON_MULTISTORE_FLEET_READY || '').trim());
}

type RepresentedMediaIdentity = {
  sourceStageId: 'E004' | 'E005';
  submissionId: string;
  variantId: string;
};

type RepresentedMediaAssetEvidence = {
  sourceStageId: string;
  submissionId: string;
  variantId: string;
  assetId: string;
  relativePath: string;
  sha256: string;
  kind: string;
  sortOrder: number;
  offerIds: string[];
};

function assertRepresentedMediaPreparationJob(job: SqlRow): void {
  const payload = jsonObject(job.payload);
  const recovery = jsonObject(payload.networkRecovery);
  const remoteEvidence = Boolean(
    job.task_id || job.publication_id || job.import_task_id || job.ozon_product_id
    || job.task_folder || job.directory_signature || job.lease_owner || job.lease_token
    || Number(job.listing_revision || 0) !== 0
    || String(job.offer_contract_hash || '') || String(job.materialization_hash || '')
    || payload.platformWriteAttempted === true || payload.importIntent || payload.platformStatusRefresh
    || ['UNKNOWN', 'RESPONDED'].includes(String(recovery.deliveryState || '').trim().toUpperCase())
  );
  if (String(job.source) !== 'AUTO' || String(job.state) !== 'NEEDS_ATTENTION'
    || String(job.last_error_code) !== 'OZON_MANUAL_DRAFT_PRESENT'
    || payload.multistorePreparation !== true || remoteEvidence
    || String(job.directory_stage || '') !== 'INBOX') {
    throw new AppError('TASK_LOCKED', 'OZON 任务不是可收口的纯内部 fan-out 准备任务', {
      jobId: job.id, state: job.state, errorCode: job.last_error_code
    }, 409);
  }
}

function representedMediaIdentity(value: JsonRecord): RepresentedMediaIdentity {
  const sourceStageId = String(value.sourceStageId || '').trim();
  const submissionId = String(value.submissionId || '').trim();
  const variantId = String(value.variantId || '').trim();
  if (!['E004', 'E005'].includes(sourceStageId)
    || !submissionId || submissionId.length > 256
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(variantId)) {
    throw new AppError('VERSION_CONFLICT', 'OZON 冻结媒体投递身份无效', {
      sourceStageId, submissionId, variantId
    }, 409);
  }
  return { sourceStageId: sourceStageId as 'E004' | 'E005', submissionId, variantId };
}

function representedMediaIdentityKey(identity: RepresentedMediaIdentity): string {
  return `${identity.sourceStageId}\u0000${identity.submissionId}\u0000${identity.variantId}`;
}

function assertDurablyAcceptedPreparationDelivery(
  payload: JsonRecord,
  identity: RepresentedMediaIdentity,
  jobId: string
): void {
  const selected = normalizeRepresentedSelectedPaths(payload.selectedRelativePaths);
  const acceptedAt = Date.parse(String(payload.autoPublishAcceptedAt || ''));
  if (String(payload.autoPublishDecision || '') !== 'ACCEPTED'
    || String(payload.autoPublishAcceptedByJobId || '') !== jobId
    || !Number.isFinite(acceptedAt)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(String(payload.autoPublishAcceptanceId || ''))
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(String(payload.autoPublishAcceptedPresetId || ''))
    || !/^sha256:[a-f0-9]{64}$/.test(String(payload.autoPublishAcceptedDefinitionHash || ''))
    || !Number.isSafeInteger(Number(payload.autoPublishAcceptedPresetRowVersion))
    || Number(payload.autoPublishAcceptedPresetRowVersion) < 1
    || !Number.isSafeInteger(Number(payload.autoPublishAcceptedSettingsRowVersion))
    || Number(payload.autoPublishAcceptedSettingsRowVersion) < 1
    || !selected.length) {
    throw new AppError('VERSION_CONFLICT', 'OZON 媒体投递缺少持久接受凭证', { delivery: identity }, 409);
  }
}

function normalizeRepresentedSelectedPaths(value: unknown): string[] {
  const result = normalizeArray(value).map((entry) => {
    const normalized = String(entry || '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
    const segments = normalized.split('/');
    if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)
      || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new AppError('VERSION_CONFLICT', 'OZON 冻结媒体相对路径无效', { relativePath: normalized }, 409);
    }
    return normalized;
  });
  if (new Set(result).size !== result.length) {
    throw new AppError('VERSION_CONFLICT', 'OZON 冻结媒体相对路径重复', undefined, 409);
  }
  return result;
}

function proveSnapshotRepresentsDelivery(
  snapshotInput: unknown,
  identity: RepresentedMediaIdentity,
  deliveryPayload: JsonRecord
): { assets: RepresentedMediaAssetEvidence[] } {
  const snapshot = jsonObject(snapshotInput);
  const data = jsonObject(snapshot.data);
  const mediaAssets = normalizeArray(data.mediaAssets).map(jsonObject);
  const offers = normalizeArray(data.offers).map(jsonObject);
  const selectedPaths = normalizeRepresentedSelectedPaths(deliveryPayload.selectedRelativePaths);
  const selectedSet = new Set(selectedPaths);
  const matchedAssets = mediaAssets.flatMap((asset) => {
    if (String(asset.sourceStageId || '') !== identity.sourceStageId
      || String(asset.sourceSubmissionId || '') !== identity.submissionId
      || String(asset.productVariantId || '') !== identity.variantId) return [];
    const relativePath = String(asset.relativePath || '').trim().replaceAll('\\', '/');
    const segments = relativePath.split('/');
    const submissionIndex = segments.lastIndexOf(identity.submissionId);
    const deliveryRelativePath = submissionIndex >= 0 ? segments.slice(submissionIndex + 1).join('/') : '';
    const assetId = String(asset.assetId || '').trim();
    const contentHash = String(asset.sha256 || '').trim();
    const sortOrder = Number(asset.sortOrder);
    if (!selectedSet.has(deliveryRelativePath) || !assetId || !/^[a-f0-9]{64}$/.test(contentHash)
      || String(asset.validationStatus || '') !== 'VALID'
      || !Number.isSafeInteger(sortOrder) || sortOrder < 0) {
      throw new AppError('VERSION_CONFLICT', 'OZON immutable snapshot 媒体资产与冻结投递不一致', {
        delivery: identity, relativePath
      }, 409);
    }
    return [{ asset, assetId, relativePath, deliveryRelativePath, contentHash, sortOrder }];
  });
  const actualSelected = matchedAssets.map((entry) => entry.deliveryRelativePath).sort();
  if (matchedAssets.length !== selectedPaths.length
    || stableJson(actualSelected) !== stableJson([...selectedPaths].sort())
    || new Set(matchedAssets.map((entry) => entry.assetId)).size !== matchedAssets.length) {
    throw new AppError('VERSION_CONFLICT', 'OZON immutable snapshot 未完整覆盖冻结媒体投递', {
      delivery: identity, expectedCount: selectedPaths.length, actualCount: matchedAssets.length
    }, 409);
  }
  const offerEvidence = offers.flatMap((offer) => {
    if (String(offer.productVariantId || offer.variantId || '') !== identity.variantId) return [];
    const offerId = String(offer.offerId || '').trim();
    const media = normalizeArray(offer.media).map(jsonObject);
    if (!offerId) return [];
    const representedAssetIds = matchedAssets.flatMap((asset) => {
      const exact = media.filter((entry) => String(entry.assetId || '') === asset.assetId
        && String(entry.relativePath || '').replaceAll('\\', '/') === asset.relativePath
        && String(entry.kind || '') === String(asset.asset.kind || ''));
      return exact.length === 1 ? [asset.assetId] : [];
    });
    return representedAssetIds.length === matchedAssets.length ? [{ offerId, representedAssetIds }] : [];
  });
  if (!offerEvidence.length) {
    throw new AppError('VERSION_CONFLICT', 'OZON immutable snapshot 中媒体资产未被同变体 offer.media 实际引用', {
      delivery: identity
    }, 409);
  }
  return {
    assets: matchedAssets.map((entry) => ({
      sourceStageId: identity.sourceStageId,
      submissionId: identity.submissionId,
      variantId: identity.variantId,
      assetId: entry.assetId,
      relativePath: entry.relativePath,
      sha256: entry.contentHash,
      kind: String(entry.asset.kind || ''),
      sortOrder: entry.sortOrder,
      offerIds: offerEvidence.map((offer) => offer.offerId).sort()
    })).sort((left, right) => left.sortOrder - right.sortOrder || left.assetId.localeCompare(right.assetId))
  };
}

function representedMediaReconciliationResult(
  status: OzonRepresentedMediaFanoutReconciliationResult['status'],
  dryRun: boolean,
  job: SqlRow,
  candidate: {
    anchor: SqlRow;
    anchorJob: SqlRow;
    generatedVersionId: string;
    version: SqlRow;
    publicationIds: string[];
    storeIds: string[];
  },
  evidence: { deliveryIdentities: RepresentedMediaIdentity[] },
  evidenceHash: string,
  rowVersionBefore = Number(job.row_version)
): OzonRepresentedMediaFanoutReconciliationResult {
  return {
    status,
    dryRun,
    jobId: String(job.id),
    sku: String(job.sku),
    rowVersionBefore,
    rowVersionAfter: Number(job.row_version),
    generatedVersionId: candidate.generatedVersionId,
    revision: Number(candidate.version.revision),
    anchorJobId: String(candidate.anchorJob.id),
    anchorDelivery: representedMediaIdentity(jsonObject(candidate.anchor.payload)),
    deliveryIdentities: evidence.deliveryIdentities,
    publicationIds: candidate.publicationIds,
    storeIds: candidate.storeIds,
    evidenceHash
  };
}

function assertRowVersion(expected: number, actual: unknown, label: string): void {
  if (Number(actual) !== expected) throw new AppError('VERSION_CONFLICT', `${label}已被其他操作修改`, {
    expected, actual: Number(actual)
  }, 409);
}

function normalizeSku(value: unknown): string {
  const sku = String(value || '').trim();
  if (!/^\d{7}$/.test(sku)) throw new AppError('CONFIG_INVALID', 'SKU 必须是 7 位数字字符串');
  return sku;
}

function jsonObject(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

async function assertOzonSourceMediaVersionAvailable(client: PoolClient, generatedVersionId: string): Promise<void> {
  const available = await client.query<{ available: boolean }>(
    "SELECT to_regclass('ozon_source_media_cleanup_batches') IS NOT NULL available"
  );
  if (!available.rows[0]?.available) return;
  const cleanup = await client.query<SqlRow>(`SELECT id,state FROM ozon_source_media_cleanup_batches
    WHERE generated_version_id=$1 AND state IN ('QUARANTINING','QUARANTINED','CLEANED')`, [generatedVersionId]);
  if (cleanup.rows[0]) {
    throw new AppError('OZON_SOURCE_MEDIA_CLEANED', '该 OZON 稳定版本的公共媒体已清理，请重新投递媒体并生成下一真实 revision', {
      generatedVersionId,
      cleanupId: String(cleanup.rows[0].id),
      cleanupState: String(cleanup.rows[0].state)
    }, 410);
  }
}

function normalizeArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function normalizeStringArray(value: unknown): string[] {
  return [...new Set(normalizeArray(value).map((entry) => String(entry || '').trim()).filter(Boolean))];
}

type ImportedPriceFloorFailure = {
  offerId: string;
  productId: string;
  codes: string[];
  errors: unknown[];
};

type ImportedNoBrandFailure = {
  offerId: string;
  productId: string;
  errors: unknown[];
};

function requiredStoreAlias(value: unknown): string {
  const alias = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(alias)) {
    throw new AppError('VERSION_CONFLICT', 'OZON 任务缺少有效的冻结店铺别名', { storeAlias: alias }, 409);
  }
  return alias;
}

function parseImportedPriceFloorFailures(value: unknown, expectedOfferIds: string[]): ImportedPriceFloorFailure[] {
  let parsed: unknown;
  try { parsed = JSON.parse(String(value || '')); } catch {
    throw new AppError('VERSION_CONFLICT', '价格下限恢复的导入错误不是有效 JSON', undefined, 409);
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedOfferIds.length) {
    throw new AppError('VERSION_CONFLICT', '价格下限恢复的导入错误未完整覆盖冻结 Offer', undefined, 409);
  }
  const allowedCodes = new Set(['price_less_than_min_auto_price', 'min_auto_price_too_big']);
  const failures = parsed.map((entry): ImportedPriceFloorFailure => {
    const row = jsonObject(entry);
    const offerId = String(row.offer_id || row.offerId || '').trim();
    const productId = String(row.product_id || row.productId || row.id || '').trim();
    const errors = normalizeArray(row.errors);
    const codes = normalizeStringArray(errors.map((issue) => jsonObject(issue).code));
    const valid = expectedOfferIds.includes(offerId)
      && /^\d+$/.test(productId)
      && String(row.status || row.state || '').trim().toLowerCase() === 'imported'
      && errors.length === 2 && codes.length === 2
      && [...allowedCodes].every((code) => codes.includes(code))
      && errors.every((issue) => {
        const error = jsonObject(issue);
        return allowedCodes.has(String(error.code || '').trim())
          && String(error.field || '').trim() === 'price'
          && String(error.level || '').trim().toLowerCase() === 'error';
      });
    if (!valid) {
      throw new AppError('VERSION_CONFLICT', '导入错误不只包含已知价格/最低价相互约束，拒绝自动恢复', {
        offerId,
        codes
      }, 409);
    }
    return { offerId, productId, codes, errors };
  });
  if (new Set(failures.map((entry) => entry.offerId)).size !== expectedOfferIds.length
    || expectedOfferIds.some((offerId) => !failures.some((entry) => entry.offerId === offerId))) {
    throw new AppError('VERSION_CONFLICT', '价格下限恢复的导入错误 Offer 集合重复或漂移', undefined, 409);
  }
  return failures;
}

export function parseImportedNoBrandFailures(value: unknown, expectedOfferIds: string[]): ImportedNoBrandFailure[] {
  let parsed: unknown;
  try { parsed = JSON.parse(String(value || '')); } catch {
    throw new AppError('VERSION_CONFLICT', '无品牌恢复的导入错误不是有效 JSON', undefined, 409);
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedOfferIds.length) {
    throw new AppError('VERSION_CONFLICT', '无品牌恢复的导入错误未完整覆盖冻结 Offer', undefined, 409);
  }
  const failures = parsed.map((entry): ImportedNoBrandFailure => {
    const row = jsonObject(entry);
    const offerId = String(row.offer_id || row.offerId || '').trim();
    const productId = String(row.product_id || row.productId || row.id || '').trim();
    const errors = normalizeArray(row.errors);
    const valid = expectedOfferIds.includes(offerId)
      && /^\d+$/.test(productId)
      && String(row.status || row.state || '').trim().toLowerCase() === 'imported'
      && errors.length === 1
      && errors.every((issue) => {
        const error = jsonObject(issue);
        return String(error.code || '').trim() === 'error_attribute_values_out_of_range'
          && Number(error.attribute_id ?? error.attributeId) === 85
          && String(error.level || '').trim().toLowerCase() === 'error';
      });
    if (!valid) {
      throw new AppError('VERSION_CONFLICT', '导入错误不只包含属性 85 的无品牌字典值拒绝，禁止自动纠正', {
        offerId,
        codes: errors.map((issue) => String(jsonObject(issue).code || ''))
      }, 409);
    }
    return { offerId, productId, errors };
  });
  if (new Set(failures.map((entry) => entry.offerId)).size !== expectedOfferIds.length
    || expectedOfferIds.some((offerId) => !failures.some((entry) => entry.offerId === offerId))) {
    throw new AppError('VERSION_CONFLICT', '无品牌恢复的导入错误 Offer 集合重复或漂移', undefined, 409);
  }
  return failures;
}

function importNoBrandRecoveryChecks(
  job: SqlRow,
  publication: SqlRow,
  gatewayRows: SqlRow[],
  failures: ImportedNoBrandFailure[]
): OzonImportNoBrandRecoveryResult['checks'] {
  const count = (operation: string) => gatewayRows
    .filter((entry) => String(entry.operation) === operation)
    .reduce((sum, entry) => sum + Number(entry.count || 0), 0);
  const marker = jsonObject(jsonObject(job.payload).importNoBrandRecovery);
  return {
    storeId: String(job.store_id || publication.store_id || ''),
    storeAlias: String(job.store_alias || publication.store_alias_snapshot || ''),
    sku: String(job.sku || publication.sku || ''),
    revision: Number(job.listing_revision || publication.revision || 0),
    taskId: String(job.task_id || ''),
    importTaskId: String(job.import_task_id || marker.previousImportTaskId || ''),
    offerIds: normalizeStringArray(job.offer_ids || publication.offer_ids),
    productIds: failures.length ? failures.map((entry) => entry.productId) : normalizeStringArray(marker.productIds),
    workRelPath: String(job.work_rel_path || ''),
    directorySignature: String(job.directory_signature || ''),
    importProductCount: count('importProduct'),
    importInfoCount: count('importInfo'),
    pricesWriteCount: count('pricesWrite'),
    stocksWriteCount: count('stocksWrite')
  };
}

function importPriceFloorRecoveryChecks(
  job: SqlRow,
  publication: SqlRow,
  gatewayRows: SqlRow[],
  failures: ImportedPriceFloorFailure[]
): OzonImportPriceFloorRecoveryResult['checks'] {
  const count = (operation: string) => gatewayRows
    .filter((entry) => String(entry.operation) === operation)
    .reduce((sum, entry) => sum + Number(entry.count || 0), 0);
  const marker = jsonObject(jsonObject(job.payload).importPriceFloorRecovery);
  return {
    storeId: String(job.store_id || publication.store_id || ''),
    storeAlias: String(job.store_alias || publication.store_alias_snapshot || ''),
    sku: String(job.sku || publication.sku || ''),
    revision: Number(job.listing_revision || publication.revision || 0),
    taskId: String(job.task_id || ''),
    importTaskId: String(job.import_task_id || marker.importTaskId || ''),
    offerIds: normalizeStringArray(job.offer_ids || publication.offer_ids),
    productIds: failures.length
      ? failures.map((entry) => entry.productId)
      : normalizeStringArray(marker.productIds),
    workRelPath: String(job.work_rel_path || ''),
    directorySignature: String(job.directory_signature || ''),
    importProductCount: count('importProduct'),
    importInfoCount: count('importInfo'),
    pricesWriteCount: count('pricesWrite'),
    stocksWriteCount: count('stocksWrite')
  };
}

function deriveMaterialOverrides(data: JsonRecord, basePreset: JsonRecord): JsonRecord {
  if (!Object.keys(basePreset).length) {
    return { migrationEvidence: 'UNPROVEN_BASE_PRESET' };
  }
  const overrides: JsonRecord = {};
  for (const key of ['vat', 'dimensions', 'sharedAttributes', 'videoUploadMode', 'purchaseMeasurements'] as const) {
    if (data[key] !== undefined && stableJson(data[key]) !== stableJson(basePreset[key])) overrides[key] = data[key];
  }
  const defaultStock = Number(basePreset.defaultStock);
  const variantAttributes = normalizeArray(basePreset.variantAttributes);
  const offerOverrides = normalizeArray(data.offers).map((entry) => jsonObject(entry)).flatMap((offer) => {
    const override: JsonRecord = { offerId: String(offer.offerId || '') };
    if (Number.isFinite(Number(offer.stock)) && Number(offer.stock) !== defaultStock) override.stock = Number(offer.stock);
    if (stableJson(normalizeArray(offer.attributes)) !== stableJson(variantAttributes)) override.attributes = normalizeArray(offer.attributes);
    return override.offerId && Object.keys(override).length > 1 ? [override] : [];
  });
  if (offerOverrides.length) overrides.offerOverrides = offerOverrides;
  return overrides;
}
function iso(value: unknown): string { return new Date(value as any).toISOString(); }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as JsonRecord;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex')}`;
}

function redactCredentialLikeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactCredentialLikeKeys);
  if (!value || typeof value !== 'object') return value;
  const result: JsonRecord = {};
  for (const [key, item] of Object.entries(value as JsonRecord)) {
    if (/^(?:authorization|headers?|client[-_]?id|api[-_]?key|credential|secret|token)$/i.test(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redactCredentialLikeKeys(item);
    }
  }
  return result;
}

function stableSourceOffers(value: unknown): unknown[] {
  return normalizeArray(value).map((entry) => {
    const sourceOnly = { ...jsonObject(entry) };
    delete sourceOnly.price;
    delete sourceOnly.oldPrice;
    delete sourceOnly.minPrice;
    delete sourceOnly.stock;
    delete sourceOnly.warehouseId;
    delete sourceOnly.currency;
    return sourceOnly;
  });
}

export async function migrateOzonMultiStoreSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('merchroute-ozon-multistore-schema-v1'))");
    await client.query(`CREATE TABLE IF NOT EXISTS ozon_schema_migrations(
      id TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const applied = await client.query("SELECT 1 FROM ozon_schema_migrations WHERE id='013_ozon_multistore_vault'");
    if (applied.rows[0]) {
      await migrateOzonMultiStoreHardening(client);
      await migrateOzonStoreOwnedPresetOwnership(client);
      await migrateOzonSharedMaterialAndPreparationAttempts(client);
      await client.query('COMMIT');
      return;
    }

    await client.query(`ALTER TABLE ozon_system_settings
      ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      ADD COLUMN IF NOT EXISTS global_concurrency INTEGER NOT NULL DEFAULT 2 CHECK(global_concurrency BETWEEN 1 AND 2),
      ADD COLUMN IF NOT EXISTS per_store_concurrency INTEGER NOT NULL DEFAULT 1 CHECK(per_store_concurrency=1),
      ADD COLUMN IF NOT EXISTS preflight_ttl_hours INTEGER NOT NULL DEFAULT 24 CHECK(preflight_ttl_hours=24),
      ADD COLUMN IF NOT EXISTS preflight_due_hours INTEGER NOT NULL DEFAULT 18 CHECK(preflight_due_hours=18),
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

    await client.query(`CREATE TABLE IF NOT EXISTS ozon_stores(
      id UUID PRIMARY KEY,
      store_alias TEXT NOT NULL UNIQUE CHECK(
        store_alias ~ '^[a-z0-9][a-z0-9-]{1,31}$'
        AND lower(store_alias) !~ '^(con|prn|aux|nul|com[1-9]|lpt[1-9])$'
      ),
      display_name TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT false,
      auto_publish_enabled BOOLEAN NOT NULL DEFAULT false,
      auto_publish_activated_at TIMESTAMPTZ,
      auto_publish_mode TEXT NOT NULL DEFAULT 'CREATE_ONLY' CHECK(auto_publish_mode IN ('CREATE_ONLY','COMPATIBLE_UPSERT')),
      default_preset_id UUID REFERENCES ozon_listing_presets(id) ON DELETE RESTRICT,
      active_credential_version_id UUID,
      credential_state TEXT NOT NULL DEFAULT 'MISSING' CHECK(credential_state IN ('MISSING','LEGACY_EXTERNAL','PENDING','ACTIVE')),
      credential_binding_mode TEXT NOT NULL DEFAULT 'VAULT' CHECK(credential_binding_mode IN ('VAULT','LEGACY_PUBLICATION','PURE_LEGACY')),
      seller_id TEXT NOT NULL DEFAULT '',seller_name TEXT NOT NULL DEFAULT '',
      permissions JSONB NOT NULL DEFAULT '[]'::jsonb,limits JSONB NOT NULL DEFAULT '{}'::jsonb,
      warehouses JSONB NOT NULL DEFAULT '[]'::jsonb,
      warehouse_id TEXT NOT NULL DEFAULT '',warehouse_name TEXT NOT NULL DEFAULT '',
      fulfillment_mode TEXT NOT NULL DEFAULT 'FBS' CHECK(fulfillment_mode IN ('FBS','RFBS')),
      account_currency TEXT NOT NULL DEFAULT 'RUB' CHECK(account_currency IN ('RUB','CNY')),
      max_daily_styles INTEGER NOT NULL DEFAULT 100 CHECK(max_daily_styles>0),
      preflight_status TEXT NOT NULL DEFAULT 'NOT_RUN' CHECK(preflight_status IN ('NOT_RUN','PENDING','PASSED','FAILED','STALE')),
      preflight_checked_at TIMESTAMPTZ,preflight_due_at TIMESTAMPTZ,preflight_expires_at TIMESTAMPTZ,
      preflight_report JSONB NOT NULL DEFAULT '{}'::jsonb,
      preflight_error_code TEXT NOT NULL DEFAULT '',preflight_error_message TEXT NOT NULL DEFAULT '',
      config_version INTEGER NOT NULL DEFAULT 1 CHECK(config_version>0),row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
      archived_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query('DROP INDEX IF EXISTS ozon_stores_active_seller_unique');
    await client.query(`CREATE UNIQUE INDEX ozon_stores_active_seller_unique ON ozon_stores(seller_id)
      WHERE enabled=true AND archived_at IS NULL AND seller_id<>''`);

    await client.query(`CREATE TABLE IF NOT EXISTS ozon_store_credential_versions(
      id UUID PRIMARY KEY,store_id UUID NOT NULL REFERENCES ozon_stores(id) ON DELETE RESTRICT,
      version_no INTEGER NOT NULL CHECK(version_no>0),status TEXT NOT NULL CHECK(status IN ('PENDING','ACTIVE','RETIRED')),
      ciphertext TEXT NOT NULL,nonce TEXT NOT NULL,auth_tag TEXT NOT NULL,fingerprint TEXT NOT NULL,
      key_version INTEGER NOT NULL DEFAULT 1 CHECK(key_version>0),validation_report JSONB NOT NULL DEFAULT '{}'::jsonb,
      validation_error_code TEXT NOT NULL DEFAULT '',validation_error_message TEXT NOT NULL DEFAULT '',
      validated_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      activated_at TIMESTAMPTZ,retired_at TIMESTAMPTZ,UNIQUE(store_id,version_no)
    )`);
    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS ozon_store_one_active_credential ON ozon_store_credential_versions(store_id) WHERE status='ACTIVE'");
    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS ozon_store_one_pending_credential ON ozon_store_credential_versions(store_id) WHERE status='PENDING'");
    await client.query(`CREATE TABLE IF NOT EXISTS ozon_store_preflight_runs(
      id UUID PRIMARY KEY,store_id UUID NOT NULL REFERENCES ozon_stores(id) ON DELETE RESTRICT,
      store_config_version INTEGER NOT NULL CHECK(store_config_version>0),
      credential_version_id UUID NOT NULL REFERENCES ozon_store_credential_versions(id) ON DELETE RESTRICT,
      result TEXT NOT NULL CHECK(result IN ('PASSED','FAILED','REJECTED_DUPLICATE_SELLER')),
      report JSONB NOT NULL DEFAULT '{}'::jsonb,observed_at TIMESTAMPTZ NOT NULL,
      error_code TEXT NOT NULL DEFAULT '',error_message TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS ozon_store_preflight_runs_store_time
      ON ozon_store_preflight_runs(store_id,created_at DESC)`);
    await client.query(`CREATE OR REPLACE FUNCTION ozon_reject_preflight_run_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $immutable$
      BEGIN
        RAISE EXCEPTION 'ozon_store_preflight_runs is append-only' USING ERRCODE='55000';
      END $immutable$`);
    await client.query('DROP TRIGGER IF EXISTS ozon_store_preflight_runs_immutable ON ozon_store_preflight_runs');
    await client.query(`CREATE TRIGGER ozon_store_preflight_runs_immutable
      BEFORE UPDATE OR DELETE ON ozon_store_preflight_runs
      FOR EACH ROW EXECUTE FUNCTION ozon_reject_preflight_run_mutation()`);
    await client.query(`DO $migration$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ozon_stores_active_credential_fk'
        AND conrelid='ozon_stores'::regclass) THEN
        ALTER TABLE ozon_stores ADD CONSTRAINT ozon_stores_active_credential_fk
          FOREIGN KEY(active_credential_version_id) REFERENCES ozon_store_credential_versions(id) ON DELETE RESTRICT;
      END IF;
    END $migration$`);

    await client.query(`CREATE TABLE IF NOT EXISTS ozon_store_runtime_state(
      store_id UUID PRIMARY KEY REFERENCES ozon_stores(id) ON DELETE CASCADE,
      network_attempt INTEGER NOT NULL DEFAULT 0 CHECK(network_attempt>=0),network_next_attempt_at TIMESTAMPTZ,
      network_last_error_code TEXT NOT NULL DEFAULT '',network_last_error_message TEXT NOT NULL DEFAULT '',
      network_updated_at TIMESTAMPTZ,last_dispatched_at TIMESTAMPTZ,
      preflight_credential_version_id UUID REFERENCES ozon_store_credential_versions(id) ON DELETE RESTRICT,
      preflight_store_config_version INTEGER,preflight_lock_expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query(`ALTER TABLE ozon_store_runtime_state
      ADD COLUMN IF NOT EXISTS preflight_credential_version_id UUID REFERENCES ozon_store_credential_versions(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS preflight_store_config_version INTEGER,
      ADD COLUMN IF NOT EXISTS preflight_lock_expires_at TIMESTAMPTZ`);

    const settings = (await client.query<SqlRow>("SELECT * FROM ozon_system_settings WHERE id='default' FOR UPDATE")).rows[0] || {};
    const preset = (await client.query<SqlRow>(`SELECT * FROM ozon_listing_presets
      ORDER BY is_default DESC,updated_at DESC LIMIT 1`)).rows[0];
    const presetDefinition = jsonObject(preset?.definition);
    const defaultWarehouseId = String(presetDefinition.warehouseId || '');
    const defaultFulfillment = presetDefinition.fulfillmentMode === 'RFBS' ? 'RFBS' : 'FBS';
    const defaultCurrency = presetDefinition.currency === 'CNY' || settings.account_currency === 'CNY' ? 'CNY' : 'RUB';
    const defaultAutoEnabled = presetDefinition.autoPublishEnabled === true;
    const defaultAutoMode = presetDefinition.autoPublishMode === 'COMPATIBLE_UPSERT' ? 'COMPATIBLE_UPSERT' : 'CREATE_ONLY';
    await client.query(`INSERT INTO ozon_stores(
      id,store_alias,display_name,enabled,auto_publish_enabled,auto_publish_activated_at,auto_publish_mode,
      default_preset_id,credential_state,credential_binding_mode,seller_id,seller_name,warehouse_id,
      fulfillment_mode,account_currency,preflight_status,preflight_checked_at,preflight_report
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'LEGACY_PUBLICATION',$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
    ON CONFLICT(id) DO NOTHING`, [
      OZON_DEFAULT_STORE_ID, OZON_DEFAULT_STORE_ALIAS, '现有 OZON 店铺', Boolean(settings.enabled), defaultAutoEnabled,
      defaultAutoEnabled ? preset?.auto_publish_activated_at || new Date() : null, defaultAutoMode, preset?.id || null,
      settings.credential_ready ? 'LEGACY_EXTERNAL' : 'MISSING', settings.seller_id || '', settings.seller_name || '',
      defaultWarehouseId, defaultFulfillment, defaultCurrency, settings.credential_ready ? 'STALE' : 'NOT_RUN',
      settings.last_preflight_at || null, JSON.stringify({ migratedFrom: 'ozon_system_settings', status: settings.last_preflight_status || 'NOT_RUN' })
    ]);
    await client.query('INSERT INTO ozon_store_runtime_state(store_id) VALUES($1) ON CONFLICT(store_id) DO NOTHING', [OZON_DEFAULT_STORE_ID]);

    await client.query(`CREATE TABLE IF NOT EXISTS ozon_store_publications(
      id UUID PRIMARY KEY,sku TEXT NOT NULL,generated_version_id UUID NOT NULL REFERENCES ozon_listing_versions(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK(revision>0),store_id UUID NOT NULL REFERENCES ozon_stores(id) ON DELETE RESTRICT,
      store_alias_snapshot TEXT NOT NULL,store_display_name_snapshot TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('PLANNED','MATERIALIZED','QUEUED','RUNNING','SUCCEEDED','FAILED','NEEDS_ATTENTION','PAUSED','CANCELLED')),
      source TEXT NOT NULL CHECK(source IN ('MANUAL','AUTOMATION')),
      credential_binding_mode TEXT NOT NULL CHECK(credential_binding_mode IN ('VAULT','LEGACY_PUBLICATION','PURE_LEGACY')),
      credential_version_id UUID REFERENCES ozon_store_credential_versions(id) ON DELETE RESTRICT,
      store_config_version INTEGER NOT NULL CHECK(store_config_version>0),preset_id UUID REFERENCES ozon_listing_presets(id) ON DELETE RESTRICT,
      preset_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,preset_definition_hash TEXT NOT NULL DEFAULT '',task_id TEXT,
      warehouse_id TEXT NOT NULL DEFAULT '',warehouse_name TEXT NOT NULL DEFAULT '',fulfillment_mode TEXT NOT NULL DEFAULT 'FBS' CHECK(fulfillment_mode IN ('FBS','RFBS')),
      account_currency TEXT NOT NULL DEFAULT 'RUB' CHECK(account_currency IN ('RUB','CNY')),
      offer_ids JSONB NOT NULL DEFAULT '[]'::jsonb,offer_contract_hash TEXT NOT NULL,materialization_hash TEXT NOT NULL,
      materialized_product_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      package_rel_path TEXT,package_signature TEXT,product_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      ozon_skus JSONB NOT NULL DEFAULT '[]'::jsonb,product_links JSONB NOT NULL DEFAULT '[]'::jsonb,
      result_json JSONB NOT NULL DEFAULT '{}'::jsonb,error_code TEXT NOT NULL DEFAULT '',error_message TEXT NOT NULL DEFAULT '',
      row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ,
      CHECK(credential_binding_mode<>'VAULT' OR credential_version_id IS NOT NULL),
      UNIQUE(store_id,generated_version_id)
    )`);
    await client.query('CREATE INDEX IF NOT EXISTS ozon_store_publications_sku_updated ON ozon_store_publications(sku,updated_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS ozon_store_publications_store_status ON ozon_store_publications(store_id,status,updated_at DESC)');
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS ozon_store_publications_task_unique ON ozon_store_publications(task_id) WHERE task_id IS NOT NULL');

    await client.query(`CREATE TABLE IF NOT EXISTS ozon_gateway_requests(
      request_ref TEXT PRIMARY KEY,request_hash TEXT NOT NULL,task_id TEXT,
      publication_id UUID REFERENCES ozon_store_publications(id) ON DELETE SET NULL,
      store_id UUID NOT NULL REFERENCES ozon_stores(id) ON DELETE RESTRICT,
      credential_version_id UUID NOT NULL REFERENCES ozon_store_credential_versions(id) ON DELETE RESTRICT,
      operation TEXT NOT NULL,delivery_state TEXT NOT NULL CHECK(delivery_state IN ('NOT_SENT','UNKNOWN','RESPONDED')),
      retry_class TEXT NOT NULL CHECK(retry_class IN ('NONE','READBACK_REQUIRED','RETRYABLE','PERMANENT')),
      retry_after_ms INTEGER,status_code INTEGER,response_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ
    )`);

    await client.query(`ALTER TABLE ozon_publish_jobs
      ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES ozon_stores(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS publication_id UUID REFERENCES ozon_store_publications(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS credential_version_id UUID REFERENCES ozon_store_credential_versions(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS credential_binding_mode TEXT NOT NULL DEFAULT 'PURE_LEGACY',
      ADD COLUMN IF NOT EXISTS store_config_version INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS warehouse_id TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS offer_contract_hash TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS materialization_hash TEXT NOT NULL DEFAULT ''`);
    await client.query('UPDATE ozon_publish_jobs SET store_id=$1 WHERE store_id IS NULL', [OZON_DEFAULT_STORE_ID]);
    await client.query(`ALTER TABLE ozon_publish_jobs ALTER COLUMN store_id SET DEFAULT '${OZON_DEFAULT_STORE_ID}'::uuid`);
    await client.query('ALTER TABLE ozon_publish_jobs ALTER COLUMN store_id SET NOT NULL');

    await client.query(`ALTER TABLE ozon_publish_events
      ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES ozon_stores(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS publication_id UUID REFERENCES ozon_store_publications(id) ON DELETE SET NULL`);
    await client.query(`UPDATE ozon_publish_events e SET store_id=j.store_id
      FROM ozon_publish_jobs j WHERE e.job_id=j.id AND e.store_id IS NULL`);
    await client.query('UPDATE ozon_publish_events SET store_id=$1 WHERE store_id IS NULL', [OZON_DEFAULT_STORE_ID]);
    await client.query(`ALTER TABLE ozon_publish_events ALTER COLUMN store_id SET DEFAULT '${OZON_DEFAULT_STORE_ID}'::uuid`);
    await client.query('ALTER TABLE ozon_publish_events ALTER COLUMN store_id SET NOT NULL');

    await client.query('ALTER TABLE ozon_product_mappings ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES ozon_stores(id) ON DELETE RESTRICT');
    await client.query('UPDATE ozon_product_mappings SET store_id=$1 WHERE store_id IS NULL', [OZON_DEFAULT_STORE_ID]);
    await client.query(`ALTER TABLE ozon_product_mappings ALTER COLUMN store_id SET DEFAULT '${OZON_DEFAULT_STORE_ID}'::uuid`);
    await client.query('ALTER TABLE ozon_product_mappings ALTER COLUMN store_id SET NOT NULL');
    await client.query('ALTER TABLE ozon_product_mappings DROP CONSTRAINT IF EXISTS ozon_product_mappings_pkey');
    await client.query('ALTER TABLE ozon_product_mappings ADD CONSTRAINT ozon_product_mappings_pkey PRIMARY KEY(store_id,offer_id)');
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ozon_product_mappings_legacy_alias_offer
      ON ozon_product_mappings(store_alias,offer_id)`);
    await client.query('CREATE INDEX IF NOT EXISTS ozon_product_mappings_store_sku ON ozon_product_mappings(store_id,sku)');

    await client.query('ALTER TABLE ozon_platform_status_refresh_leases ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES ozon_stores(id) ON DELETE RESTRICT');
    await client.query(`UPDATE ozon_platform_status_refresh_leases lease SET store_id=COALESCE(job.store_id,$1::uuid)
      FROM ozon_publish_jobs job WHERE lease.job_id=job.id AND lease.store_id IS NULL`, [OZON_DEFAULT_STORE_ID]);
    await client.query('UPDATE ozon_platform_status_refresh_leases SET store_id=$1 WHERE store_id IS NULL', [OZON_DEFAULT_STORE_ID]);
    await client.query(`ALTER TABLE ozon_platform_status_refresh_leases ALTER COLUMN store_id SET DEFAULT '${OZON_DEFAULT_STORE_ID}'::uuid`);
    await client.query('ALTER TABLE ozon_platform_status_refresh_leases ALTER COLUMN store_id SET NOT NULL');
    await client.query('ALTER TABLE ozon_platform_status_refresh_leases DROP CONSTRAINT IF EXISTS ozon_platform_status_refresh_leases_pkey');
    await client.query(`ALTER TABLE ozon_platform_status_refresh_leases
      ADD CONSTRAINT ozon_platform_status_refresh_leases_pkey PRIMARY KEY(store_id,sku)`);

    await client.query(`CREATE TABLE IF NOT EXISTS ozon_store_media_consumptions(
      store_id UUID NOT NULL REFERENCES ozon_stores(id) ON DELETE RESTRICT,sku TEXT NOT NULL,
      source_stage_id TEXT NOT NULL,submission_id TEXT NOT NULL,variant_id TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL,publication_id UUID REFERENCES ozon_store_publications(id) ON DELETE SET NULL,
      job_id UUID REFERENCES ozon_publish_jobs(id) ON DELETE SET NULL,reason TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(store_id,sku,source_stage_id,submission_id,variant_id)
    )`);

    await client.query(`ALTER TABLE ozon_listing_versions
      ADD COLUMN IF NOT EXISTS material_definition_hash TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS material_config_hash TEXT NOT NULL DEFAULT ''`);

    const versions = await client.query<SqlRow>(`SELECT id,snapshot FROM ozon_listing_versions
      WHERE material_definition_hash='' OR material_config_hash='' FOR UPDATE`);
    for (const version of versions.rows) {
      const snapshot = jsonObject(version.snapshot);
      const data = jsonObject(snapshot.data);
      const sourceDefinition = {
        categoryKey: data.categoryKey || null,categoryVersionId: data.categoryVersionId || null,
        titleRu: data.titleRu || '',descriptionRu: data.descriptionRu || '',brand: data.brand || '',
        sharedAttributes: data.sharedAttributes || [],offers: stableSourceOffers(data.offers),mediaAssets: data.mediaAssets || []
      };
      const configDefinition = {
        vat: data.vat || null,dimensions: data.dimensions || null,videoUploadMode: data.videoUploadMode || null,
        purchaseMeasurements: data.purchaseMeasurements || null
      };
      await client.query(`UPDATE ozon_listing_versions SET material_definition_hash=$2,material_config_hash=$3 WHERE id=$1`, [
        version.id, sha256(sourceDefinition), sha256(configDefinition)
      ]);
    }

    const historicalJobs = await client.query<SqlRow>(`SELECT j.*,v.id generated_version_id,v.snapshot,
        s.display_name,s.warehouse_id store_warehouse_id,s.warehouse_name,s.fulfillment_mode,s.account_currency,
        s.default_preset_id,s.config_version,p.definition preset_definition,p.row_version preset_row_version
      FROM ozon_publish_jobs j
      LEFT JOIN ozon_listing_versions v ON v.sku=j.sku AND v.revision=j.listing_revision
      JOIN ozon_stores s ON s.id=j.store_id
      LEFT JOIN ozon_listing_presets p ON p.id=s.default_preset_id
      WHERE j.publication_id IS NULL ORDER BY j.created_at,j.id FOR UPDATE OF j`);
    for (const job of historicalJobs.rows) {
      if (!job.generated_version_id) {
        await client.query(`UPDATE ozon_publish_jobs SET credential_binding_mode='PURE_LEGACY',store_config_version=$2,
          warehouse_id=COALESCE(NULLIF(warehouse_id,''),$3) WHERE id=$1`, [job.id, job.config_version, job.store_warehouse_id || '']);
        continue;
      }
      const offerIds = normalizeStringArray(job.offer_ids);
      const offerContractHash = sha256({ sku: job.sku, offerIds });
      const materializationHash = sha256({
        storeId: job.store_id,generatedVersionId: job.generated_version_id,revision: Number(job.listing_revision),offerIds,
        warehouseId: job.store_warehouse_id || '',currency: job.account_currency || 'RUB',legacy: true
      });
      let publication = (await client.query<SqlRow>(`SELECT * FROM ozon_store_publications
        WHERE store_id=$1 AND generated_version_id=$2 FOR UPDATE`, [job.store_id, job.generated_version_id])).rows[0];
      if (!publication) {
        const publicationId = randomUUID();
        const links = normalizeArray(job.product_links);
        await client.query(`INSERT INTO ozon_store_publications(
          id,sku,generated_version_id,revision,store_id,store_alias_snapshot,store_display_name_snapshot,status,source,
          credential_binding_mode,store_config_version,preset_id,preset_snapshot,preset_definition_hash,task_id,
          warehouse_id,warehouse_name,fulfillment_mode,account_currency,offer_ids,offer_contract_hash,materialization_hash,
          package_rel_path,package_signature,product_ids,ozon_skus,product_links,result_json,error_code,error_message,completed_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'LEGACY_PUBLICATION',$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,
          $19::jsonb,$20,$21,$22,$23,$24::jsonb,$25::jsonb,$26::jsonb,$27::jsonb,$28,$29,$30)`, [
          publicationId, job.sku, job.generated_version_id, Number(job.listing_revision), job.store_id, job.store_alias,
          job.display_name || job.store_alias, publicationStateFromJob(String(job.state)), job.source === 'AUTO' ? 'AUTOMATION' : 'MANUAL',
          Number(job.config_version || 1), job.default_preset_id || null, JSON.stringify(jsonObject(job.preset_definition)),
          job.preset_definition ? sha256(job.preset_definition) : '', job.task_id || null,
          job.warehouse_id || job.store_warehouse_id || '', job.warehouse_name || '', job.fulfillment_mode || 'FBS',
          job.account_currency || 'RUB', JSON.stringify(offerIds), offerContractHash, materializationHash,
          job.work_rel_path || null, job.directory_signature || null,
          JSON.stringify(normalizeStringArray(links.map((link) => jsonObject(link).ozonProductId))),
          JSON.stringify(normalizeStringArray(links.map((link) => jsonObject(link).ozonSku))),
          JSON.stringify(normalizeStringArray(links.map((link) => jsonObject(link).url))),
          JSON.stringify({ migratedJobId: job.id, legacy: true }), job.last_error_code || '', job.last_error_message || '',
          job.finished_at || null
        ]);
        publication = { id: publicationId };
      }
      await client.query(`UPDATE ozon_publish_jobs SET publication_id=$2,credential_binding_mode='LEGACY_PUBLICATION',
        store_config_version=$3,warehouse_id=COALESCE(NULLIF(warehouse_id,''),$4),offer_contract_hash=$5,
        materialization_hash=$6 WHERE id=$1`, [
        job.id, publication.id, Number(job.config_version || 1), job.store_warehouse_id || '', offerContractHash, materializationHash
      ]);
    }

    await client.query(`UPDATE ozon_publish_events e SET publication_id=j.publication_id,store_id=j.store_id
      FROM ozon_publish_jobs j WHERE e.job_id=j.id`);
    await client.query(`INSERT INTO ozon_store_media_consumptions(
      store_id,sku,source_stage_id,submission_id,variant_id,decision,publication_id,job_id,reason
    ) SELECT j.store_id,d.sku,d.source_stage_id,d.submission_id,d.variant_id,'MIGRATED_BOUND',j.publication_id,j.id,
      '历史已绑定媒体投递'
      FROM ozon_media_deliveries d JOIN ozon_publish_jobs j ON j.id=d.job_id
      ON CONFLICT DO NOTHING`);

    await client.query('DROP INDEX IF EXISTS ozon_publish_jobs_one_active_per_sku');
    await client.query(`CREATE UNIQUE INDEX ozon_publish_jobs_one_active_per_store_sku ON ozon_publish_jobs(store_id,sku)
      WHERE state IN ('WAITING_MEDIA','READY','UPLOADING_MEDIA','SUBMITTING','IMPORTING','VERIFYING_IMAGES','UPDATING_PRICE','UPDATING_STOCK','MODERATING')`);
    await client.query('CREATE INDEX IF NOT EXISTS ozon_publish_jobs_store_due ON ozon_publish_jobs(store_id,state,next_attempt_at,lease_expires_at)');
    await client.query(`INSERT INTO ozon_schema_migrations(id) VALUES('013_ozon_multistore_vault')`);
    await migrateOzonMultiStoreHardening(client);
    await migrateOzonStoreOwnedPresetOwnership(client);
    await migrateOzonSharedMaterialAndPreparationAttempts(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function migrateOzonStoreOwnedPresetOwnership(client: PoolClient): Promise<void> {
  const applied = await client.query("SELECT 1 FROM ozon_schema_migrations WHERE id='017_ozon_store_owned_presets'");
  if (applied.rows[0]) return;
  const activeStores = await client.query<SqlRow>(`SELECT s.id,s.store_alias,s.display_name,s.default_preset_id,
      p.id AS preset_exists,p.name AS preset_name,p.description AS preset_description,p.definition AS preset_definition
    FROM ozon_stores s LEFT JOIN ozon_listing_presets p ON p.id=s.default_preset_id
    WHERE s.enabled=true AND s.archived_at IS NULL ORDER BY s.store_alias`);
  const missing = activeStores.rows.filter((row) => !row.default_preset_id || !row.preset_exists);
  if (missing.length) {
    throw new AppError('OZON_STORE_NOT_READY', '启用中的 OZON 店铺缺少有效默认预设，不能移除全局默认机制', {
      stores: missing.map((row) => ({
        id: String(row.id),
        storeAlias: String(row.store_alias),
        displayName: String(row.display_name || '')
      }))
    }, 409);
  }
  for (const row of activeStores.rows) {
    const raw = jsonObject(row.preset_definition);
    const definition = { ...raw };
    for (const key of ['isDefault', 'autoPublishEnabled', 'autoPublishMode', 'autoPublishActivatedAt', 'warehouseId', 'fulfillmentMode', 'currency']) {
      delete definition[key];
    }
    const parsed = ozonPresetInputSchema.safeParse({
      ...definition,
      name: row.preset_name,
      description: row.preset_description || '',
      sizes: Array.isArray(definition.sizes) && definition.sizes.length
        ? definition.sizes
        : [{ value: '', stock: Number(definition.defaultStock || 0) }]
    });
    if (!parsed.success) {
      throw new AppError('CONFIG_INVALID', '启用店铺绑定的 OZON 预设不符合店铺权威合同', {
        presetId: String(row.default_preset_id),
        presetName: String(row.preset_name || ''),
        issues: parsed.error.issues
      }, 409);
    }
  }
  await client.query(`CREATE TABLE IF NOT EXISTS ozon_legacy_configuration_audit(
    id TEXT PRIMARY KEY,snapshot JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await client.query(`INSERT INTO ozon_legacy_configuration_audit(id,snapshot)
    SELECT '017_ozon_store_owned_presets',jsonb_build_object(
      'presets',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.updated_at,p.id) FROM ozon_listing_presets p),'[]'::jsonb),
      'systemSettings',COALESCE((SELECT to_jsonb(s) FROM ozon_system_settings s WHERE s.id='default'),'{}'::jsonb)
    ) ON CONFLICT(id) DO NOTHING`);
  await client.query(`UPDATE ozon_listing_presets SET
    definition=definition-'isDefault'-'autoPublishEnabled'-'autoPublishMode'-'autoPublishActivatedAt'
      -'warehouseId'-'fulfillmentMode'-'currency',
    row_version=row_version+1,updated_at=NOW()
    WHERE definition ?| ARRAY['isDefault','autoPublishEnabled','autoPublishMode','autoPublishActivatedAt','warehouseId','fulfillmentMode','currency']`);
  await client.query('DROP INDEX IF EXISTS ozon_one_default_preset');
  await client.query('ALTER TABLE ozon_listing_presets DROP COLUMN IF EXISTS is_default');
  await client.query('ALTER TABLE ozon_listing_presets DROP COLUMN IF EXISTS auto_publish_activated_at');
  await client.query(`ALTER TABLE ozon_system_settings
    DROP COLUMN IF EXISTS default_store_alias,
    DROP COLUMN IF EXISTS credential_ready,
    DROP COLUMN IF EXISTS seller_id,
    DROP COLUMN IF EXISTS seller_name,
    DROP COLUMN IF EXISTS account_currency,
    DROP COLUMN IF EXISTS last_preflight_at,
    DROP COLUMN IF EXISTS last_preflight_status,
    DROP COLUMN IF EXISTS last_preflight_message`);
  await client.query("INSERT INTO ozon_schema_migrations(id) VALUES('017_ozon_store_owned_presets')");
}

async function migrateOzonSharedMaterialAndPreparationAttempts(client: PoolClient): Promise<void> {
  // Keep this additive guard ahead of the migration marker so development
  // databases that ran an earlier 018 draft cannot admit unrecoverable
  // PLANNED attempts without the immutable store product.
  await client.query(`ALTER TABLE ozon_store_publications
    ADD COLUMN IF NOT EXISTS materialized_product_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb`);
  const applied = await client.query(
    "SELECT 1 FROM ozon_schema_migrations WHERE id='018_ozon_shared_material_and_preparation_attempts'"
  );
  if (applied.rows[0]) return;

  await client.query(`ALTER TABLE ozon_listing_versions
    ADD COLUMN IF NOT EXISTS content_policy_version TEXT NOT NULL DEFAULT 'LEGACY_UNKNOWN',
    ADD COLUMN IF NOT EXISTS material_hash TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS material_hash_version TEXT NOT NULL DEFAULT 'LEGACY_UNKNOWN'`);
  await client.query(`ALTER TABLE ozon_publish_jobs
    ADD COLUMN IF NOT EXISTS task_kind TEXT NOT NULL DEFAULT 'LEGACY'`);
  await client.query(`UPDATE ozon_publish_jobs SET task_kind=CASE
      WHEN COALESCE(payload->>'multistorePreparation','false')='true' AND publication_id IS NULL
        THEN 'SHARED_PREPARATION'
      WHEN publication_id IS NOT NULL THEN 'STORE_PUBLICATION'
      ELSE 'LEGACY' END
    WHERE task_kind='LEGACY'`);
  await client.query('ALTER TABLE ozon_publish_jobs DROP CONSTRAINT IF EXISTS ozon_publish_jobs_task_kind_check');
  await client.query(`ALTER TABLE ozon_publish_jobs ADD CONSTRAINT ozon_publish_jobs_task_kind_check
    CHECK(task_kind IN ('SHARED_PREPARATION','STORE_PUBLICATION','LEGACY'))`);

  await client.query(`ALTER TABLE ozon_store_publications
    ADD COLUMN IF NOT EXISTS preparation_job_id UUID,
    ADD COLUMN IF NOT EXISTS planned_job_id UUID,
    ADD COLUMN IF NOT EXISTS request_id UUID,
    ADD COLUMN IF NOT EXISTS plan_hash TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS content_policy_version TEXT NOT NULL DEFAULT 'LEGACY_UNKNOWN',
    ADD COLUMN IF NOT EXISTS material_hash TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS material_hash_version TEXT NOT NULL DEFAULT 'LEGACY_UNKNOWN',
    ADD COLUMN IF NOT EXISTS materialized_product_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS preset_row_version INTEGER,
    ADD COLUMN IF NOT EXISTS publication_mode TEXT NOT NULL DEFAULT 'CREATE_ONLY'`);
  await client.query(`UPDATE ozon_store_publications p SET
      planned_job_id=COALESCE(p.planned_job_id,j.id),
      content_policy_version=CASE
        WHEN p.content_policy_version<>'LEGACY_UNKNOWN' THEN p.content_policy_version
        WHEN COALESCE(j.payload->>'contentPolicyVersion','') IN (
          'merchroute-ozon-content-v1','merchroute-ozon-content-v2','merchroute-ozon-content-v3'
        ) THEN j.payload->>'contentPolicyVersion'
        WHEN COALESCE(j.payload #>> '{importIntent,contentPolicyVersion}','') IN (
          'merchroute-ozon-content-v1','merchroute-ozon-content-v2','merchroute-ozon-content-v3'
        )
          THEN j.payload #>> '{importIntent,contentPolicyVersion}'
        ELSE 'LEGACY_UNKNOWN' END,
      material_hash=COALESCE(NULLIF(p.material_hash,''),v.material_hash,''),
      material_hash_version=CASE
        WHEN p.material_hash_version<>'LEGACY_UNKNOWN' THEN p.material_hash_version
        ELSE v.material_hash_version END,
      preset_row_version=COALESCE(p.preset_row_version,CASE
        WHEN COALESCE(p.preset_snapshot->>'rowVersion','') ~ '^[1-9][0-9]*$'
          THEN (p.preset_snapshot->>'rowVersion')::integer END),
      publication_mode=CASE
        WHEN COALESCE(p.preset_snapshot->>'autoPublishMode','')='COMPATIBLE_UPSERT' THEN 'COMPATIBLE_UPSERT'
        ELSE 'CREATE_ONLY' END
    FROM ozon_publish_jobs j,ozon_listing_versions v
    WHERE j.publication_id=p.id AND v.id=p.generated_version_id`);
  // Historical listing versions are writable again only when every explicit
  // publication/job/import-intent marker for that exact generatedVersionId
  // agrees on one known pre-v3 policy. Conflicting or absent evidence remains
  // LEGACY_UNKNOWN and therefore cannot enter the executable runtime claim.
  await client.query(`WITH policy_evidence AS (
      SELECT p.generated_version_id,e.content_policy_version
      FROM ozon_store_publications p
      LEFT JOIN ozon_publish_jobs j ON j.publication_id=p.id
      CROSS JOIN LATERAL (VALUES
        (NULLIF(p.content_policy_version,'LEGACY_UNKNOWN')),
        (CASE WHEN j.payload->>'contentPolicyVersion' IN (
          'merchroute-ozon-content-v1','merchroute-ozon-content-v2','merchroute-ozon-content-v3'
        ) THEN j.payload->>'contentPolicyVersion' END),
        (CASE WHEN j.payload #>> '{importIntent,contentPolicyVersion}' IN (
          'merchroute-ozon-content-v1','merchroute-ozon-content-v2','merchroute-ozon-content-v3'
        ) THEN j.payload #>> '{importIntent,contentPolicyVersion}' END)
      ) AS e(content_policy_version)
      WHERE e.content_policy_version IN (
        'merchroute-ozon-content-v1','merchroute-ozon-content-v2','merchroute-ozon-content-v3'
      )
    ), resolved_policy AS (
      SELECT generated_version_id,MIN(content_policy_version) content_policy_version
      FROM policy_evidence
      GROUP BY generated_version_id
      HAVING COUNT(DISTINCT content_policy_version)=1
        AND MIN(content_policy_version) IN (
          'merchroute-ozon-content-v1','merchroute-ozon-content-v2'
        )
    )
    UPDATE ozon_listing_versions v
    SET content_policy_version=r.content_policy_version
    FROM resolved_policy r
    WHERE v.id=r.generated_version_id AND v.content_policy_version='LEGACY_UNKNOWN'`);
  await client.query(`DO $attempt_fk$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ozon_publication_preparation_job_fk'
      AND conrelid='ozon_store_publications'::regclass) THEN
      ALTER TABLE ozon_store_publications ADD CONSTRAINT ozon_publication_preparation_job_fk
        FOREIGN KEY(preparation_job_id) REFERENCES ozon_publish_jobs(id) ON DELETE RESTRICT
        DEFERRABLE INITIALLY DEFERRED;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ozon_publication_planned_job_fk'
      AND conrelid='ozon_store_publications'::regclass) THEN
      ALTER TABLE ozon_store_publications ADD CONSTRAINT ozon_publication_planned_job_fk
        FOREIGN KEY(planned_job_id) REFERENCES ozon_publish_jobs(id) ON DELETE RESTRICT
        DEFERRABLE INITIALLY DEFERRED;
    END IF;
  END $attempt_fk$`);
  await client.query('ALTER TABLE ozon_store_publications DROP CONSTRAINT IF EXISTS ozon_publication_mode_check');
  await client.query(`ALTER TABLE ozon_store_publications ADD CONSTRAINT ozon_publication_mode_check
    CHECK(publication_mode IN ('CREATE_ONLY','COMPATIBLE_UPSERT'))`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ozon_publications_preparation_store_unique
    ON ozon_store_publications(preparation_job_id,store_id) WHERE preparation_job_id IS NOT NULL`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ozon_publications_request_store_unique
    ON ozon_store_publications(request_id,store_id) WHERE request_id IS NOT NULL`);

  const duplicateSharedPreparations = await client.query<SqlRow>(`SELECT sku,COUNT(*)::integer duplicate_count,
      jsonb_agg(id ORDER BY created_at,id) job_ids
    FROM ozon_publish_jobs
    WHERE task_kind='SHARED_PREPARATION'
      AND state IN ('WAITING_MEDIA','READY','UPLOADING_MEDIA','SUBMITTING','IMPORTING','VERIFYING_IMAGES','UPDATING_PRICE','UPDATING_STOCK','MODERATING')
    GROUP BY sku HAVING COUNT(*)>1 ORDER BY sku`);
  const duplicateStorePublications = await client.query<SqlRow>(`SELECT store_id,sku,COUNT(*)::integer duplicate_count,
      jsonb_agg(id ORDER BY created_at,id) job_ids
    FROM ozon_publish_jobs
    WHERE task_kind IN ('STORE_PUBLICATION','LEGACY')
      AND state IN ('WAITING_MEDIA','READY','UPLOADING_MEDIA','SUBMITTING','IMPORTING','VERIFYING_IMAGES','UPDATING_PRICE','UPDATING_STOCK','MODERATING')
    GROUP BY store_id,sku HAVING COUNT(*)>1 ORDER BY store_id,sku`);
  if (duplicateSharedPreparations.rows.length || duplicateStorePublications.rows.length) {
    throw new AppError('CONFIG_INVALID', '迁移 018 检测到重复活动 OZON 任务，必须先在维护窗口人工核验', {
      sharedPreparations: duplicateSharedPreparations.rows,
      storePublications: duplicateStorePublications.rows
    }, 409);
  }
  await client.query('DROP INDEX IF EXISTS ozon_publish_jobs_one_active_per_store_sku');
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ozon_publish_jobs_one_active_shared_preparation
    ON ozon_publish_jobs(sku)
    WHERE task_kind='SHARED_PREPARATION'
      AND state IN ('WAITING_MEDIA','READY','UPLOADING_MEDIA','SUBMITTING','IMPORTING','VERIFYING_IMAGES','UPDATING_PRICE','UPDATING_STOCK','MODERATING')`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ozon_publish_jobs_one_active_publication_per_store_sku
    ON ozon_publish_jobs(store_id,sku)
    WHERE task_kind IN ('STORE_PUBLICATION','LEGACY')
      AND state IN ('WAITING_MEDIA','READY','UPLOADING_MEDIA','SUBMITTING','IMPORTING','VERIFYING_IMAGES','UPDATING_PRICE','UPDATING_STOCK','MODERATING')`);
  await client.query(`INSERT INTO ozon_schema_migrations(id)
    VALUES('018_ozon_shared_material_and_preparation_attempts')`);
}

async function migrateOzonMultiStoreHardening(client: PoolClient): Promise<void> {
  const hardeningAlreadyApplied = Boolean((await client.query(
    "SELECT 1 FROM ozon_schema_migrations WHERE id='014_ozon_multistore_hardening'"
  )).rows[0]);
  await client.query(`ALTER TABLE ozon_stores
    ADD COLUMN IF NOT EXISTS vault_activated_at TIMESTAMPTZ`);
  await client.query(`ALTER TABLE ozon_store_runtime_state
    ADD COLUMN IF NOT EXISTS preflight_lease_owner TEXT`);
  await client.query(`UPDATE ozon_stores s SET
    vault_activated_at=COALESCE(s.vault_activated_at,c.activated_at,c.validated_at,s.updated_at),
    credential_binding_mode='VAULT'
    FROM ozon_store_credential_versions c
    WHERE c.id=s.active_credential_version_id AND s.vault_activated_at IS NULL`);
  await client.query(`CREATE OR REPLACE FUNCTION ozon_reject_store_alias_change()
    RETURNS trigger LANGUAGE plpgsql AS $immutable_alias$
    BEGIN
      IF NEW.store_alias IS DISTINCT FROM OLD.store_alias THEN
        RAISE EXCEPTION 'ozon store_alias is immutable' USING ERRCODE='55000';
      END IF;
      RETURN NEW;
    END $immutable_alias$`);
  await client.query('DROP TRIGGER IF EXISTS ozon_stores_alias_immutable ON ozon_stores');
  await client.query(`CREATE TRIGGER ozon_stores_alias_immutable
    BEFORE UPDATE OF store_alias ON ozon_stores
    FOR EACH ROW EXECUTE FUNCTION ozon_reject_store_alias_change()`);

  await client.query(`ALTER TABLE ozon_gateway_requests
    ALTER COLUMN credential_version_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS credential_binding_mode TEXT NOT NULL DEFAULT 'VAULT'
      CHECK(credential_binding_mode IN ('VAULT','LEGACY_PUBLICATION','PURE_LEGACY')),
    ADD COLUMN IF NOT EXISTS payload_hash TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS delegation_state TEXT NOT NULL DEFAULT 'NONE'
      CHECK(delegation_state IN ('NONE','AUTHORIZED_ONCE','RECEIPT_RECORDED'))`);
  await client.query('ALTER TABLE ozon_publish_jobs DROP CONSTRAINT IF EXISTS ozon_publish_jobs_credential_binding_mode_check');
  await client.query(`ALTER TABLE ozon_publish_jobs ADD CONSTRAINT ozon_publish_jobs_credential_binding_mode_check
    CHECK(credential_binding_mode IN ('VAULT','LEGACY_PUBLICATION','PURE_LEGACY'))`);
  await client.query('ALTER TABLE ozon_publish_jobs DROP CONSTRAINT IF EXISTS ozon_publish_jobs_vault_credential_required');
  await client.query(`ALTER TABLE ozon_publish_jobs ADD CONSTRAINT ozon_publish_jobs_vault_credential_required
    CHECK((credential_binding_mode<>'VAULT' OR credential_version_id IS NOT NULL) IS TRUE)`);
  await client.query(`UPDATE ozon_gateway_requests SET
    delivery_state=CASE
      WHEN delivery_state='RESPONDED' AND status_code BETWEEN 100 AND 499 AND status_code NOT IN (408,425,429)
        THEN 'RESPONDED'
      WHEN (delivery_state='RESPONDED' AND status_code IN (425,429))
        OR (delivery_state='NOT_SENT' AND (status_code IS NULL OR status_code IN (408,425,429) OR status_code>=500))
        THEN 'NOT_SENT'
      WHEN (delivery_state='RESPONDED' AND (status_code=408 OR status_code>=500))
        OR (delivery_state='UNKNOWN' AND (status_code IS NULL OR status_code=408 OR status_code>=500))
        THEN 'UNKNOWN'
      ELSE 'UNKNOWN'
    END,
    retry_class=CASE
      WHEN delivery_state='RESPONDED' AND status_code BETWEEN 200 AND 299 THEN 'NONE'
      WHEN delivery_state='RESPONDED' AND status_code BETWEEN 100 AND 499 AND status_code NOT IN (408,425,429)
        THEN 'PERMANENT'
      WHEN (delivery_state='RESPONDED' AND status_code IN (425,429))
        OR (delivery_state='NOT_SENT' AND status_code IS NOT NULL) THEN 'RETRYABLE'
      WHEN delivery_state='NOT_SENT' AND retry_class IN ('RETRYABLE','PERMANENT') THEN retry_class
      ELSE 'READBACK_REQUIRED'
    END,
    retry_after_ms=CASE
      WHEN (delivery_state='RESPONDED' AND status_code IN (425,429))
        OR (delivery_state='NOT_SENT' AND (status_code IS NOT NULL OR retry_class='RETRYABLE')) THEN retry_after_ms
      ELSE NULL
    END,
    status_code=CASE
      WHEN delivery_state='RESPONDED' AND status_code BETWEEN 100 AND 599 THEN status_code
      WHEN delivery_state='NOT_SENT' AND (status_code IN (408,425,429) OR status_code>=500) THEN status_code
      WHEN delivery_state='UNKNOWN' AND (status_code=408 OR status_code>=500) THEN status_code
      ELSE NULL
    END
    WHERE delegation_state='RECEIPT_RECORDED'`);
  await client.query(`UPDATE ozon_gateway_requests SET
    delivery_state='UNKNOWN',retry_class='READBACK_REQUIRED',retry_after_ms=NULL
    WHERE delegation_state='RECEIPT_RECORDED'
      AND operation IN ('importProduct','picturesImport','pricesWrite','stocksWrite')
      AND delivery_state='NOT_SENT' AND (status_code=408 OR status_code>=500)`);
  await client.query('ALTER TABLE ozon_gateway_requests DROP CONSTRAINT IF EXISTS ozon_gateway_legacy_receipt_matrix');
  await client.query(`ALTER TABLE ozon_gateway_requests ADD CONSTRAINT ozon_gateway_legacy_receipt_matrix CHECK((
        delegation_state<>'RECEIPT_RECORDED'
        OR (delivery_state='UNKNOWN' AND retry_class='READBACK_REQUIRED'
          AND (status_code IS NULL OR status_code=408 OR status_code>=500) AND retry_after_ms IS NULL)
        OR (delivery_state='NOT_SENT' AND retry_class IN ('RETRYABLE','PERMANENT')
          AND (status_code IS NULL OR status_code IN (408,425,429) OR status_code>=500)
          AND (status_code IS NULL OR retry_class='RETRYABLE')
          AND (operation NOT IN ('importProduct','picturesImport','pricesWrite','stocksWrite')
            OR status_code IS NULL OR status_code IN (425,429))
          AND (retry_class='RETRYABLE' OR retry_after_ms IS NULL))
        OR (delivery_state='RESPONDED' AND status_code IS NOT NULL
          AND status_code BETWEEN 100 AND 499 AND status_code NOT IN (408,425,429)
          AND ((status_code BETWEEN 200 AND 299 AND retry_class='NONE')
            OR (status_code NOT BETWEEN 200 AND 299 AND retry_class='PERMANENT'))
          AND retry_after_ms IS NULL)
      ) IS TRUE)`);

  // Every runtime identity is compound: a referenced credential,
  // publication or job must belong to the same store_id. Independent FKs are
  // insufficient because they permit cross-Seller row combinations.
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS ozon_credential_versions_store_identity ON ozon_store_credential_versions(store_id,id)');
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS ozon_publications_store_identity ON ozon_store_publications(store_id,id)');
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS ozon_jobs_store_identity ON ozon_publish_jobs(store_id,id)');
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS ozon_stores_alias_identity ON ozon_stores(id,store_alias)');
  await client.query(`DO $compound_identity$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ozon_stores_active_credential_store_fk'
      AND conrelid='ozon_stores'::regclass) THEN
      ALTER TABLE ozon_stores ADD CONSTRAINT ozon_stores_active_credential_store_fk
        FOREIGN KEY(id,active_credential_version_id) REFERENCES ozon_store_credential_versions(store_id,id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ozon_runtime_preflight_credential_store_fk'
      AND conrelid='ozon_store_runtime_state'::regclass) THEN
      ALTER TABLE ozon_store_runtime_state ADD CONSTRAINT ozon_runtime_preflight_credential_store_fk
        FOREIGN KEY(store_id,preflight_credential_version_id) REFERENCES ozon_store_credential_versions(store_id,id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ozon_preflight_run_credential_store_fk'
      AND conrelid='ozon_store_preflight_runs'::regclass) THEN
      ALTER TABLE ozon_store_preflight_runs ADD CONSTRAINT ozon_preflight_run_credential_store_fk
        FOREIGN KEY(store_id,credential_version_id) REFERENCES ozon_store_credential_versions(store_id,id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ozon_publication_credential_store_fk'
      AND conrelid='ozon_store_publications'::regclass) THEN
      ALTER TABLE ozon_store_publications ADD CONSTRAINT ozon_publication_credential_store_fk
        FOREIGN KEY(store_id,credential_version_id) REFERENCES ozon_store_credential_versions(store_id,id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ozon_job_credential_store_fk'
      AND conrelid='ozon_publish_jobs'::regclass) THEN
      ALTER TABLE ozon_publish_jobs ADD CONSTRAINT ozon_job_credential_store_fk
        FOREIGN KEY(store_id,credential_version_id) REFERENCES ozon_store_credential_versions(store_id,id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ozon_job_publication_store_fk'
      AND conrelid='ozon_publish_jobs'::regclass) THEN
      ALTER TABLE ozon_publish_jobs ADD CONSTRAINT ozon_job_publication_store_fk
        FOREIGN KEY(store_id,publication_id) REFERENCES ozon_store_publications(store_id,id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ozon_event_job_store_fk'
      AND conrelid='ozon_publish_events'::regclass) THEN
      ALTER TABLE ozon_publish_events ADD CONSTRAINT ozon_event_job_store_fk
        FOREIGN KEY(store_id,job_id) REFERENCES ozon_publish_jobs(store_id,id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ozon_event_publication_store_fk'
      AND conrelid='ozon_publish_events'::regclass) THEN
      ALTER TABLE ozon_publish_events ADD CONSTRAINT ozon_event_publication_store_fk
        FOREIGN KEY(store_id,publication_id) REFERENCES ozon_store_publications(store_id,id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ozon_consumption_job_store_fk'
      AND conrelid='ozon_store_media_consumptions'::regclass) THEN
      ALTER TABLE ozon_store_media_consumptions ADD CONSTRAINT ozon_consumption_job_store_fk
        FOREIGN KEY(store_id,job_id) REFERENCES ozon_publish_jobs(store_id,id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ozon_consumption_publication_store_fk'
      AND conrelid='ozon_store_media_consumptions'::regclass) THEN
      ALTER TABLE ozon_store_media_consumptions ADD CONSTRAINT ozon_consumption_publication_store_fk
        FOREIGN KEY(store_id,publication_id) REFERENCES ozon_store_publications(store_id,id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ozon_gateway_credential_store_fk'
      AND conrelid='ozon_gateway_requests'::regclass) THEN
      ALTER TABLE ozon_gateway_requests ADD CONSTRAINT ozon_gateway_credential_store_fk
        FOREIGN KEY(store_id,credential_version_id) REFERENCES ozon_store_credential_versions(store_id,id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ozon_gateway_publication_store_fk'
      AND conrelid='ozon_gateway_requests'::regclass) THEN
      ALTER TABLE ozon_gateway_requests ADD CONSTRAINT ozon_gateway_publication_store_fk
        FOREIGN KEY(store_id,publication_id) REFERENCES ozon_store_publications(store_id,id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ozon_refresh_lease_job_store_fk'
      AND conrelid='ozon_platform_status_refresh_leases'::regclass) THEN
      ALTER TABLE ozon_platform_status_refresh_leases ADD CONSTRAINT ozon_refresh_lease_job_store_fk
        FOREIGN KEY(store_id,job_id) REFERENCES ozon_publish_jobs(store_id,id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='ozon_mapping_alias_store_fk'
      AND conrelid='ozon_product_mappings'::regclass) THEN
      ALTER TABLE ozon_product_mappings ADD CONSTRAINT ozon_mapping_alias_store_fk
        FOREIGN KEY(store_id,store_alias) REFERENCES ozon_stores(id,store_alias) ON DELETE RESTRICT;
    END IF;
  END $compound_identity$`);

  await client.query(`ALTER TABLE ozon_listing_versions
    ADD COLUMN IF NOT EXISTS base_preset_id UUID REFERENCES ozon_listing_presets(id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS material_overrides JSONB NOT NULL DEFAULT '{}'::jsonb`);
  if (!hardeningAlreadyApplied) {
    const versions = await client.query<SqlRow>(`SELECT id,snapshot FROM ozon_listing_versions
      WHERE material_overrides='{}'::jsonb`);
    for (const row of versions.rows) {
      const snapshot = jsonObject(row.snapshot);
      const data = jsonObject(snapshot.data);
      const presetSnapshot = jsonObject(jsonObject(data.initialization).presetSnapshot);
      const basePreset = jsonObject(presetSnapshot.definition);
      const presetId = String(presetSnapshot.presetId || '').trim();
      const presetExists = presetId && /^[0-9a-f-]{36}$/i.test(presetId)
        ? Boolean((await client.query<{ exists: boolean }>(
            'SELECT EXISTS(SELECT 1 FROM ozon_listing_presets WHERE id=$1) exists', [presetId]
          )).rows[0]?.exists)
        : false;
      await client.query(`UPDATE ozon_listing_versions SET
        base_preset_id=CASE WHEN $2::boolean THEN $3::uuid ELSE base_preset_id END,
        material_overrides=$4::jsonb WHERE id=$1`, [
        row.id, presetExists, presetExists ? presetId : null,
        JSON.stringify(deriveMaterialOverrides(data, basePreset))
      ]);
    }
  }
  await client.query(`INSERT INTO ozon_schema_migrations(id) VALUES('014_ozon_multistore_hardening') ON CONFLICT(id) DO NOTHING`);
  const republishSlotsApplied = Boolean((await client.query(
    "SELECT 1 FROM ozon_schema_migrations WHERE id='015_ozon_multistore_republish_slots'"
  )).rows[0]);
  if (!republishSlotsApplied) {
    await client.query(`DO $republish_slots$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM ozon_publish_jobs
          WHERE state IN ('WAITING_MEDIA','READY','UPLOADING_MEDIA','SUBMITTING','IMPORTING','VERIFYING_IMAGES','UPDATING_PRICE','UPDATING_STOCK','MODERATING')
          GROUP BY store_id,sku HAVING COUNT(*) > 1
        ) THEN
          RAISE EXCEPTION '015_ozon_multistore_republish_slots: duplicate active OZON jobs for the same store/SKU require manual resolution before migration';
        END IF;
      END
    $republish_slots$`);
    await client.query('DROP INDEX IF EXISTS ozon_publish_jobs_one_active_per_store_sku');
    await client.query(`CREATE UNIQUE INDEX ozon_publish_jobs_one_active_per_store_sku
      ON ozon_publish_jobs(store_id,sku)
      WHERE state IN ('WAITING_MEDIA','READY','UPLOADING_MEDIA','SUBMITTING','IMPORTING','VERIFYING_IMAGES','UPDATING_PRICE','UPDATING_STOCK','MODERATING')`);
    await client.query(`INSERT INTO ozon_schema_migrations(id) VALUES('015_ozon_multistore_republish_slots')`);
  }
}
