import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import {
  AppError,
  WB_DEFAULT_STORE_ALIAS,
  WB_DEFAULT_STORE_ID,
  normalizeWbComparablePath,
  normalizeWbDescription,
  wbCategoryDraftInputSchema,
  wbCategoryKeySchema,
  wbListingDraftUpdateSchema,
  wbNetworkRecoverySchema,
  type WbCategoryDraftInput,
  type WbListingDraftUpdate,
  type WbNetworkRecovery
} from '@n8n-media-review/shared';
import { migrateWbMultiStoreSchema, syncPublicationFromRuntime } from './wb-stores.js';
import { WbAutoRetryRepository } from './wb-auto-retry.js';
import {
  applyWbPurchaseMeasurementProjection,
  createWbPurchaseMeasurements,
  projectWbPurchaseMeasurements,
  sameWbPurchaseMeasurementValues
} from '../services/wb-purchase-measurements.js';
import { wbMaterialPresetDefinitionHashFromListingData } from '../services/wb-presets/material-hash.js';

type SqlRow = Record<string, any>;
type JsonRecord = Record<string, unknown>;

export type WbMediaAsset = {
  assetId: string;
  relativePath: string;
  kind: 'image' | 'video';
  sortOrder?: number;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  modifiedAt: string;
  validationStatus: 'VALID' | 'INVALID';
  validationError?: string;
  productVariantId?: string;
  productVariantName?: string;
  productVariantColor?: { colorKey: string; nameRu: string; nameZh: string };
  sourceStageId?: string;
  sourceSubmissionId?: string;
  deliveredAt?: string;
};

export type WbActiveTaskReference = {
  sku: string;
  taskId: string;
  status: 'SUBMITTING' | 'QUEUED' | 'RUNNING';
};

export type WbListingTaskOwnership = {
  sku: string;
  taskId: string;
  revision: number;
  automationContext: JsonRecord;
  subjectId?: number;
};

export type WbPendingTerminalNotification = {
  sku: string;
  versionId: string;
  expectedStatus: 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'NEEDS_ATTENTION';
  listing: JsonRecord;
};

export type WbGeneratedPackageContext = {
  sku: string;
  versionId: string;
  revision: number;
  versionStatus: string;
  draftStatus: string;
  currentVersionId: string;
  productJson: unknown;
  mediaManifest: unknown;
  generationScope: 'LISTING' | 'STORE_PUBLICATION';
  materializationHash?: string;
};

export type WbHistoricalNetworkListingCandidate = {
  kind: 'MANUAL';
  identity: {
    versionId: string;
    sku: string;
    revision: number;
    taskId: string;
  };
  rowVersion: string;
  proposedRecovery: WbNetworkRecovery;
  evidence: {
    state: 'FAILED';
    draftState: 'FAILED';
    transport: true;
    errorCode: string;
    errorMessage: string;
    httpStatus?: number;
    activeLease: false;
    currentDraft: true;
    updatedAt?: string;
  };
  result: JsonRecord;
};

export type WbHistoricalNetworkListingRecoveryResult = {
  listing: JsonRecord;
  rowVersion: string;
  evidence: WbHistoricalNetworkListingCandidate['evidence'];
};

export type WbHistoricalRuntimeNetworkFailureCandidate = {
  kind: 'RUNTIME';
  identity: {
    taskId: string;
    idempotencyKey: string;
    productCode: string;
    revision: number;
    payloadSignature: string;
    workRelpath: string;
  };
  rowVersion: number;
  evidence: {
    state: 'FAILED';
    transport: true;
    errorCode: string;
    errorMessage: string;
    httpStatus?: number;
    activeLease: false;
    phase: string;
    checkpoint: string;
    deliveryState: 'NOT_SENT' | 'UNKNOWN' | 'RESPONDED';
    safeResumeState?: string;
    safeReadback: boolean;
    recoverable: boolean;
    reason: string;
    updatedAt?: string;
  };
};

export type WbHistoricalRuntimeNetworkRecoveryResult = {
  job: JsonRecord;
  rowVersion: number;
  evidence: WbHistoricalRuntimeNetworkFailureCandidate['evidence'];
};

export type WbProjectionStatus = 'NOT_SYNCED' | 'PENDING' | 'SYNCED' | 'FAILED';
export type WbListingOperationSource = 'MANUAL' | 'AUTOMATION';

export type WbCatalogTrigger = 'MANUAL' | 'SCHEDULED' | 'STARTUP';
export type WbCatalogRunStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export type WbCatalogParentInput = {
  parentId: number;
  nameRu: string;
  nameZh: string;
  isVisible: boolean;
};

export type WbCatalogSubjectInput = {
  subjectId: number;
  subjectNameRu: string;
  subjectNameZh: string;
  parentId: number;
  parentNameRu: string;
  parentNameZh: string;
};

export type WbCatalogColorInput = {
  colorKey: string;
  position: number;
  nameRu: string;
  nameZh: string;
  parentNameRu: string;
  parentNameZh: string;
};

export type WbCatalogDictionaryName = 'countries' | 'seasons' | 'kinds' | 'colors';

export type WbCatalogDictionaryValueInput = {
  directory: Exclude<WbCatalogDictionaryName, 'colors'>;
  valueKey: string;
  position: number;
  wbId?: number;
  nameRu: string;
  nameZh: string;
  fullNameRu: string;
  fullNameZh: string;
};

export type WbCatalogRun = {
  runId: string;
  trigger: WbCatalogTrigger;
  status: WbCatalogRunStatus;
  scheduleKey?: string;
  startedAt: string;
  completedAt?: string;
  processedParents: number;
  totalParents: number;
  processedSubjects: number;
  snapshotPath?: string;
  errorCode?: string;
  errorMessage?: string;
};

export type WbCatalogOverview = {
  parentCount: number;
  subjectCount: number;
  colorCount: number;
  dictionaryCounts: Record<WbCatalogDictionaryName, number>;
  currentRun?: WbCatalogRun;
  latestRun?: WbCatalogRun;
  lastSuccessfulAt?: string;
};

export type WbCatalogLock = { release: () => Promise<void> };

export type WbRuntimeJobListInput = {
  due?: boolean;
  page?: number;
  pageSize?: number;
  taskId?: string;
  productCode?: string;
  storeId?: string;
};

export type WbRuntimeJobClaimInput = {
  leaseOwner: string;
  limit?: number;
  leaseSeconds?: number;
};

export type WbRuntimeCardMatch = {
  vendorCode: string;
  location: 'ACTIVE' | 'TRASH';
  nmId?: number;
  imtId?: number;
  subjectId?: number;
};

export type WbCompatibleRecoveryInput = {
  automationRunId: string;
  matches: WbRuntimeCardMatch[];
};

export type WbRuntimeJobTransitionInput = {
  rowVersion?: number;
  job?: JsonRecord;
  registryRows?: JsonRecord[];
  eventType?: string;
  message?: string;
};

const EMPTY_DRAFT = {
  brand: '',
  titleRu: '',
  descriptionRu: '',
  packaging: {},
  priceCny: 0,
  discountPercent: 0,
  clubDiscount: null,
  videoUploadMode: 'ORIGINAL',
  compliance: { tnved: '', kizMarked: false },
  sharedCharacteristics: [],
  variants: []
};

export class WbRepository {
  readonly autoRetry = new WbAutoRetryRepository({
    syncPublication: (client, row) => syncPublicationFromRuntime(client, row),
    query: (sql, values) => this.query(sql, values),
    transaction: (action) => this.transaction(action)
  });
  private pool?: Pool;
  private trigramAvailable = false;

  constructor(private readonly connectionString?: string) {}

  get configured(): boolean { return Boolean(this.pool); }

  async initialize(): Promise<void> {
    if (!this.connectionString) return;
    this.pool = new Pool({ connectionString: this.connectionString, max: 6, idleTimeoutMillis: 30_000 });
    try {
      await this.pool.query('SELECT 1');
      await this.migrate();
      await migrateWbMultiStoreSchema(this.pool);
      this.trigramAvailable = Boolean((await this.pool.query<{ available: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_trgm') available")).rows[0]?.available);
    } catch (error) {
      await this.pool.end().catch(() => undefined);
      this.pool = undefined;
      throw error;
    }
  }

  async close(): Promise<void> { await this.pool?.end(); }

  async countActiveListings(): Promise<number> {
    const result = await this.query<{ total: string }>("SELECT COUNT(*)::text total FROM wb_listing_drafts WHERE status IN ('GENERATING','SUBMITTING','QUEUED','RUNNING','NEEDS_ATTENTION')");
    return Number(result.rows[0]?.total || 0);
  }

  async listGeneratedSkus(): Promise<string[]> {
    const result = await this.query<{ sku: string }>("SELECT sku FROM wb_listing_drafts WHERE status='GENERATED'");
    return result.rows.map((row) => row.sku);
  }

  async countListingVersions(skuInput: string): Promise<number> {
    const sku = normalizeSku(skuInput);
    const result = await this.query<{ total: string }>('SELECT COUNT(*)::text total FROM wb_listing_versions WHERE sku=$1', [sku]);
    return Number(result.rows[0]?.total || 0);
  }

  async getListingTaskOwnership(taskIdInput: string): Promise<WbListingTaskOwnership> {
    const taskId = String(taskIdInput || '').trim();
    if (!taskId) throw new AppError('CONFIG_INVALID', 'taskId 必填');
    let result = await this.query<SqlRow>(`SELECT v.sku,v.n8n_task_id,v.revision,v.automation_context,c.subject_id
      FROM wb_listing_versions v
      JOIN wb_listing_drafts d ON d.sku=v.sku AND d.generated_version_id=v.id AND d.n8n_task_id=v.n8n_task_id
      LEFT JOIN wb_category_template_versions c ON c.id=v.category_version_id
      WHERE v.n8n_task_id=$1`, [taskId]);
    // 多店铺自动发布不再把每店 taskId 写进单例 wb_listing_drafts 指针；
    // 归属应从不可变 publication -> generatedVersion -> runtime 快照回读。
    // 仍优先保留旧单店查询，兼容历史任务与人工发布。
    if (!result.rows[0]) {
      result = await this.query<SqlRow>(`SELECT p.sku,j.task_id n8n_task_id,j.revision,
          jsonb_build_object(
            'runId',j.result_json->>'automationRunId',
            'operationMode',j.result_json->>'submissionMode'
          ) automation_context,
          COALESCE(NULLIF(j.result_json->>'expectedSubjectId','')::integer,c.subject_id) subject_id
        FROM wb_publish_jobs j
        JOIN wb_store_publications p ON p.id=j.publication_id AND p.task_id=j.task_id
          AND p.store_id=j.store_id AND p.sku=j.product_code
        JOIN wb_listing_versions v ON v.id=p.generated_version_id AND v.sku=p.sku
        LEFT JOIN wb_category_template_versions c ON c.id=v.category_version_id
        WHERE j.task_id=$1`, [taskId]);
    }
    const row = result.rows[0];
    if (!row) throw new AppError('NOT_FOUND', '未找到与 runtime task 对应的当前 WB 上品版本', { taskId }, 404);
    return {
      sku: String(row.sku || ''),
      taskId: String(row.n8n_task_id || ''),
      revision: Number(row.revision || 0),
      automationContext: asObject(row.automation_context),
      ...(positiveInteger(row.subject_id) ? { subjectId: positiveInteger(row.subject_id) } : {})
    };
  }

  async listActiveTaskReferences(limit = 25): Promise<WbActiveTaskReference[]> {
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit) || 25));
    const result = await this.query<{ sku: string; taskId: string; status: WbActiveTaskReference['status'] }>(`
      SELECT sku,n8n_task_id AS "taskId",status
      FROM wb_listing_drafts
      WHERE status IN ('SUBMITTING','QUEUED','RUNNING') AND n8n_task_id IS NOT NULL
        AND (network_next_attempt_at IS NULL OR network_next_attempt_at<=NOW())
      ORDER BY COALESCE(submitted_at,updated_at) ASC
      LIMIT $1`, [safeLimit]);
    return result.rows;
  }

  async listHistoricalNetworkListingCandidates(limit = 100): Promise<WbHistoricalNetworkListingCandidate[]> {
    const safeLimit = Math.min(500, Math.max(1, Math.trunc(limit) || 100));
    const result = await this.query<SqlRow>(`SELECT v.id version_id,v.sku,v.revision,v.status,v.n8n_task_id,v.error_message,
      v.result_json,v.network_recovery,v.updated_at,v.xmin::text row_version,d.status draft_status
      FROM wb_listing_versions v
      JOIN wb_listing_drafts d ON d.sku=v.sku AND d.generated_version_id=v.id AND d.n8n_task_id=v.n8n_task_id
      WHERE v.status='FAILED'
        AND d.status='FAILED'
        AND v.n8n_task_id IS NOT NULL
        AND NOT EXISTS(
          SELECT 1 FROM wb_publish_jobs runtime
          WHERE runtime.task_id=v.n8n_task_id AND BTRIM(runtime.lease_owner)<>'' AND runtime.lease_expires_at>NOW()
        )
        AND (
          UPPER(COALESCE(v.result_json->>'errorCode',v.result_json->>'lastErrorCode','')) IN
            ('ETIMEDOUT','ESOCKETTIMEDOUT','ECONNRESET','ECONNABORTED','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','TLS_EOF','HTTP_408','HTTP_429')
          OR UPPER(COALESCE(v.result_json->>'errorCode',v.result_json->>'lastErrorCode','')) ~ '(^|_)HTTP_(408|429|5[0-9]{2})$'
          OR COALESCE(v.result_json->>'httpStatus',v.result_json->>'statusCode','') ~ '^(408|429|5[0-9]{2})$'
          OR UPPER(COALESCE(v.error_message,'')) ~
            '(ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNABORTED|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|SOCKET HANG UP|TLS.*EOF|HTTP[^0-9]*(408|429|5[0-9]{2})|断网|网络(中断|不可用|连接失败|超时))'
        )
      ORDER BY v.updated_at ASC LIMIT $1`, [safeLimit]);
    return result.rows.flatMap((row) => {
      const transport = historicalTransportEvidence(row);
      if (!transport) return [];
      const proposedRecovery = historicalListingProposedRecovery(row, transport);
      return [{
        kind: 'MANUAL' as const,
        identity: {
          versionId: String(row.version_id),
          sku: String(row.sku),
          revision: Number(row.revision),
          taskId: String(row.n8n_task_id)
        },
        rowVersion: String(row.row_version),
        proposedRecovery,
        evidence: {
          state: 'FAILED' as const,
          draftState: 'FAILED' as const,
          transport: true as const,
          errorCode: transport.errorCode,
          errorMessage: transport.errorMessage,
          ...(transport.httpStatus ? { httpStatus: transport.httpStatus } : {}),
          activeLease: false as const,
          currentDraft: true as const,
          ...(isoOrUndefined(row.updated_at) ? { updatedAt: isoOrUndefined(row.updated_at) } : {})
        },
        result: parseJsonRecord(row.result_json)
      }];
    });
  }

  async recoverHistoricalNetworkListing(
    versionIdInput: string,
    expectedTaskIdInput: string,
    expectedRowVersionInput: string,
    recoveryInput: WbNetworkRecovery
  ): Promise<WbHistoricalNetworkListingRecoveryResult> {
    const versionId = String(versionIdInput || '').trim();
    const expectedTaskId = String(expectedTaskIdInput || '').trim();
    const expectedRowVersion = String(expectedRowVersionInput || '').trim();
    if (!versionId || !expectedTaskId || !expectedRowVersion) {
      throw new AppError('CONFIG_INVALID', 'versionId、expectedTaskId 与 expectedRowVersion 必填');
    }
    const parsedRecovery = wbNetworkRecoverySchema.safeParse(recoveryInput);
    if (!parsedRecovery.success || parsedRecovery.data.resumeState !== 'SUBMITTING') {
      throw new AppError('CONFIG_INVALID', '手动 WB 历史任务只能按 SUBMITTING 检查点恢复', {
        issues: parsedRecovery.success ? undefined : parsedRecovery.error.issues,
        resumeState: parsedRecovery.success ? parsedRecovery.data.resumeState : undefined
      });
    }
    const recovery = parsedRecovery.data;
    if (recovery.checkpoint && recovery.checkpoint !== `taskId:${expectedTaskId}`) {
      throw new AppError('CONFIG_INVALID', '网络恢复检查点与 expectedTaskId 不一致', {
        expectedTaskId, checkpoint: recovery.checkpoint
      });
    }
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>(`SELECT v.*,v.xmin::text row_version,d.status draft_status,
          d.generated_version_id draft_version_id,d.n8n_task_id draft_task_id
        FROM wb_listing_versions v
        JOIN wb_listing_drafts d ON d.sku=v.sku
        WHERE v.id=$1
        FOR UPDATE OF v,d`, [versionId]);
      const row = current.rows[0];
      const conflict = (message: string, details: JsonRecord = {}) => new AppError('VERSION_CONFLICT', message, {
        versionId,
        expectedTaskId,
        expectedRowVersion,
        actualTaskId: row?.n8n_task_id ? String(row.n8n_task_id) : undefined,
        actualRowVersion: row?.row_version ? String(row.row_version) : undefined,
        actualState: row?.status ? String(row.status) : undefined,
        ...details
      }, 409);
      if (!row) throw conflict('WB 历史上品版本不存在或已被清理');
      if (String(row.row_version) !== expectedRowVersion) throw conflict('WB 历史上品版本已变化，拒绝使用过期 rowVersion 恢复');
      if (String(row.status) !== 'FAILED' || String(row.draft_status) !== 'FAILED') {
        throw conflict('WB 历史上品任务不再是可恢复的 FAILED 状态', { actualDraftState: row.draft_status });
      }
      if (String(row.n8n_task_id || '') !== expectedTaskId || String(row.draft_task_id || '') !== expectedTaskId
        || String(row.draft_version_id || '') !== versionId) {
        throw conflict('WB 历史上品任务身份已变化，拒绝创建新任务或覆盖其他版本', {
          actualDraftTaskId: row.draft_task_id,
          actualDraftVersionId: row.draft_version_id
        });
      }
      const transport = historicalTransportEvidence(row);
      if (!transport) throw conflict('FAILED 记录缺少严格的网络或 HTTP 408/429/5xx 证据');
      const proposedRecovery = historicalListingProposedRecovery(row, transport);
      if (stableJson(proposedRecovery) !== stableJson(recovery)) {
        throw conflict('客户端提交的 proposedRecovery 与当前 FAILED 证据不一致', {
          proposedRecovery
        });
      }
      const runtimeTask = await client.query<SqlRow>(`SELECT task_id,state,lease_owner,lease_expires_at,row_version,
          (BTRIM(lease_owner)<>'' AND lease_expires_at>NOW()) active_lease
        FROM wb_publish_jobs
        WHERE task_id=$1
        FOR UPDATE`, [expectedTaskId]);
      const liveLease = runtimeTask.rows[0]?.active_lease ? runtimeTask.rows[0] : undefined;
      if (liveLease) {
        throw new AppError('TASK_LOCKED', '原 WB runtime task 仍持有有效租约，拒绝并发恢复', {
          versionId, expectedTaskId, leaseOwner: liveLease.lease_owner,
          leaseExpiresAt: isoOrUndefined(liveLease.lease_expires_at),
          runtimeRowVersion: Number(liveLease.row_version || 0)
        }, 409);
      }
      if (String(runtimeTask.rows[0]?.state || '').toUpperCase() === 'FAILED') {
        throw new AppError('RUNTIME_RECOVERY_REQUIRED', '原 WB runtime task 仍为 FAILED，必须先按其 rowVersion 原地恢复', {
          versionId, expectedTaskId, runtimeRowVersion: Number(runtimeTask.rows[0]?.row_version || 0)
        }, 409);
      }
      const changed = await client.query<SqlRow>(`UPDATE wb_listing_versions SET
          status='SUBMITTING',network_recovery=$4::jsonb,network_next_attempt_at=$5,
          error_message=$6,completed_at=NULL,terminal_notification_pending=false,updated_at=NOW()
        WHERE id=$1 AND n8n_task_id=$2 AND xmin::text=$3 AND status='FAILED'
        RETURNING xmin::text row_version`, [versionId, expectedTaskId, expectedRowVersion, JSON.stringify(recovery),
        recovery.nextAttemptAt, recovery.lastErrorMessage]);
      if (!changed.rows[0]) throw conflict('WB 历史上品版本 CAS 恢复冲突');
      const draftChanged = await client.query(`UPDATE wb_listing_drafts SET
          status='SUBMITTING',network_recovery=$4::jsonb,network_next_attempt_at=$5,
          last_error=$6,submitted_at=COALESCE(submitted_at,NOW()),updated_at=NOW()
        WHERE sku=$1 AND generated_version_id=$2 AND n8n_task_id=$3 AND status='FAILED'`, [row.sku, versionId,
        expectedTaskId, JSON.stringify(recovery), recovery.nextAttemptAt, recovery.lastErrorMessage]);
      if (!draftChanged.rowCount) throw conflict('WB 当前草稿身份在恢复期间发生变化');
      return {
        listing: await getListingWith(client, String(row.sku)),
        rowVersion: String(changed.rows[0].row_version),
        evidence: {
          state: 'FAILED', draftState: 'FAILED', transport: true,
          errorCode: transport.errorCode, errorMessage: transport.errorMessage,
          ...(transport.httpStatus ? { httpStatus: transport.httpStatus } : {}),
          activeLease: false, currentDraft: true,
          ...(isoOrUndefined(row.updated_at) ? { updatedAt: isoOrUndefined(row.updated_at) } : {})
        }
      };
    });
  }

  async listPendingTerminalNotifications(limit = 25, skuInput?: string): Promise<WbPendingTerminalNotification[]> {
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit) || 25));
    const sku = skuInput === undefined ? undefined : normalizeSku(skuInput);
    // Query the immutable revision directly. A user may already have generated
    // a newer revision while an older terminal notification is waiting for the
    // message-center database, and that must not orphan the older outbox row.
    const result = await this.query<SqlRow>(`${pendingTerminalNotificationSelect()}
      WHERE v.terminal_notification_pending=true AND ($1::text IS NULL OR v.sku=$1)
      ORDER BY v.completed_at ASC NULLS FIRST,v.updated_at ASC
      LIMIT $2`, [sku || null, safeLimit]);
    return result.rows.map(toPendingTerminalNotification);
  }

  async getPendingTerminalNotification(versionId: string): Promise<WbPendingTerminalNotification | undefined> {
    const result = await this.query<SqlRow>(`${pendingTerminalNotificationSelect()}
      WHERE v.id=$1 AND v.terminal_notification_pending=true`, [versionId]);
    return result.rows[0] ? toPendingTerminalNotification(result.rows[0]) : undefined;
  }

  async withTerminalNotificationLock<T>(versionId: string, operation: () => Promise<T>): Promise<T> {
    const client = await this.requirePool().connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended('merchroute_wb_notification:'||$1,0))", [versionId]);
      return await operation();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended('merchroute_wb_notification:'||$1,0))", [versionId]).catch(() => undefined);
      client.release();
    }
  }

  async markTerminalNotificationDelivered(versionId: string, expectedStatus: WbPendingTerminalNotification['expectedStatus']): Promise<boolean> {
    const result = await this.query(`UPDATE wb_listing_versions SET
      terminal_notification_pending=false,terminal_notification_delivered_at=NOW(),updated_at=NOW()
      WHERE id=$1 AND status=$2 AND terminal_notification_pending=true`, [versionId, expectedStatus]);
    return (result.rowCount || 0) > 0;
  }

  async withRootConfigurationLock<T>(operation: (activeCount: number) => Promise<T>): Promise<T> {
    const client = await this.requirePool().connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('pixroute_wb_root_configuration'))");
      const active = await client.query<{ total: string }>("SELECT COUNT(*)::text total FROM wb_listing_drafts WHERE status IN ('GENERATING','SUBMITTING','QUEUED','RUNNING','NEEDS_ATTENTION')");
      const result = await operation(Number(active.rows[0]?.total || 0));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listListings(input: { page?: number; pageSize?: number; query?: string; updatedFrom?: string; updatedTo?: string; source?: WbListingOperationSource | 'ALL' }) {
    const page = Math.max(1, Number(input.page) || 1);
    const pageSize = Math.min(100, Math.max(10, Number(input.pageSize) || 30));
    const values: unknown[] = [];
    const where: string[] = [];
    if (input.query?.trim()) {
      values.push(`%${input.query.trim()}%`);
      where.push(`(p.sku ILIKE $${values.length} OR p.product_name ILIKE $${values.length})`);
    }
    if (input.updatedFrom) { values.push(input.updatedFrom); where.push(`d.updated_at >= $${values.length}::timestamptz`); }
    if (input.updatedTo) { values.push(input.updatedTo); where.push(`d.updated_at < $${values.length}::timestamptz`); }
    if (input.source && input.source !== 'ALL') { values.push(input.source); where.push(`d.latest_operation_source=$${values.length}`); }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await this.query<{ total: string }>(`SELECT COUNT(*)::text total FROM wb_listing_drafts d JOIN products p ON p.sku=d.sku ${filter}`, values);
    values.push(pageSize, (page - 1) * pageSize);
    const rows = await this.query<SqlRow>(`${listingSelect()} ${filter} ORDER BY d.updated_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return { items: rows.rows.map(toListingSummary), total: Number(count.rows[0]?.total || 0), page, pageSize };
  }

  async createListing(skuInput: string) {
    const sku = normalizeSku(skuInput);
    await this.query(`INSERT INTO wb_listing_drafts (sku,data,latest_operation_source,latest_operation_at,latest_operation_ref)
      SELECT sku,$2::jsonb,'MANUAL',NOW(),'manual:create' FROM products WHERE sku=$1 ON CONFLICT(sku) DO NOTHING`, [sku, JSON.stringify(EMPTY_DRAFT)]);
    return this.getListing(sku);
  }

  async getListing(skuInput: string) {
    const sku = normalizeSku(skuInput);
    const result = await this.query<SqlRow>(`${listingSelect()} WHERE d.sku=$1`, [sku]);
    if (!result.rows[0]) {
      const product = await this.query('SELECT sku FROM products WHERE sku=$1', [sku]);
      if (!product.rows[0]) throw new AppError('NOT_FOUND', '产品 SKU 不存在', { sku }, 404);
      throw new AppError('NOT_FOUND', 'WB 上品草稿不存在', { sku }, 404);
    }
    return toListing(result.rows[0]);
  }

  async updateListing(skuInput: string, input: unknown, options: { bypassAutoLock?: boolean; operationRef?: string } = {}) {
    const sku = normalizeSku(skuInput);
    const parsed = wbListingDraftUpdateSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error.issues);
    return this.transaction(async (client) => {
      const locked = await client.query<SqlRow>('SELECT * FROM wb_listing_drafts WHERE sku=$1 FOR UPDATE', [sku]);
      const row = locked.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'WB 上品草稿不存在', { sku }, 404);
      assertDraftVersion(row, parsed.data.draftVersion);
      if (row.auto_publish_locked && !options.bypassAutoLock) throw new AppError('TASK_LOCKED', '当前 SKU 正由自动上品流程处理，暂不能人工修改', { sku }, 409);
      if (['SUBMITTING', 'QUEUED', 'RUNNING', 'NEEDS_ATTENTION'].includes(row.status)) throw new AppError('TASK_LOCKED', '当前 SKU 正在上品或等待按原任务人工确认，不能修改草稿', { sku, status: row.status }, 409);
      const patch = draftPatch(parsed.data);
      const previousData = asObject(row.data);
      const grossWeightResolution = readGrossWeightResolution(previousData, sku);
      if (grossWeightResolution) {
        assertManagedPackagingMatches(
          previousData.packaging,
          grossWeightResolution,
          sku,
          '毛重由采购管理/上架预设联动管理；当前包装毛重与联动快照不一致，请重新初始化 WB 上品资料'
        );
      }
      if (grossWeightResolution && Object.hasOwn(patch, 'packaging')) {
        const packagingPatch = asObject(patch.packaging);
        if (Object.hasOwn(packagingPatch, 'grossWeightGrams')) {
          assertManagedGrossWeightMatches(
            packagingPatch.grossWeightGrams,
            grossWeightResolution,
            sku,
            '毛重由采购管理/上架预设联动管理，不能手动修改'
          );
        }
        const nextPackaging = {
          ...asObject(previousData.packaging),
          ...packagingPatch,
          grossWeightGrams: grossWeightResolution.effectiveGrossWeightGrams
        };
        assertManagedPackagingMatches(
          nextPackaging,
          grossWeightResolution,
          sku,
          '毛重由采购管理/上架预设联动管理，不能手动修改'
        );
        patch.packaging = nextPackaging;
      }
      let data = { ...previousData, ...patch };
      if (Object.hasOwn(patch, 'variants') && Array.isArray(data.variants)) {
        data.variants = data.variants.map((variantInput) => {
          const variant = asObject(variantInput);
          return {
            ...variant,
            ...(Object.hasOwn(variant, 'descriptionRu')
              ? { descriptionRu: normalizeWbDescription(String(variant.descriptionRu || '')) }
              : {})
          };
        });
      }
      if (Object.hasOwn(patch, 'descriptionRu')) {
        const previousDescription = normalizeWbDescription(String(previousData.descriptionRu || ''));
        data.descriptionRu = normalizeWbDescription(String(data.descriptionRu || ''));
        const initialization = asObject(data.initialization);
        const provenance = parsed.data.descriptionProvenance;
        if (data.descriptionRu !== previousDescription || provenance) {
          const description = {
            type: provenance?.type || 'USER_EDIT',
            ...(provenance?.fileName ? { fileName: provenance.fileName } : {}),
            sha256: provenance?.sha256 || createHash('sha256').update(String(data.descriptionRu)).digest('hex'),
            importedAt: new Date().toISOString()
          };
          const issues = Array.isArray(initialization.issues)
            ? initialization.issues.filter((issue) => asObject(issue).field !== 'descriptionRu')
            : [];
          data.initialization = { ...initialization, description, issues };
          data.initializationIssues = issues;
        }
      }
      const resolvedInitializationFields = new Set<string>();
      if (Object.hasOwn(patch, 'titleRu') && String(data.titleRu || '').trim()) resolvedInitializationFields.add('titleRu');
      if (Object.hasOwn(patch, 'priceCny') && Number(data.priceCny) > 0) resolvedInitializationFields.add('priceCny');
      if (Object.hasOwn(patch, 'descriptionRu') && String(data.descriptionRu || '').trim()) resolvedInitializationFields.add('descriptionRu');
      if (Object.hasOwn(patch, 'variants') && Array.isArray(data.variants)) {
        for (const variantInput of data.variants) {
          const variant = asObject(variantInput);
          if (String(variant.productVariantId || '') && String(variant.descriptionRu || '').trim()) {
            resolvedInitializationFields.add(`variants.${String(variant.productVariantId)}.descriptionRu`);
          }
        }
      }
      if (resolvedInitializationFields.size) {
        const initialization = asObject(data.initialization);
        const issues = Array.isArray(initialization.issues)
          ? initialization.issues.filter((issue) => {
              const detail = asObject(issue);
              return !(detail.retryable === true && resolvedInitializationFields.has(String(detail.field || '')));
            })
          : [];
        data.initialization = { ...initialization, issues };
        data.initializationIssues = issues;
      }
      const categoryKey = parsed.data.categoryKey ?? row.category_key ?? null;
      const categoryVersionId = parsed.data.categoryVersionId ?? row.category_version_id ?? null;
      const categoryVersion = categoryVersionId
        ? await requirePublishedCategoryVersion(client, categoryKey, categoryVersionId)
        : undefined;
      const tnvedPolicy = categoryVersion
        ? resolveWbTnvedPolicy(categoryVersion.form_config, categoryVersion.live_schema)
        : { characteristicId: null, supported: false, required: false };
      const compliance = asObject(data.compliance);
      const tnved = String(compliance.tnved || '').trim();
      if (!tnvedPolicy.supported && tnved) {
        throw new AppError('CONFIG_INVALID', '当前 WB 类目不使用 TNVED，请清空该字段', { categoryKey, tnved }, 409);
      }
      if (!tnved) {
        data.compliance = { tnved: '', kizMarked: false };
        if (tnvedPolicy.characteristicId) {
          data.sharedCharacteristics = withoutCharacteristic(data.sharedCharacteristics, tnvedPolicy.characteristicId);
          data.variants = Array.isArray(data.variants) ? data.variants.map((variantInput) => {
            const variant = asObject(variantInput);
            return { ...variant, characteristics: withoutCharacteristic(variant.characteristics, tnvedPolicy.characteristicId!) };
          }) : data.variants;
        }
      }
      const purchaseMeasurements = await loadLatestPurchaseMeasurementProjection(
        client,
        sku,
        categoryVersion?.form_config ?? { fields: [] },
        categoryVersion?.live_schema ?? []
      );
      data = applyWbPurchaseMeasurementProjection(data, purchaseMeasurements);
      const variantMedia = parsed.data.variantMedia ?? row.variant_media ?? [];
      validateDraftRelations(data, row.media_assets || [], variantMedia);
      const nextStatus = row.generated_version_id ? 'STALE' : 'DRAFT';
      const operationSource: WbListingOperationSource = options.bypassAutoLock ? 'AUTOMATION' : 'MANUAL';
      await client.query(`UPDATE wb_listing_drafts SET data=$2::jsonb,variant_media=$3::jsonb,category_key=$4,category_version_id=$5,
        draft_version=draft_version+1,status=$6,n8n_task_id=NULL,last_error=NULL,
        latest_operation_source=$7,latest_operation_at=NOW(),latest_operation_ref=$8,updated_at=NOW() WHERE sku=$1`, [
        sku, JSON.stringify(data), JSON.stringify(variantMedia), categoryKey, categoryVersionId, nextStatus,
        operationSource, options.operationRef || (options.bypassAutoLock ? 'automation:update' : `manual:save:${Number(row.draft_version) + 1}`)
      ]);
      return getListingWith(client, sku);
    });
  }

  async replaceMediaAssets(skuInput: string, assets: WbMediaAsset[], options: { bypassAutoLock?: boolean } = {}) {
    const sku = normalizeSku(skuInput);
    return this.transaction(async (client) => {
      const locked = await client.query<SqlRow>('SELECT * FROM wb_listing_drafts WHERE sku=$1 FOR UPDATE', [sku]);
      const row = locked.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'WB 上品草稿不存在', { sku }, 404);
      if (row.auto_publish_locked && !options.bypassAutoLock) throw new AppError('TASK_LOCKED', '当前 SKU 正由自动上品流程处理，暂不能重新扫描媒体', { sku }, 409);
      if (['SUBMITTING', 'QUEUED', 'RUNNING', 'NEEDS_ATTENTION'].includes(row.status)) throw new AppError('TASK_LOCKED', '当前 SKU 正在上品或等待按原任务人工确认，不能重新扫描媒体', { sku }, 409);
      const changed = stableJson(row.media_assets || []) !== stableJson(assets);
      const staleAssignments = referencedAssetIds(row.variant_media || []).filter((id) => !assets.some((asset) => asset.assetId === id));
      const nextStatus = changed && row.generated_version_id ? 'STALE' : row.status;
      await client.query(`UPDATE wb_listing_drafts SET media_assets=$2::jsonb,draft_version=draft_version+$3,status=$4,
        last_error=$5,updated_at=NOW() WHERE sku=$1`, [sku, JSON.stringify(assets), changed ? 1 : 0, nextStatus,
        staleAssignments.length ? `已分配的媒体文件已失效：${staleAssignments.join(', ')}` : null]);
      return getListingWith(client, sku);
    });
  }

  async getMediaAsset(skuInput: string, assetId: string): Promise<WbMediaAsset> {
    const listing = await this.getListing(skuInput);
    const asset = (listing.mediaAssets as WbMediaAsset[]).find((item) => item.assetId === assetId);
    if (!asset) throw new AppError('NOT_FOUND', '媒体资产不存在或已失效', { assetId }, 404);
    return asset;
  }

  async listCategories() {
    const rows = await this.query<SqlRow>(`${categorySummarySelect()} ORDER BY t.updated_at DESC`);
    return rows.rows.map(toCategorySummary);
  }

  async assertCategoryDeletable(categoryKeyInput: string) {
    const categoryKey = parseCategoryKey(categoryKeyInput);
    return this.transaction(async (client) => {
      const template = await client.query<SqlRow>(`${categorySummarySelect()} WHERE t.category_key=$1 FOR SHARE OF t`, [categoryKey]);
      if (!template.rows[0]) throw new AppError('NOT_FOUND', 'WB 类目模板不存在', { categoryKey }, 404);
      await assertNoCategoryReferences(client, template.rows[0].id, categoryKey);
      return toCategorySummary(template.rows[0]);
    });
  }

  async deleteCategory(categoryKeyInput: string) {
    const categoryKey = parseCategoryKey(categoryKeyInput);
    return this.transaction(async (client) => {
      const template = await client.query<SqlRow>(`${categorySummarySelect()} WHERE t.category_key=$1 FOR UPDATE OF t`, [categoryKey]);
      const row = template.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'WB 类目模板不存在', { categoryKey }, 404);
      await assertNoCategoryReferences(client, row.id, categoryKey);
      await client.query('DELETE FROM wb_category_template_versions WHERE template_id=$1', [row.id]);
      await client.query('DELETE FROM wb_category_templates WHERE id=$1', [row.id]);
      return { categoryKey, nameRu: row.name_ru, nameZh: row.name_zh || '', subjectId: Number(row.subject_id) };
    });
  }

  async getCategory(categoryKeyInput: string) {
    const categoryKey = parseCategoryKey(categoryKeyInput);
    const template = await this.query<SqlRow>(`${categorySummarySelect()} WHERE t.category_key=$1`, [categoryKey]);
    if (!template.rows[0]) throw new AppError('NOT_FOUND', 'WB 类目模板不存在', { categoryKey }, 404);
    const versions = await this.query<SqlRow>('SELECT * FROM wb_category_template_versions WHERE template_id=$1 ORDER BY version_no DESC', [template.rows[0].id]);
    return { ...toCategorySummary(template.rows[0]), versions: versions.rows.map(toCategoryVersion) };
  }

  async createCategory(categoryKeyInput: string, input: unknown) {
    const categoryKey = parseCategoryKey(categoryKeyInput);
    const definition = parseCategoryDraft(input);
    const derived = deriveCategoryVersion(definition);
    return this.transaction(async (client) => {
      const id = randomUUID();
      await client.query('INSERT INTO wb_category_templates(id,category_key,name_ru,name_zh,subject_id) VALUES($1,$2,$3,$4,$5)', [id, categoryKey, definition.nameRu, definition.nameZh, definition.subjectId]);
      await client.query(`INSERT INTO wb_category_template_versions(id,template_id,version_no,status,name_ru,name_zh,subject_id,live_schema,form_config,managed_characteristic_ids,schema_hash)
        VALUES($1,$2,1,'DRAFT',$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9)`, [
        randomUUID(), id, definition.nameRu, definition.nameZh, definition.subjectId, JSON.stringify(derived.liveSchema), JSON.stringify(derived.formConfig), JSON.stringify(derived.managedCharacteristicIds), derived.schemaHash
      ]);
      await client.query(`INSERT INTO wb_category_projection_state(category_key,status) VALUES($1,'NOT_SYNCED')`, [categoryKey]);
      return getCategoryWith(client, categoryKey);
    }).catch((error: any) => {
      if (error?.code === '23505') throw new AppError('CONFIG_INVALID', '类目 Key 已存在', { categoryKey }, 409);
      throw error;
    });
  }

  async saveCategoryDraft(categoryKeyInput: string, input: unknown) {
    const categoryKey = parseCategoryKey(categoryKeyInput);
    const definition = parseCategoryDraft(input);
    const derived = deriveCategoryVersion(definition);
    return this.transaction(async (client) => {
      const template = await client.query<SqlRow>('SELECT * FROM wb_category_templates WHERE category_key=$1 FOR UPDATE', [categoryKey]);
      if (!template.rows[0]) throw new AppError('NOT_FOUND', 'WB 类目模板不存在', { categoryKey }, 404);
      let draft = await client.query<SqlRow>("SELECT * FROM wb_category_template_versions WHERE template_id=$1 AND status='DRAFT' FOR UPDATE", [template.rows[0].id]);
      if (!draft.rows[0]) {
        const next = await client.query<{ version_no: number }>('SELECT COALESCE(MAX(version_no),0)+1 version_no FROM wb_category_template_versions WHERE template_id=$1', [template.rows[0].id]);
        const id = randomUUID();
        await client.query(`INSERT INTO wb_category_template_versions(id,template_id,version_no,status,name_ru,name_zh,subject_id,live_schema,form_config,managed_characteristic_ids,schema_hash)
          VALUES($1,$2,$3,'DRAFT',$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10)`, [
          id, template.rows[0].id, Number(next.rows[0]!.version_no), definition.nameRu, definition.nameZh, definition.subjectId,
          JSON.stringify(derived.liveSchema), JSON.stringify(derived.formConfig), JSON.stringify(derived.managedCharacteristicIds), derived.schemaHash
        ]);
        draft = await client.query('SELECT * FROM wb_category_template_versions WHERE id=$1', [id]);
      } else {
        await client.query(`UPDATE wb_category_template_versions SET name_ru=$2,name_zh=$3,subject_id=$4,live_schema=$5::jsonb,form_config=$6::jsonb,
          managed_characteristic_ids=$7::jsonb,schema_hash=$8,confirmed_by=NULL,confirmed_at=NULL,updated_at=NOW() WHERE id=$1`, [
          draft.rows[0].id, definition.nameRu, definition.nameZh, definition.subjectId, JSON.stringify(derived.liveSchema), JSON.stringify(derived.formConfig), JSON.stringify(derived.managedCharacteristicIds), derived.schemaHash
        ]);
      }
      await client.query('UPDATE wb_category_templates SET name_ru=$2,name_zh=$3,subject_id=$4,updated_at=NOW() WHERE id=$1', [template.rows[0].id, definition.nameRu, definition.nameZh, definition.subjectId]);
      await client.query(`UPDATE wb_category_projection_state SET status='NOT_SYNCED',last_error=NULL,updated_at=NOW() WHERE category_key=$1`, [categoryKey]);
      return getCategoryWith(client, categoryKey);
    });
  }

  async publishCategory(categoryKeyInput: string, confirmedByInput: string) {
    const categoryKey = parseCategoryKey(categoryKeyInput);
    const confirmedBy = String(confirmedByInput || '').trim();
    if (!confirmedBy) throw new AppError('CONFIG_INVALID', '发布类目模板前必须填写复核人');
    return this.transaction(async (client) => {
      const template = await client.query<SqlRow>('SELECT * FROM wb_category_templates WHERE category_key=$1 FOR UPDATE', [categoryKey]);
      if (!template.rows[0]) throw new AppError('NOT_FOUND', 'WB 类目模板不存在', { categoryKey }, 404);
      const draft = await client.query<SqlRow>("SELECT * FROM wb_category_template_versions WHERE template_id=$1 AND status='DRAFT' FOR UPDATE", [template.rows[0].id]);
      if (!draft.rows[0]) throw new AppError('CONFIG_INVALID', '没有可发布的类目草稿', { categoryKey }, 409);
      if (!Array.isArray(draft.rows[0].managed_characteristic_ids) || !draft.rows[0].managed_characteristic_ids.length) {
        throw new AppError('CONFIG_INVALID', '类目模板至少需要一个已配置的 characteristic 字段', { categoryKey }, 409);
      }
      if (!Array.isArray(draft.rows[0].live_schema) || !draft.rows[0].live_schema.length) {
        throw new AppError('CONFIG_INVALID', '发布类目模板前必须先从 WB 刷新 live schema', { categoryKey }, 409);
      }
      await client.query("UPDATE wb_category_template_versions SET status='ARCHIVED',updated_at=NOW() WHERE template_id=$1 AND status='PUBLISHED'", [template.rows[0].id]);
      await client.query(`UPDATE wb_category_template_versions SET status='PUBLISHED',confirmed_by=$2,confirmed_at=NOW(),published_at=NOW(),updated_at=NOW() WHERE id=$1`, [draft.rows[0].id, confirmedBy]);
      await client.query(`UPDATE wb_category_projection_state SET status='NOT_SYNCED',source_version_id=$2,schema_hash=$3,definition_hash=NULL,last_error=NULL,updated_at=NOW() WHERE category_key=$1`, [categoryKey, draft.rows[0].id, draft.rows[0].schema_hash]);
      return getCategoryWith(client, categoryKey);
    });
  }

  async getPublishedCategory(categoryKeyInput: string) {
    const categoryKey = parseCategoryKey(categoryKeyInput);
    const row = await this.query<SqlRow>(`SELECT t.category_key,v.* FROM wb_category_templates t
      JOIN wb_category_template_versions v ON v.template_id=t.id AND v.status='PUBLISHED' WHERE t.category_key=$1 AND t.active=true`, [categoryKey]);
    if (!row.rows[0]) throw new AppError('CONFIG_INVALID', 'WB 类目尚未发布或已停用', { categoryKey }, 409);
    return toPublishedCategory(row.rows[0]);
  }

  async setProjection(categoryKeyInput: string, input: { status: WbProjectionStatus; sourceVersionId?: string; schemaHash?: string; definitionHash?: string; lastError?: string; syncedAt?: string }) {
    const categoryKey = parseCategoryKey(categoryKeyInput);
    await this.query(`INSERT INTO wb_category_projection_state(category_key,status,source_version_id,schema_hash,definition_hash,last_error,synced_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,NOW()) ON CONFLICT(category_key) DO UPDATE SET status=EXCLUDED.status,source_version_id=EXCLUDED.source_version_id,
      schema_hash=EXCLUDED.schema_hash,definition_hash=EXCLUDED.definition_hash,last_error=EXCLUDED.last_error,synced_at=EXCLUDED.synced_at,updated_at=NOW()`, [
      categoryKey, input.status, input.sourceVersionId || null, input.schemaHash || null, input.definitionHash || null, input.lastError || null, input.syncedAt || null
    ]);
    return this.getCategory(categoryKey);
  }

  async reserveGeneration(skuInput: string, draftVersion: number, options: { bypassAutoLock?: boolean; operationRef?: string } = {}) {
    const sku = normalizeSku(skuInput);
    return this.transaction(async (client) => {
      const listing = await client.query<SqlRow>('SELECT d.*,p.product_name FROM wb_listing_drafts d JOIN products p ON p.sku=d.sku WHERE d.sku=$1 FOR UPDATE OF d', [sku]);
      const row = listing.rows[0];
      if (!row) throw new AppError('NOT_FOUND', 'WB 上品草稿不存在', { sku }, 404);
      assertDraftVersion(row, draftVersion);
      if (row.auto_publish_locked && !options.bypassAutoLock) throw new AppError('TASK_LOCKED', '当前 SKU 正由自动上品流程处理，暂不能人工生成 product.json', { sku }, 409);
      if (['QUEUED', 'RUNNING', 'GENERATING', 'SUBMITTING', 'NEEDS_ATTENTION'].includes(row.status)) throw new AppError('TASK_LOCKED', '当前 SKU 正在处理或等待按原任务人工确认，不能重复生成 product.json', { sku, status: row.status }, 409);
      if (!row.category_key || !row.category_version_id) throw new AppError('CONFIG_INVALID', '请选择已发布的 WB 类目模板');
      const grossWeightResolution = readGrossWeightResolution(row.data, sku);
      if (grossWeightResolution) {
        assertManagedPackagingMatches(
          asObject(row.data).packaging,
          grossWeightResolution,
          sku,
          '毛重由采购管理/上架预设联动管理；当前包装毛重与联动快照不一致，不能生成 product.json'
        );
      }
      const category = await requirePublishedCategoryVersion(client, row.category_key, row.category_version_id);
      const purchaseMeasurements = await loadLatestPurchaseMeasurementProjection(
        client,
        sku,
        category.form_config,
        category.live_schema
      );
      const data = applyWbPurchaseMeasurementProjection(row.data, purchaseMeasurements);
      const revisionResult = await client.query<{ revision: number }>('SELECT COALESCE(MAX(revision),0)+1 revision FROM wb_listing_versions WHERE sku=$1', [sku]);
      const revision = Number(revisionResult.rows[0]!.revision);
      const versionId = randomUUID();
      const mediaManifest = { assets: row.media_assets || [], variantMedia: row.variant_media || [] };
      const materialPresetDefinitionHash = wbMaterialPresetDefinitionHashFromListingData(data);
      await client.query(`INSERT INTO wb_listing_versions(id,sku,revision,status,category_version_id,product_json,media_manifest,purchase_measurements,material_preset_definition_hash)
        VALUES($1,$2,$3,'GENERATING',$4,'{}'::jsonb,$5::jsonb,$6::jsonb,$7)`, [
        versionId,
        sku,
        revision,
        row.category_version_id,
        JSON.stringify(mediaManifest),
        JSON.stringify(purchaseMeasurements.snapshot),
        materialPresetDefinitionHash || null
      ]);
      const operationSource: WbListingOperationSource = options.bypassAutoLock ? 'AUTOMATION' : 'MANUAL';
      await client.query(`UPDATE wb_listing_drafts SET data=$2::jsonb,status='GENERATING',n8n_task_id=NULL,last_error=NULL,
        latest_operation_source=$3,latest_operation_at=NOW(),latest_operation_ref=$4,updated_at=NOW() WHERE sku=$1`, [
        sku,
        JSON.stringify(data),
        operationSource,
        options.operationRef || (options.bypassAutoLock ? `automation:generate:${versionId}` : `manual:generate:${versionId}`)
      ]);
      return {
        versionId, revision, sku, productName: row.product_name, draftVersion: Number(row.draft_version),
        category: toPublishedCategory(category), data, mediaAssets: row.media_assets || [], variantMedia: row.variant_media || []
      };
    });
  }

  async completeGeneration(skuInput: string, versionId: string, productJson: unknown, mediaManifest: unknown) {
    const sku = normalizeSku(skuInput);
    return this.transaction(async (client) => {
      const version = await client.query<SqlRow>("SELECT * FROM wb_listing_versions WHERE id=$1 AND sku=$2 AND status='GENERATING' FOR UPDATE", [versionId, sku]);
      if (!version.rows[0]) throw new AppError('TASK_LOCKED', '生成预留版本不存在或状态已变更', { sku, versionId }, 409);
      await client.query(`UPDATE wb_listing_versions SET status='GENERATED',product_json=$2::jsonb,media_manifest=$3::jsonb,generated_at=NOW(),updated_at=NOW() WHERE id=$1`, [versionId, JSON.stringify(productJson), JSON.stringify(mediaManifest)]);
      await client.query(`UPDATE wb_listing_drafts SET status='GENERATED',generated_version_id=$2,generated_at=NOW(),last_error=NULL,updated_at=NOW() WHERE sku=$1`, [sku, versionId]);
      return getListingWith(client, sku);
    });
  }

  async failGeneration(skuInput: string, versionId: string, message: string): Promise<void> {
    const sku = normalizeSku(skuInput);
    await this.transaction(async (client) => {
      await client.query("UPDATE wb_listing_versions SET status='FAILED',error_message=$2,updated_at=NOW() WHERE id=$1 AND status='GENERATING'", [versionId, message]);
      await client.query("UPDATE wb_listing_drafts SET status=CASE WHEN generated_version_id IS NULL THEN 'DRAFT' ELSE 'STALE' END,last_error=$2,updated_at=NOW() WHERE sku=$1", [sku, message]);
    });
  }

  async getGeneratedPackageContext(skuInput: string, versionIdInput: string): Promise<WbGeneratedPackageContext> {
    const sku = normalizeSku(skuInput);
    const versionId = String(versionIdInput || '').trim();
    if (!/^[a-f0-9-]{36}$/i.test(versionId)) {
      throw new AppError('CONFIG_INVALID', 'WB generatedVersionId 必须是 UUID', { sku, generatedVersionId: versionIdInput }, 409);
    }
    const result = await this.query<SqlRow>(`SELECT v.id version_id,v.sku,v.revision,v.status version_status,v.product_json,v.media_manifest,
      v.generation_scope,v.materialization_hash,
      d.status draft_status,d.generated_version_id current_version_id
      FROM wb_listing_versions v JOIN wb_listing_drafts d ON d.sku=v.sku
      WHERE v.id=$1 AND v.sku=$2`, [versionId, sku]);
    const row = result.rows[0];
    if (!row) throw new AppError('NOT_FOUND', 'WB 已生成版本不存在或不属于该 SKU', { sku, generatedVersionId: versionId }, 404);
    return {
      sku: String(row.sku),
      versionId: String(row.version_id),
      revision: Number(row.revision),
      versionStatus: String(row.version_status),
      draftStatus: String(row.draft_status),
      currentVersionId: String(row.current_version_id || ''),
      productJson: row.product_json,
      mediaManifest: row.media_manifest,
      generationScope: row.generation_scope === 'STORE_PUBLICATION' ? 'STORE_PUBLICATION' : 'LISTING',
      ...(row.materialization_hash ? { materializationHash: String(row.materialization_hash) } : {})
    };
  }

  async beginSubmit(skuInput: string, draftVersion: number, options: { bypassAutoLock?: boolean; operationRef?: string } = {}) {
    const sku = normalizeSku(skuInput);
    const context = await this.transaction(async (client) => {
      const result = await client.query<SqlRow>(`SELECT d.*,v.revision,v.product_json,v.media_manifest,v.purchase_measurements,v.id version_id,v.status version_status,p.status projection_status,
        p.source_version_id,p.schema_hash projection_schema_hash,p.definition_hash,cv.schema_hash category_schema_hash,
        cv.form_config,cv.live_schema FROM wb_listing_drafts d
        JOIN wb_listing_versions v ON v.id=d.generated_version_id
        JOIN wb_category_template_versions cv ON cv.id=d.category_version_id
        LEFT JOIN wb_category_projection_state p ON p.category_key=d.category_key WHERE d.sku=$1 FOR UPDATE OF d,v`, [sku]);
      const row = result.rows[0];
      if (!row) throw new AppError('CONFIG_INVALID', '当前 SKU 尚未生成 product.json', { sku }, 409);
      assertDraftVersion(row, draftVersion);
      if (row.auto_publish_locked && !options.bypassAutoLock) throw new AppError('TASK_LOCKED', '当前 SKU 正由自动上品流程处理，暂不能人工提交', { sku }, 409);
      if (row.status === 'SUBMITTING') throw new AppError('TASK_LOCKED', '任务接收结果正在确认，请勿重复提交', { sku, status: row.status }, 409);
      if (['QUEUED', 'RUNNING'].includes(row.status)) throw new AppError('TASK_LOCKED', '任务已经提交，请勿重复提交', { sku, status: row.status }, 409);
      if (row.status !== 'GENERATED' || row.version_status !== 'GENERATED') throw new AppError('CONFIG_INVALID', '请先生成最新且未过期的 product.json', { sku, status: row.status }, 409);
      if (row.projection_status !== 'SYNCED' || row.source_version_id !== row.category_version_id || row.projection_schema_hash !== row.category_schema_hash || !row.definition_hash) {
        throw new AppError('CONFIG_INVALID', 'WB 类目模板尚未同步到 n8n，或版本/哈希不一致', {
          sku, projectionStatus: row.projection_status, projectionVersionId: row.source_version_id,
          categoryVersionId: row.category_version_id, projectionSchemaHash: row.projection_schema_hash,
          categorySchemaHash: row.category_schema_hash, definitionHash: row.definition_hash
        }, 409);
      }
      const currentMeasurements = await loadLatestPurchaseMeasurementProjection(
        client,
        sku,
        row.form_config,
        row.live_schema
      );
      if (!sameWbPurchaseMeasurementValues(row.purchase_measurements, currentMeasurements.snapshot, row.form_config)) {
        const message = '采购管理中的产品尺寸或净重已变化，请重新生成 product.json';
        await client.query(`UPDATE wb_listing_drafts SET status='STALE',last_error=$2,updated_at=NOW()
          WHERE sku=$1 AND generated_version_id=$3`, [sku, message, row.version_id]);
        return {
          purchaseMeasurementDrift: true as const,
          message,
          generated: row.purchase_measurements,
          current: currentMeasurements.snapshot
        };
      }
      await client.query("UPDATE wb_listing_versions SET status='SUBMITTING',error_message=NULL,network_recovery='{}'::jsonb,network_next_attempt_at=NULL,updated_at=NOW() WHERE id=$1", [row.version_id]);
      const operationSource: WbListingOperationSource = options.bypassAutoLock ? 'AUTOMATION' : 'MANUAL';
      await client.query(`UPDATE wb_listing_drafts SET status='SUBMITTING',last_error=NULL,network_recovery='{}'::jsonb,network_next_attempt_at=NULL,
        latest_operation_source=$2,latest_operation_at=NOW(),latest_operation_ref=$3,updated_at=NOW() WHERE sku=$1`, [
        sku, operationSource, options.operationRef || (options.bypassAutoLock ? `automation:submit:${row.version_id}` : `manual:submit:${row.version_id}`)
      ]);
      return {
        sku, versionId: row.version_id, revision: Number(row.revision), expectedTaskId: `${sku}__r${Number(row.revision)}`,
        productJson: row.product_json, mediaManifest: row.media_manifest
      };
    });
    if ('purchaseMeasurementDrift' in context) {
      throw new AppError('VERSION_CONFLICT', String(context.message), {
        sku,
        generatedPurchaseMeasurements: context.generated,
        currentPurchaseMeasurements: context.current
      }, 409);
    }
    return context;
  }

  async markQueued(skuInput: string, versionId: string, task: {
    taskId: string;
    raw?: unknown;
    automationContext?: { runId: string; runNo: number; operationMode: 'CREATE_ONLY' | 'COMPATIBLE_UPSERT' };
  }) {
    const sku = normalizeSku(skuInput);
    return this.transaction(async (client) => {
      const changed = await client.query(`UPDATE wb_listing_versions SET status='QUEUED',n8n_task_id=$2,result_json=$3::jsonb,
        network_recovery='{}'::jsonb,network_next_attempt_at=NULL,
        automation_context=COALESCE($4::jsonb,automation_context),submitted_at=NOW(),updated_at=NOW()
        WHERE id=$1 AND status='SUBMITTING'`, [versionId, task.taskId, JSON.stringify(task.raw ?? {}), task.automationContext ? JSON.stringify(task.automationContext) : null]);
      if (!changed.rowCount) throw new AppError('VERSION_CONFLICT', '提交状态已变化，不能标记为 QUEUED', { sku, versionId }, 409);
      await client.query(`UPDATE wb_listing_drafts SET status='QUEUED',n8n_task_id=$2,submitted_at=NOW(),last_error=NULL,
        network_recovery='{}'::jsonb,network_next_attempt_at=NULL,updated_at=NOW()
        WHERE sku=$1 AND generated_version_id=$3 AND status='SUBMITTING'`, [sku, task.taskId, versionId]);
      return getListingWith(client, sku);
    });
  }

  async recordSubmitFailure(skuInput: string, versionId: string, message: string, input: {
    deliveryUnknown: boolean;
    expectedTaskId: string;
    networkRecovery?: WbNetworkRecovery;
  }) {
    const sku = normalizeSku(skuInput);
    return this.transaction(async (client) => {
      const nextStatus = input.deliveryUnknown ? 'SUBMITTING' : 'GENERATED';
      const taskId = input.deliveryUnknown ? input.expectedTaskId : null;
      const networkRecovery = input.deliveryUnknown && input.networkRecovery ? input.networkRecovery : undefined;
      await client.query(`UPDATE wb_listing_versions SET status=$3,n8n_task_id=$4,error_message=$5,
        network_recovery=$6::jsonb,network_next_attempt_at=$7,
        submitted_at=CASE WHEN $3='SUBMITTING' THEN COALESCE(submitted_at,NOW()) ELSE NULL END,updated_at=NOW()
        WHERE id=$1 AND sku=$2 AND status='SUBMITTING'`, [versionId, sku, nextStatus, taskId, message,
        JSON.stringify(networkRecovery || {}), networkRecovery?.nextAttemptAt || null]);
      await client.query(`UPDATE wb_listing_drafts SET status=$3,n8n_task_id=$4,last_error=$5,
        network_recovery=$6::jsonb,network_next_attempt_at=$7,
        submitted_at=CASE WHEN $3='SUBMITTING' THEN COALESCE(submitted_at,NOW()) ELSE NULL END,updated_at=NOW()
        WHERE sku=$1 AND generated_version_id=$2 AND status='SUBMITTING'`, [sku, versionId, nextStatus, taskId, message,
        JSON.stringify(networkRecovery || {}), networkRecovery?.nextAttemptAt || null]);
      return getListingWith(client, sku);
    });
  }

  async recordTaskNetworkRecovery(skuInput: string, taskId: string, recovery: WbNetworkRecovery) {
    const sku = normalizeSku(skuInput);
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>(`SELECT generated_version_id,status,n8n_task_id
        FROM wb_listing_drafts WHERE sku=$1 FOR UPDATE`, [sku]);
      const row = current.rows[0];
      if (!row || String(row.n8n_task_id || '') !== taskId || !['SUBMITTING', 'QUEUED', 'RUNNING'].includes(String(row.status || ''))) {
        throw new AppError('TASK_LOCKED', 'WB 上品任务身份或状态已变化，不能覆盖网络恢复检查点', { sku, taskId, status: row?.status }, 409);
      }
      await client.query(`UPDATE wb_listing_versions SET network_recovery=$2::jsonb,network_next_attempt_at=$3,error_message=$4,updated_at=NOW()
        WHERE id=$1`, [row.generated_version_id, JSON.stringify(recovery), recovery.nextAttemptAt, recovery.lastErrorMessage]);
      await client.query(`UPDATE wb_listing_drafts SET network_recovery=$3::jsonb,network_next_attempt_at=$4,last_error=$5,updated_at=NOW()
        WHERE sku=$1 AND n8n_task_id=$2`, [sku, taskId, JSON.stringify(recovery), recovery.nextAttemptAt, recovery.lastErrorMessage]);
      return getListingWith(client, sku);
    });
  }

  async markTaskNeedsAttention(skuInput: string, taskId: string, recovery: WbNetworkRecovery, message: string) {
    const sku = normalizeSku(skuInput);
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>(`SELECT generated_version_id,status,n8n_task_id
        FROM wb_listing_drafts WHERE sku=$1 FOR UPDATE`, [sku]);
      const row = current.rows[0];
      if (!row || String(row.n8n_task_id || '') !== taskId || !['SUBMITTING', 'QUEUED', 'RUNNING'].includes(String(row.status || ''))) {
        throw new AppError('TASK_LOCKED', 'WB 上品任务身份或状态已变化，不能转人工兜底', { sku, taskId, status: row?.status }, 409);
      }
      await client.query(`UPDATE wb_listing_versions SET status='NEEDS_ATTENTION',network_recovery=$2::jsonb,
        network_next_attempt_at=NULL,error_message=$3,terminal_notification_pending=true,
        terminal_notification_delivered_at=NULL,completed_at=NOW(),updated_at=NOW() WHERE id=$1`, [
        row.generated_version_id, JSON.stringify(recovery), message
      ]);
      await client.query(`UPDATE wb_listing_drafts SET status='NEEDS_ATTENTION',network_recovery=$3::jsonb,
        network_next_attempt_at=NULL,last_error=$4,updated_at=NOW() WHERE sku=$1 AND n8n_task_id=$2`, [
        sku, taskId, JSON.stringify(recovery), message
      ]);
      return getListingWith(client, sku);
    });
  }

  async updateTaskStatus(skuInput: string, taskId: string, result: JsonRecord) {
    const sku = normalizeSku(skuInput);
    const normalized = normalizeRemoteStatus(result);
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>('SELECT generated_version_id FROM wb_listing_drafts WHERE sku=$1 AND n8n_task_id=$2 FOR UPDATE', [sku, taskId]);
      if (!current.rows[0]) throw new AppError('NOT_FOUND', 'WB 上品任务不存在', { sku, taskId }, 404);
      // Serialize outcome changes with the external outbox dispatcher. The
      // dispatcher re-reads under the same advisory key, so FAILED→SUCCEEDED
      // can never publish in reverse order across processes.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('merchroute_wb_notification:'||$1,0))", [current.rows[0].generated_version_id]);
      await client.query(`UPDATE wb_listing_versions SET
        terminal_notification_pending=CASE
          WHEN $2 IN ('SUCCEEDED','FAILED','BLOCKED') AND status IS DISTINCT FROM $2 THEN true
          WHEN $2 NOT IN ('SUCCEEDED','FAILED','BLOCKED') THEN false
          ELSE terminal_notification_pending END,
        terminal_notification_delivered_at=CASE
          WHEN $2 IN ('SUCCEEDED','FAILED','BLOCKED') AND status IS DISTINCT FROM $2 THEN NULL
          ELSE terminal_notification_delivered_at END,
        status=$2,result_json=$3::jsonb,error_message=$4,network_recovery='{}'::jsonb,network_next_attempt_at=NULL,
        nm_ids=$5::jsonb,product_urls=$6::jsonb,completed_at=CASE WHEN $2 IN ('SUCCEEDED','FAILED','BLOCKED') THEN NOW() ELSE NULL END,updated_at=NOW()
        WHERE id=$1`, [current.rows[0].generated_version_id, normalized.status, JSON.stringify(result), normalized.errorMessage,
        JSON.stringify(normalized.nmIds), JSON.stringify(normalized.productUrls)]);
      await client.query(`UPDATE wb_listing_drafts SET status=$2,last_error=$3,nm_ids=$4::jsonb,product_urls=$5::jsonb,
        network_recovery='{}'::jsonb,network_next_attempt_at=NULL,updated_at=NOW() WHERE sku=$1`, [
        sku, normalized.status, normalized.errorMessage, JSON.stringify(normalized.nmIds), JSON.stringify(normalized.productUrls)
      ]);
      return getListingWith(client, sku);
    });
  }

  async markAllGeneratedStale(): Promise<number> {
    const result = await this.query("UPDATE wb_listing_drafts SET status='STALE',updated_at=NOW() WHERE status='GENERATED'");
    return result.rowCount || 0;
  }

  async acquireCatalogSyncLock(): Promise<WbCatalogLock | undefined> {
    const client = await this.requirePool().connect();
    try {
      const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext('pixroute_wb_catalog_sync')) locked");
      if (!result.rows[0]?.locked) {
        client.release();
        return undefined;
      }
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          try { await client.query("SELECT pg_advisory_unlock(hashtext('pixroute_wb_catalog_sync'))"); }
          finally { client.release(); }
        }
      };
    } catch (error) {
      client.release();
      throw error;
    }
  }

  async recoverAbandonedCatalogRuns(): Promise<number> {
    const result = await this.query(`UPDATE wb_catalog_sync_runs SET status='FAILED',error_code='WB_SYNC_FAILED',
      error_message='服务重启后确认原同步进程已退出',completed_at=NOW(),heartbeat_at=NOW()
      WHERE status='RUNNING'`);
    return result.rowCount || 0;
  }

  async getRuntimeConfig(): Promise<JsonRecord> {
    const result = await this.query<SqlRow>(`SELECT runtime.*,
      settings.enabled system_enabled,settings.root_directory system_root_directory,
      settings.global_concurrency,settings.per_store_concurrency,settings.row_version system_row_version
      FROM wb_runtime_config runtime JOIN wb_system_settings settings ON settings.settings_id=runtime.config_id
      WHERE runtime.config_id='default'`);
    if (result.rows[0]) return toRuntimeConfigRow(result.rows[0]);
    await this.query("INSERT INTO wb_runtime_config(config_id) VALUES('default') ON CONFLICT(config_id) DO NOTHING");
    const created = await this.query<SqlRow>(`SELECT runtime.*,
      settings.enabled system_enabled,settings.root_directory system_root_directory,
      settings.global_concurrency,settings.per_store_concurrency,settings.row_version system_row_version
      FROM wb_runtime_config runtime JOIN wb_system_settings settings ON settings.settings_id=runtime.config_id
      WHERE runtime.config_id='default'`);
    return toRuntimeConfigRow(created.rows[0] || {});
  }

  async upsertRuntimeConfig(input: JsonRecord): Promise<JsonRecord> {
    const requestedDispatchConcurrency = hasOwn(input, 'dispatch_concurrency')
      ? Number(input.dispatch_concurrency)
      : hasOwn(input, 'dispatchConcurrency') ? Number(input.dispatchConcurrency) : undefined;
    if (requestedDispatchConcurrency !== undefined && (!Number.isInteger(requestedDispatchConcurrency) || requestedDispatchConcurrency < 1 || requestedDispatchConcurrency > 2)) {
      throw new AppError('CONFIG_INVALID', 'WB runtime 全局并发只能设置为 1 或 2', {
        requestedDispatchConcurrency,
        maximumDispatchConcurrency: 2
      }, 409);
    }
    const importRoot = stringOr(input.importRoot, input.import_root, input.rootDirectory, input.root_directory);
    const now = new Date().toISOString();
    const comparableRoot = importRoot ? normalizeWbComparablePath(importRoot) : '';
    const rootSyncHash = comparableRoot ? `sha256:${createHash('sha256').update(comparableRoot, 'utf8').digest('hex')}` : '';
    const current = await this.getRuntimeConfig();
    const merged = {
      ...current,
      ...input,
      config_id: 'default',
      schema_version: numberOr(input.schema_version, current.schema_version, 1),
      config_version: numberOr(input.config_version, current.config_version, 1) + 1,
      publish_enabled: booleanOr(input.publish_enabled, input.enabled, current.publish_enabled, false),
      credential_ready: booleanOr(input.credential_ready, current.credential_ready, false),
      import_root: importRoot || stringOr(current.import_root),
      root_source: importRoot ? 'merchroute-postgresql' : stringOr(current.root_source),
      root_sync_hash: importRoot ? rootSyncHash : stringOr(current.root_sync_hash),
      root_synced_at: importRoot ? now : current.root_synced_at,
      warehouse_id: stringOr(input.warehouse_id, current.warehouse_id),
      timezone: stringOr(input.timezone, current.timezone) || 'Asia/Shanghai',
      dispatch_batch_size: numberOr(input.dispatch_batch_size, current.dispatch_batch_size, 1),
      dispatch_concurrency: requestedDispatchConcurrency ?? numberOr(current.dispatch_concurrency, current.global_concurrency, 1),
      media_batch_size: numberOr(input.media_batch_size, current.media_batch_size, 7),
      media_upload_interval_ms: Math.max(650, numberOr(input.media_upload_interval_ms, current.media_upload_interval_ms, 650)),
      video_optimize_enabled: booleanOr(input.video_optimize_enabled, current.video_optimize_enabled, true),
      video_optimize_threshold_bytes: numberOr(input.video_optimize_threshold_bytes, current.video_optimize_threshold_bytes, 5 * 1024 * 1024),
      video_optimize_target_kbps: numberOr(input.video_optimize_target_kbps, current.video_optimize_target_kbps, 1500),
      video_optimize_maxrate_kbps: numberOr(input.video_optimize_maxrate_kbps, current.video_optimize_maxrate_kbps, 1800),
      lock_ttl_seconds: numberOr(input.lock_ttl_seconds, current.lock_ttl_seconds, 600),
      max_daily_styles: numberOr(input.max_daily_styles, current.max_daily_styles, 100),
      price_currency_expected: stringOr(input.price_currency_expected, current.price_currency_expected) || 'CNY',
      preflight_report_json: typeof input.preflight_report_json === 'string' ? input.preflight_report_json : stringOr(current.preflight_report_json) || '{}',
      updated_at: now
    };
    await this.query(`INSERT INTO wb_runtime_config(
      config_id,schema_version,config_version,publish_enabled,credential_ready,import_root,root_source,root_sync_hash,root_synced_at,
      warehouse_id,timezone,dispatch_batch_size,dispatch_concurrency,media_batch_size,media_upload_interval_ms,video_optimize_enabled,
      video_optimize_threshold_bytes,video_optimize_target_kbps,video_optimize_maxrate_kbps,lock_ttl_seconds,max_daily_styles,
      price_currency_expected,preflight_report_json,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24)
      ON CONFLICT(config_id) DO UPDATE SET
        schema_version=EXCLUDED.schema_version,config_version=EXCLUDED.config_version,publish_enabled=EXCLUDED.publish_enabled,
        credential_ready=EXCLUDED.credential_ready,import_root=EXCLUDED.import_root,root_source=EXCLUDED.root_source,
        root_sync_hash=EXCLUDED.root_sync_hash,root_synced_at=EXCLUDED.root_synced_at,warehouse_id=EXCLUDED.warehouse_id,
        timezone=EXCLUDED.timezone,dispatch_batch_size=EXCLUDED.dispatch_batch_size,dispatch_concurrency=EXCLUDED.dispatch_concurrency,
        media_batch_size=EXCLUDED.media_batch_size,
        media_upload_interval_ms=EXCLUDED.media_upload_interval_ms,video_optimize_enabled=EXCLUDED.video_optimize_enabled,
        video_optimize_threshold_bytes=EXCLUDED.video_optimize_threshold_bytes,video_optimize_target_kbps=EXCLUDED.video_optimize_target_kbps,
        video_optimize_maxrate_kbps=EXCLUDED.video_optimize_maxrate_kbps,lock_ttl_seconds=EXCLUDED.lock_ttl_seconds,
        max_daily_styles=EXCLUDED.max_daily_styles,price_currency_expected=EXCLUDED.price_currency_expected,
        preflight_report_json=EXCLUDED.preflight_report_json,updated_at=EXCLUDED.updated_at`, [
      merged.config_id, merged.schema_version, merged.config_version, merged.publish_enabled, merged.credential_ready,
      merged.import_root, merged.root_source, merged.root_sync_hash, merged.root_synced_at, merged.warehouse_id, merged.timezone,
      merged.dispatch_batch_size, merged.dispatch_concurrency, merged.media_batch_size, merged.media_upload_interval_ms, merged.video_optimize_enabled,
      merged.video_optimize_threshold_bytes, merged.video_optimize_target_kbps, merged.video_optimize_maxrate_kbps,
      merged.lock_ttl_seconds, merged.max_daily_styles, merged.price_currency_expected, merged.preflight_report_json, merged.updated_at
    ]);
    await this.query(`UPDATE wb_system_settings SET enabled=$1,root_directory=$2,timezone=$3,global_concurrency=$4,
      row_version=row_version+1,updated_at=NOW() WHERE settings_id='default'`, [
      merged.publish_enabled, merged.import_root, merged.timezone, merged.dispatch_concurrency
    ]);
    return this.getRuntimeConfig();
  }

  async getRuntimeCategoryProjection(categoryKeyInput: string): Promise<JsonRecord> {
    const categoryKey = parseCategoryKey(categoryKeyInput);
    const result = await this.query<SqlRow>(`SELECT t.category_key,t.active,
      p.id source_version_id,p.version_no template_version,p.name_ru subject_name,p.name_zh subject_name_zh,p.subject_id,
      p.live_schema,p.form_config,p.managed_characteristic_ids,p.schema_hash,p.confirmed_by,p.confirmed_at,
      s.definition_hash,s.status projection_status,s.synced_at,s.last_error projection_error
      FROM wb_category_templates t
      JOIN wb_category_template_versions p ON p.template_id=t.id AND p.status='PUBLISHED'
      LEFT JOIN wb_category_projection_state s ON s.category_key=t.category_key
      WHERE t.category_key=$1 AND t.active=true`, [categoryKey]);
    const row = result.rows[0];
    if (!row) throw new AppError('NOT_FOUND', 'WB 类目模板不存在', { categoryKey }, 404);
    return toRuntimeCategoryProjectionRow(row);
  }

  async listRuntimeJobs(input: WbRuntimeJobListInput = {}): Promise<{ items: JsonRecord[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, Math.trunc(input.page || 1));
    const pageSize = Math.min(100, Math.max(1, Math.trunc(input.pageSize || 20)));
    const values: unknown[] = [];
    const where: string[] = [];
    if (input.taskId) { values.push(input.taskId); where.push(`task_id=$${values.length}`); }
    if (input.productCode) { values.push(String(input.productCode).trim()); where.push(`product_code=$${values.length}`); }
    if (input.storeId) { values.push(String(input.storeId).trim()); where.push(`store_id=$${values.length}::uuid`); }
    if (input.due) where.push(`state NOT IN ('SUCCEEDED','FAILED','NEEDS_ATTENTION','BLOCKED_AUTH','BLOCKED_CONFIG','BLOCKED_SCHEMA','BLOCKED_COMPLIANCE','BLOCKED_EXISTING_CARD') AND (next_run_at IS NULL OR next_run_at<=NOW())`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.query<{ total: string }>(`SELECT COUNT(*)::text total FROM wb_publish_jobs ${whereSql}`, values);
    values.push(pageSize, (page - 1) * pageSize);
    const result = await this.query<SqlRow>(`SELECT * FROM wb_publish_jobs ${whereSql}
      ORDER BY COALESCE(next_run_at,created_at) ASC,priority DESC,created_at ASC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return { items: result.rows.map(toRuntimeJobRow), total: Number(total.rows[0]?.total || 0), page, pageSize };
  }

  async claimRuntimeJobs(input: WbRuntimeJobClaimInput): Promise<JsonRecord[]> {
    const leaseOwner = String(input.leaseOwner || '').trim();
    if (!leaseOwner || leaseOwner.length > 160) throw new AppError('CONFIG_INVALID', 'leaseOwner 必须为 1 到 160 个字符');
    const limit = Math.min(20, Math.max(1, Math.trunc(Number(input.limit) || 1)));
    const leaseSeconds = Math.min(3_600, Math.max(600, Math.trunc(Number(input.leaseSeconds) || 1_800)));
    return this.transaction(async (client) => {
      // Serialize only the short claim transaction. Work continues outside the
      // lock, while PostgreSQL enforces two global slots and one slot per store.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('merchroute_wb_runtime_dispatch_claim'))");
      const config = await client.query<{ enabled: boolean; global_concurrency: number }>(
        "SELECT enabled,global_concurrency FROM wb_system_settings WHERE settings_id='default' FOR SHARE"
      );
      if (!config.rows[0]?.enabled) return [];
      const dispatchConcurrency = Math.min(2, Math.max(1, Number(config.rows[0]?.global_concurrency || 1)));
      const active = await client.query<{ total: string }>(`SELECT COUNT(*)::text total FROM wb_publish_jobs
        WHERE state NOT IN ('SUCCEEDED','FAILED','NEEDS_ATTENTION','BLOCKED_AUTH','BLOCKED_CONFIG','BLOCKED_SCHEMA','BLOCKED_COMPLIANCE','BLOCKED_EXISTING_CARD')
          AND lease_owner<>'' AND lease_expires_at>NOW()`);
      const activeLeases = Number(active.rows[0]?.total || 0);
      const availableSlots = Math.max(0, dispatchConcurrency - activeLeases);
      if (availableSlots === 0) return [];
      const claimLimit = Math.min(limit, availableSlots);
      const claimed = await client.query<SqlRow>(`WITH ranked AS (
          SELECT j.task_id,j.store_id,s.last_dispatched_at,j.state,j.priority,j.next_run_at,j.created_at,
            ROW_NUMBER() OVER(PARTITION BY j.store_id ORDER BY
              CASE WHEN j.state='RETRY_WAIT' THEN 0 WHEN j.state<>'QUEUED' THEN 1 ELSE 2 END,
              j.priority DESC,COALESCE(j.next_run_at,j.created_at),j.created_at,j.task_id) store_rank
          FROM wb_publish_jobs j
          JOIN wb_stores s ON s.id=j.store_id AND s.enabled=true AND s.archived_at IS NULL
          LEFT JOIN wb_store_credential_versions task_credential
            ON task_credential.id=j.credential_version_id AND task_credential.store_id=j.store_id
          LEFT JOIN wb_store_runtime_state runtime ON runtime.store_id=j.store_id
          WHERE j.state NOT IN ('SUCCEEDED','FAILED','NEEDS_ATTENTION','BLOCKED_AUTH','BLOCKED_CONFIG','BLOCKED_SCHEMA','BLOCKED_COMPLIANCE','BLOCKED_EXISTING_CARD')
            AND (j.next_run_at IS NULL OR j.next_run_at<=NOW())
            AND (j.lease_owner='' OR j.lease_expires_at IS NULL OR j.lease_expires_at<=NOW())
            AND (runtime.network_next_attempt_at IS NULL OR runtime.network_next_attempt_at<=NOW())
            AND (
              (s.id=$4::uuid AND s.credential_state='LEGACY_EXTERNAL')
              OR (
                j.credential_version_id IS NOT NULL
                AND task_credential.status IN ('ACTIVE','RETIRED')
                AND j.store_config_version>0
                AND BTRIM(j.warehouse_id)<>''
              )
            )
            AND NOT EXISTS(
              SELECT 1 FROM wb_publish_jobs active_store
              WHERE active_store.store_id=j.store_id AND active_store.task_id<>j.task_id
                AND active_store.state NOT IN ('SUCCEEDED','FAILED','NEEDS_ATTENTION','BLOCKED_AUTH','BLOCKED_CONFIG','BLOCKED_SCHEMA','BLOCKED_COMPLIANCE','BLOCKED_EXISTING_CARD')
                AND active_store.lease_owner<>'' AND active_store.lease_expires_at>NOW()
            )
        ), candidates AS (
          SELECT j.task_id FROM wb_publish_jobs j JOIN ranked r ON r.task_id=j.task_id
          WHERE r.store_rank=1
          ORDER BY COALESCE(r.last_dispatched_at,'epoch'::timestamptz),
            CASE WHEN r.state='RETRY_WAIT' THEN 0 WHEN r.state<>'QUEUED' THEN 1 ELSE 2 END,
            r.priority DESC,COALESCE(r.next_run_at,r.created_at),r.created_at,r.task_id
          FOR UPDATE OF j SKIP LOCKED LIMIT $2
        ), updated AS (
          UPDATE wb_publish_jobs j SET
            lease_owner=$1,
            lease_expires_at=NOW()+($3::text||' seconds')::interval,
            updated_at=NOW(),
            row_version=row_version+1
          FROM candidates c
          WHERE j.task_id=c.task_id
          RETURNING j.*
        )
        SELECT * FROM updated
        ORDER BY store_alias,CASE WHEN state='RETRY_WAIT' THEN 0 WHEN state<>'QUEUED' THEN 1 ELSE 2 END,
          priority DESC,COALESCE(next_run_at,created_at) ASC,created_at ASC`, [leaseOwner, claimLimit, leaseSeconds, WB_DEFAULT_STORE_ID]);
      if (claimed.rows.length) {
        await client.query('UPDATE wb_stores SET last_dispatched_at=NOW(),updated_at=NOW() WHERE id=ANY($1::uuid[])', [
          [...new Set(claimed.rows.map((row) => String(row.store_id)))]
        ]);
      }
      for (const row of claimed.rows) {
        await insertRuntimeEvent(client, String(row.task_id || ''), 'JOB_CLAIMED', String(row.state || ''), String(row.state || ''),
          'WB runtime job 已被执行器原子领取', {
            leaseOwner,
            leaseExpiresAt: isoOrUndefined(row.lease_expires_at),
            dispatchConcurrency,
            activeLeasesBeforeClaim: activeLeases
          });
      }
      return claimed.rows.map(toRuntimeJobRow);
    });
  }

  async getRuntimeJob(taskId: string): Promise<JsonRecord> {
    const result = await this.query<SqlRow>('SELECT * FROM wb_publish_jobs WHERE task_id=$1', [taskId]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'WB runtime job 不存在', { taskId }, 404);
    return toRuntimeJobRow(result.rows[0]);
  }

  async listHistoricalRuntimeNetworkFailureCandidates(limit = 100): Promise<WbHistoricalRuntimeNetworkFailureCandidate[]> {
    const safeLimit = Math.min(500, Math.max(1, Math.trunc(limit) || 100));
    const result = await this.query<SqlRow>(`SELECT * FROM wb_publish_jobs
      WHERE state='FAILED'
        AND (BTRIM(lease_owner)='' OR lease_expires_at IS NULL OR lease_expires_at<=NOW())
        AND (
          UPPER(COALESCE(last_error_code,'')) IN
            ('ETIMEDOUT','ESOCKETTIMEDOUT','ECONNRESET','ECONNABORTED','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','TLS_EOF','HTTP_408','HTTP_429')
          OR UPPER(COALESCE(last_error_code,'')) ~ '(^|_)HTTP_(408|429|5[0-9]{2})$'
          OR UPPER(COALESCE(last_error_message,'')) ~
            '(ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNABORTED|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|SOCKET HANG UP|TLS.*EOF|HTTP[^0-9]*(408|429|5[0-9]{2})|断网|网络(中断|不可用|连接失败|超时))'
        )
      ORDER BY updated_at ASC,task_id ASC LIMIT $1`, [safeLimit]);
    return result.rows.flatMap((row) => {
      const transport = historicalTransportEvidence(row);
      if (!transport) return [];
      const plan = historicalRuntimeRecoveryPlan(row, transport);
      return [{
        kind: 'RUNTIME' as const,
        identity: runtimeHistoricalIdentity(row),
        rowVersion: Number(row.row_version),
        evidence: runtimeHistoricalEvidence(row, transport, plan)
      }];
    });
  }

  async recoverHistoricalRuntimeNetworkFailure(
    taskIdInput: string,
    expected: WbHistoricalRuntimeNetworkFailureCandidate['identity'] & { rowVersion: number }
  ): Promise<WbHistoricalRuntimeNetworkRecoveryResult> {
    const taskId = String(taskIdInput || '').trim();
    const expectedRowVersion = Number(expected?.rowVersion);
    if (!taskId || expected?.taskId !== taskId || !Number.isInteger(expectedRowVersion) || expectedRowVersion < 1) {
      throw new AppError('CONFIG_INVALID', 'runtime 恢复必须携带一致的 taskId 与有效 rowVersion');
    }
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>(`SELECT *,
          (BTRIM(lease_owner)<>'' AND lease_expires_at>NOW()) active_lease
        FROM wb_publish_jobs WHERE task_id=$1 FOR UPDATE`, [taskId]);
      const row = current.rows[0];
      const actualIdentity = row ? runtimeHistoricalIdentity(row) : undefined;
      const conflict = (message: string, details: JsonRecord = {}) => new AppError('VERSION_CONFLICT', message, {
        taskId,
        expectedRowVersion,
        actualRowVersion: row ? Number(row.row_version) : undefined,
        expectedIdentity: expected,
        actualIdentity,
        actualState: row?.state ? String(row.state) : undefined,
        ...details
      }, 409);
      if (!row) throw conflict('WB runtime 历史任务不存在或已被清理');
      if (Number(row.row_version) !== expectedRowVersion) throw conflict('WB runtime 历史任务已变化，拒绝使用过期 rowVersion 恢复');
      if (!sameRuntimeHistoricalIdentity(actualIdentity!, expected)) {
        throw conflict('WB runtime task/revision/idempotency/目录身份已变化，拒绝覆盖');
      }
      if (String(row.state) !== 'FAILED') throw conflict('WB runtime 任务不再是可恢复的 FAILED 状态');
      if (row.active_lease) {
        throw new AppError('TASK_LOCKED', 'WB runtime 历史任务仍持有有效租约，拒绝并发恢复', {
          taskId, leaseOwner: String(row.lease_owner), leaseExpiresAt: isoOrUndefined(row.lease_expires_at),
          rowVersion: Number(row.row_version)
        }, 409);
      }
      const transport = historicalTransportEvidence(row);
      if (!transport) throw conflict('FAILED runtime 记录缺少严格的网络或 HTTP 408/429/5xx 证据');
      const plan = historicalRuntimeRecoveryPlan(row, transport);
      const evidence = runtimeHistoricalEvidence(row, transport, plan);
      if (!plan.recoverable || !plan.safeResumeState) {
        throw new AppError('RECOVERY_UNSAFE', 'WB runtime 历史任务缺少可证明安全的检查点，拒绝盲目重放写请求', {
          taskId, rowVersion: Number(row.row_version), evidence
        }, 409);
      }
      const runtime = parseJsonRecord(row.result_json);
      const previousRecovery = asObject(runtime.networkRecovery);
      const audit = Array.isArray(runtime.audit) ? runtime.audit.map(asObject) : [];
      runtime.networkRecovery = {
        ...previousRecovery,
        active: true,
        phase: plan.phase,
        resumeState: plan.safeResumeState,
        deliveryState: plan.deliveryState,
        attempt: plan.attempt,
        pauseStartedAt: stringOr(previousRecovery.pauseStartedAt, previousRecovery.firstFailureAt, isoOrUndefined(row.updated_at)),
        firstFailureAt: stringOr(previousRecovery.firstFailureAt, previousRecovery.pauseStartedAt, isoOrUndefined(row.updated_at)),
        lastFailureAt: stringOr(previousRecovery.lastFailureAt, isoOrUndefined(row.updated_at)),
        nextAttemptAt: plan.nextAttemptAt,
        lastErrorCode: transport.errorCode,
        lastErrorMessage: transport.errorMessage,
        lastCheckpoint: plan.checkpoint,
        historicalRecovery: {
          recoveredAt: new Date().toISOString(),
          previousState: 'FAILED',
          previousRowVersion: expectedRowVersion,
          safeReadback: plan.safeReadback,
          reason: plan.reason
        }
      };
      audit.push({
        at: new Date().toISOString(), event: 'HISTORICAL_NETWORK_FAILURE_RECOVERED', taskId,
        previousRowVersion: expectedRowVersion, resumeState: plan.safeResumeState,
        deliveryState: plan.deliveryState, safeReadback: plan.safeReadback, phase: plan.phase
      });
      runtime.audit = audit;
      const changed = await client.query<SqlRow>(`UPDATE wb_publish_jobs SET
          state='RETRY_WAIT',resume_state=$3,next_run_at=$4,finished_at=NULL,
          lease_owner='',lease_expires_at=NULL,result_json=$5::jsonb,
          last_error_code=$6,last_error_message=$7,updated_at=NOW(),row_version=row_version+1
        WHERE task_id=$1 AND row_version=$2
          AND idempotency_key=$8 AND product_code=$9 AND revision=$10
          AND payload_signature=$11 AND work_relpath=$12 AND state='FAILED'
        RETURNING *`, [taskId, expectedRowVersion, plan.safeResumeState, plan.nextAttemptAt, JSON.stringify(runtime),
        transport.errorCode, transport.errorMessage, expected.idempotencyKey, expected.productCode, expected.revision,
        expected.payloadSignature, expected.workRelpath]);
      if (!changed.rows[0]) throw conflict('WB runtime 历史任务 CAS 恢复冲突');
      await client.query(`UPDATE wb_runtime_config SET
          network_attempt=GREATEST(network_attempt,$1),
          network_next_attempt_at=CASE
            WHEN network_next_attempt_at IS NULL THEN $2::timestamptz
            ELSE GREATEST(network_next_attempt_at,$2::timestamptz) END,
          network_last_error_code=$3,network_last_error_message=$4,network_updated_at=NOW()
        WHERE config_id='default'`, [
        plan.attempt, plan.nextAttemptAt, transport.errorCode, transport.errorMessage
      ]);
      await insertRuntimeEvent(client, taskId, 'HISTORICAL_NETWORK_FAILURE_RECOVERED', 'FAILED', 'RETRY_WAIT',
        plan.safeReadback ? '历史网络失败已恢复为先回读检查点' : '历史明确未送达请求已恢复到原安全检查点', {
          taskId, previousRowVersion: expectedRowVersion, resumeState: plan.safeResumeState,
          deliveryState: plan.deliveryState, safeReadback: plan.safeReadback, phase: plan.phase,
          checkpoint: plan.checkpoint, nextAttemptAt: plan.nextAttemptAt
        });
      return {
        job: toRuntimeJobRow(changed.rows[0]),
        rowVersion: Number(changed.rows[0].row_version),
        evidence
      };
    });
  }

  async enqueueRuntimeJob(input: JsonRecord): Promise<JsonRecord> {
    const taskId = stringOr(input.task_id, input.taskId);
    if (!taskId) throw new AppError('CONFIG_INVALID', 'task_id 必填');
    return this.transaction(async (client) => {
      const existing = await client.query<SqlRow>('SELECT * FROM wb_publish_jobs WHERE task_id=$1 FOR UPDATE', [taskId]);
      if (existing.rows[0]) return { ...toRuntimeJobRow(existing.rows[0]), idempotent: true };
      const storeId = stringOr(input.store_id, input.storeId) || WB_DEFAULT_STORE_ID;
      const storeResult = await client.query<SqlRow>('SELECT * FROM wb_stores WHERE id=$1 AND archived_at IS NULL FOR SHARE', [storeId]);
      const store = storeResult.rows[0];
      if (!store) throw new AppError('CONFIG_INVALID', 'runtime job 引用了不存在或已归档的 WB 店铺', { storeId }, 409);
      const storeAlias = stringOr(input.store_alias, input.storeAlias) || String(store.store_alias || WB_DEFAULT_STORE_ALIAS);
      if (storeAlias !== String(store.store_alias)) {
        throw new AppError('CONFIG_INVALID', 'runtime job 的 storeAlias 与 storeId 不一致', { storeId, storeAlias }, 409);
      }
      const productCode = stringOr(input.product_code, input.productCode);
      const revision = numberOr(input.revision, 0);
      const publicationId = stringOr(input.publication_id, input.publicationId);
      let publication: SqlRow | undefined;
      if (publicationId) {
        publication = (await client.query<SqlRow>('SELECT * FROM wb_store_publications WHERE id=$1 FOR UPDATE', [publicationId])).rows[0];
        if (!publication) throw new AppError('CONFIG_INVALID', 'runtime job 引用了不存在的店铺发布记录', { publicationId }, 409);
      }
      const publicationSnapshot = asObject(publication?.config_snapshot);
      const credentialVersionId = publication
        ? stringOr(publication.credential_version_id)
        : stringOr(input.credential_version_id, input.credentialVersionId) || stringOr(store.active_credential_version_id);
      const storeConfigVersion = publication
        ? numberOr(publicationSnapshot.storeConfigVersion, 0)
        : numberOr(input.store_config_version, input.storeConfigVersion, store.config_version, 1);
      const warehouseId = publication
        ? stringOr(publicationSnapshot.warehouseId)
        : stringOr(input.warehouse_id, input.warehouseId) || String(store.warehouse_id || '');
      const publicationCredential = publication && credentialVersionId
        ? (await client.query<SqlRow>('SELECT * FROM wb_store_credential_versions WHERE id=$1 AND store_id=$2 FOR SHARE', [credentialVersionId, storeId])).rows[0]
        : undefined;
      if (publication) {
        const publicationMismatches = [
          ...(String(publication.store_id) !== storeId ? ['storeId'] : []),
          ...(String(publication.store_alias_snapshot) !== storeAlias ? ['storeAlias'] : []),
          ...(String(publication.sku) !== productCode ? ['productCode'] : []),
          ...(Number(publication.revision) !== revision ? ['revision'] : []),
          ...(String(publication.task_id || '') !== taskId ? ['taskId'] : []),
          ...(stringOr(input.credential_version_id, input.credentialVersionId) !== credentialVersionId ? ['credentialVersionId'] : []),
          ...(numberOr(input.store_config_version, input.storeConfigVersion, 0) !== storeConfigVersion ? ['storeConfigVersion'] : []),
          ...(stringOr(input.warehouse_id, input.warehouseId) !== warehouseId ? ['warehouseId'] : [])
        ];
        if (publicationMismatches.length) {
          throw new AppError('CONFIG_INVALID', 'runtime job 与不可变店铺发布快照不一致', {
            publicationId, mismatches: publicationMismatches
          }, 409);
        }
      }
      const legacyDefault = storeId === WB_DEFAULT_STORE_ID && String(store.credential_state) === 'LEGACY_EXTERNAL';
      if (!store.enabled) {
        throw new AppError('WB_STORE_NOT_READY', 'WB 店铺已停用，不能创建新 runtime job', { storeId, storeAlias }, 409);
      }
      if (!legacyDefault) {
        const blockers = publication ? [
          ...(!publicationCredential || !['ACTIVE', 'RETIRED'].includes(String(publicationCredential.status)) ? ['发布快照凭据不可用'] : []),
          ...(!storeConfigVersion ? ['发布快照缺少配置版本'] : []),
          ...(!warehouseId ? ['发布快照缺少仓库'] : [])
        ] : [
          ...(String(store.credential_state) !== 'ACTIVE' || !store.active_credential_version_id ? ['Vault 凭据未激活'] : []),
          ...(String(store.preflight_status) !== 'PASSED' ? ['店铺预检未通过'] : []),
          ...(!String(store.warehouse_id || '').trim() ? ['仓库未配置'] : []),
          ...(String(store.account_currency || '').toUpperCase() !== 'CNY' ? ['币种不是 CNY'] : []),
          ...(credentialVersionId !== String(store.active_credential_version_id || '') ? ['任务凭据版本不是店铺当前激活版本'] : [])
        ];
        if (blockers.length) {
          throw new AppError('WB_STORE_NOT_READY', 'WB 店铺尚未满足 runtime 入队条件', { storeId, storeAlias, blockers }, 409);
        }
      }
      const now = new Date().toISOString();
      const runtime = parseJsonRecord(input.result_json);
      await client.query(`INSERT INTO wb_publish_jobs(
        task_id,idempotency_key,source,priority,folder_name,work_relpath,product_code,revision,payload_signature,state,resume_state,
        stage_attempt,total_attempt,poll_count,next_run_at,stage_deadline_at,lease_owner,lease_expires_at,template_version,config_version,
        partial_effects,wb_request_ref,result_json,last_error_code,last_error_message,submitted_at,finished_at,created_at,updated_at,row_version,
        store_id,store_alias,publication_id,credential_version_id,store_config_version,warehouse_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24,$25,$26,$27,$28,$29,1,
          $30,$31,$32,$33,$34,$35)`, [
        taskId, stringOr(input.idempotency_key), stringOr(input.source), numberOr(input.priority, 0),
        stringOr(input.folder_name), stringOr(input.work_relpath), productCode, revision,
        stringOr(input.payload_signature), stringOr(input.state) || 'QUEUED', stringOr(input.resume_state),
        numberOr(input.stage_attempt, 0), numberOr(input.total_attempt, 0), numberOr(input.poll_count, 0),
        dateOr(input.next_run_at, now), dateOr(input.stage_deadline_at), stringOr(input.lease_owner), dateOr(input.lease_expires_at),
        numberOr(input.template_version, 0), numberOr(input.config_version, 1), booleanOr(input.partial_effects, false),
        stringOr(input.wb_request_ref), JSON.stringify(runtime), stringOr(input.last_error_code), stringOr(input.last_error_message),
        dateOr(input.submitted_at), dateOr(input.finished_at), dateOr(input.created_at, now), dateOr(input.updated_at, now),
        storeId, storeAlias, publicationId || null, credentialVersionId || null,
        storeConfigVersion, warehouseId
      ]);
      await insertRuntimeEvent(client, taskId, 'JOB_ENQUEUED', undefined, stringOr(input.state) || 'QUEUED', 'WB runtime job 已写入 PostgreSQL', { source: input.source });
      const result = await client.query<SqlRow>('SELECT * FROM wb_publish_jobs WHERE task_id=$1', [taskId]);
      return { ...toRuntimeJobRow(result.rows[0]!), idempotent: false };
    });
  }

  async transitionRuntimeJob(taskId: string, input: WbRuntimeJobTransitionInput): Promise<JsonRecord> {
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>('SELECT * FROM wb_publish_jobs WHERE task_id=$1 FOR UPDATE', [taskId]);
      const currentRow = current.rows[0];
      if (!currentRow) throw new AppError('NOT_FOUND', 'WB runtime job 不存在', { taskId }, 404);
      const inputJob = asObject(input.job);
      const rawExpected = input.rowVersion ?? inputJob.row_version ?? inputJob.rowVersion;
      const expected = Number(rawExpected);
      if (!Number.isInteger(expected) || expected < 1) {
        throw new AppError('TASK_VERSION_REQUIRED', 'WB runtime job transition 必须携带有效 rowVersion', { taskId }, 409);
      }
      if (expected !== Number(currentRow.row_version)) {
        throw new AppError('TASK_LOCKED', 'WB runtime job 版本已变化，请重新读取后再写入', { taskId, expected, actual: Number(currentRow.row_version) }, 409);
      }
      const job = { ...toRuntimeJobRow(currentRow), ...inputJob };
      const runtime = hasOwn(inputJob, 'result_json') ? parseJsonRecord(inputJob.result_json)
        : hasOwn(inputJob, 'result') ? parseJsonRecord(inputJob.result)
          : parseJsonRecord(job.result_json);
      const networkGateUpdate = runtimeNetworkGateUpdate(input as JsonRecord, inputJob, runtime);
      const nextState = stringOr(job.state) || String(currentRow.state || 'QUEUED');
      await client.query(`UPDATE wb_publish_jobs SET
        idempotency_key=$2,source=$3,priority=$4,folder_name=$5,work_relpath=$6,product_code=$7,revision=$8,payload_signature=$9,
        state=$10,resume_state=$11,stage_attempt=$12,total_attempt=$13,poll_count=$14,next_run_at=$15,stage_deadline_at=$16,
        lease_owner=$17,lease_expires_at=$18,template_version=$19,config_version=$20,partial_effects=$21,wb_request_ref=$22,
        result_json=$23::jsonb,last_error_code=$24,last_error_message=$25,submitted_at=$26,finished_at=$27,updated_at=NOW(),row_version=row_version+1
        WHERE task_id=$1`, [
        taskId, stringOr(job.idempotency_key), stringOr(job.source), numberOr(job.priority, 0), stringOr(job.folder_name),
        stringOr(job.work_relpath), stringOr(job.product_code), numberOr(job.revision, 0), stringOr(job.payload_signature),
        nextState, stringOr(job.resume_state), numberOr(job.stage_attempt, 0), numberOr(job.total_attempt, 0), numberOr(job.poll_count, 0),
        dateOr(job.next_run_at), dateOr(job.stage_deadline_at), stringOr(job.lease_owner), dateOr(job.lease_expires_at),
        numberOr(job.template_version, 0), numberOr(job.config_version, 1), booleanOr(job.partial_effects, false),
        stringOr(job.wb_request_ref), JSON.stringify(runtime), stringOr(job.last_error_code), stringOr(job.last_error_message),
        dateOr(job.submitted_at), dateOr(job.finished_at)
      ]);
      if (networkGateUpdate.kind === 'SET') {
        await client.query(`INSERT INTO wb_store_runtime_state(
          store_id,network_attempt,network_next_attempt_at,network_last_error_code,network_last_error_message,network_updated_at,updated_at)
          VALUES($1,$2,$3,$4,$5,NOW(),NOW()) ON CONFLICT(store_id) DO UPDATE SET
          network_attempt=GREATEST(wb_store_runtime_state.network_attempt,EXCLUDED.network_attempt),
          network_next_attempt_at=CASE WHEN wb_store_runtime_state.network_next_attempt_at IS NULL THEN EXCLUDED.network_next_attempt_at
            ELSE GREATEST(wb_store_runtime_state.network_next_attempt_at,EXCLUDED.network_next_attempt_at) END,
          network_last_error_code=EXCLUDED.network_last_error_code,network_last_error_message=EXCLUDED.network_last_error_message,
          network_updated_at=NOW(),updated_at=NOW()`, [
          String(currentRow.store_id || WB_DEFAULT_STORE_ID),
          networkGateUpdate.attempt,
          networkGateUpdate.nextAttemptAt,
          networkGateUpdate.errorCode,
          networkGateUpdate.errorMessage
        ]);
        if (String(currentRow.store_id || WB_DEFAULT_STORE_ID) === WB_DEFAULT_STORE_ID) {
          await client.query(`UPDATE wb_runtime_config SET network_attempt=GREATEST(network_attempt,$1),
            network_next_attempt_at=CASE WHEN network_next_attempt_at IS NULL THEN $2::timestamptz ELSE GREATEST(network_next_attempt_at,$2::timestamptz) END,
            network_last_error_code=$3,network_last_error_message=$4,network_updated_at=NOW() WHERE config_id='default'`, [
            networkGateUpdate.attempt, networkGateUpdate.nextAttemptAt, networkGateUpdate.errorCode, networkGateUpdate.errorMessage
          ]);
        }
      } else if (networkGateUpdate.kind === 'CLEAR') {
        await client.query(`UPDATE wb_store_runtime_state SET network_attempt=0,network_next_attempt_at=NULL,
          network_last_error_code='',network_last_error_message='',network_updated_at=NOW(),updated_at=NOW()
          WHERE store_id=$1`, [String(currentRow.store_id || WB_DEFAULT_STORE_ID)]);
        if (String(currentRow.store_id || WB_DEFAULT_STORE_ID) === WB_DEFAULT_STORE_ID) {
          await client.query(`UPDATE wb_runtime_config SET network_attempt=0,network_next_attempt_at=NULL,
            network_last_error_code='',network_last_error_message='',network_updated_at=NOW() WHERE config_id='default'`);
        }
      }
      const registryRows = Array.isArray(input.registryRows) ? input.registryRows.map(asObject) : [];
      for (const registryRow of registryRows) {
        await upsertRuntimeRegistryRow(client, taskId, String(currentRow.store_id || WB_DEFAULT_STORE_ID), String(currentRow.product_code || ''), registryRow);
      }
      await insertRuntimeEvent(client, taskId, stringOr(input.eventType) || 'JOB_TRANSITIONED', String(currentRow.state || ''), nextState, stringOr(input.message) || 'WB runtime job 状态已更新', {
        taskId,
        ...(registryRows.length ? { registryCount: registryRows.length } : {}),
        ...(networkGateUpdate.kind !== 'NONE' ? { networkGate: networkGateUpdate.kind } : {})
      });
      const result = await client.query<SqlRow>('SELECT * FROM wb_publish_jobs WHERE task_id=$1', [taskId]);
      await syncPublicationFromRuntime(client, result.rows[0]!);
      return toRuntimeJobRow(result.rows[0]!);
    });
  }

  async recoverPartialCreateRuntimeJob(taskId: string): Promise<JsonRecord> {
    return this.transaction(async (client) => {
      const result = await client.query<SqlRow>('SELECT * FROM wb_publish_jobs WHERE task_id=$1 FOR UPDATE', [taskId]);
      const row = result.rows[0];
      if (!row) throw new AppError('NOT_FOUND', '任务不存在', { taskId }, 404);
      const runtime = parseJsonRecord(row.result_json);
      if (String(runtime.submissionMode || '').toUpperCase() !== 'CREATE_ONLY') throw new AppError('CONFIG_INVALID', 'RECOVER_PARTIAL_CREATE 仅允许恢复 CREATE_ONLY 任务', { taskId }, 409);
      if (String(row.state || '').toUpperCase() !== 'FAILED') throw new AppError('CONFIG_INVALID', 'RECOVER_PARTIAL_CREATE 仅允许恢复 FAILED 任务', { taskId, state: row.state }, 409);
      if (!row.partial_effects) throw new AppError('CONFIG_INVALID', '任务未登记 partial_effects，禁止自动恢复', { taskId }, 409);
      if (asObject(runtime.cardCreateIntent).taskId !== taskId) throw new AppError('CONFIG_INVALID', 'cardCreateIntent 与 taskId 不一致，禁止自动恢复', { taskId }, 409);
      const product = asObject(runtime.product);
      const variants = Array.isArray(product.variants) ? product.variants as JsonRecord[] : [];
      const expected = variants.map((variant) => stringOr(variant.vendorCode)).filter(Boolean);
      const cards = Array.isArray(runtime.cards) ? runtime.cards as JsonRecord[] : [];
      const cardByVendor = new Map<string, JsonRecord>();
      for (const card of cards) {
        const vendorCode = stringOr(card.vendorCode);
        const nmId = Number((card as any).nmID ?? (card as any).nmId);
        if (!vendorCode || !Number.isInteger(nmId) || nmId <= 0) throw new AppError('CONFIG_INVALID', 'runtime.cards 中存在无法验证的 vendorCode/nmID', { taskId }, 409);
        cardByVendor.set(vendorCode, card);
      }
      if (!expected.length || cardByVendor.size !== new Set(expected).size) throw new AppError('CONFIG_INVALID', 'runtime.cards 与 product variants 不一致', { taskId }, 409);
      for (const vendorCode of expected) if (!cardByVendor.has(vendorCode)) throw new AppError('CONFIG_INVALID', 'runtime.cards 未覆盖全部 product variants', { taskId, vendorCode }, 409);
      const priceVerified = asObject(runtime.price).verified === true;
      const stockVerified = asObject(runtime.stock).verified === true;
      const resumedState = priceVerified && stockVerified ? 'FINALIZING' : priceVerified ? 'STOCK_RECONCILING' : 'PRICE_RECONCILING';
      const audit = Array.isArray(runtime.audit) ? runtime.audit as JsonRecord[] : [];
      audit.push({ at: new Date().toISOString(), event: 'RECOVER_PARTIAL_CREATE', taskId, resumedState });
      runtime.audit = audit;
      await client.query(`UPDATE wb_publish_jobs SET state=$2,stage_attempt=0,poll_count=0,next_run_at=NOW(),
        last_error_code='',last_error_message='',finished_at=NULL,result_json=$3::jsonb,updated_at=NOW(),row_version=row_version+1
        WHERE task_id=$1`, [taskId, resumedState, JSON.stringify(runtime)]);
      await insertRuntimeEvent(client, taskId, 'RECOVER_PARTIAL_CREATE', String(row.state || ''), resumedState, 'partial-create 任务已从 PostgreSQL 恢复', { taskId });
      const updated = await client.query<SqlRow>('SELECT * FROM wb_publish_jobs WHERE task_id=$1', [taskId]);
      return toRuntimeJobRow(updated.rows[0]!);
    });
  }

  async recoverCompatibleRuntimeJob(taskId: string, input: WbCompatibleRecoveryInput): Promise<JsonRecord> {
    return this.transaction(async (client) => {
      const result = await client.query<SqlRow>('SELECT * FROM wb_publish_jobs WHERE task_id=$1 FOR UPDATE', [taskId]);
      const row = result.rows[0];
      if (!row) throw new AppError('NOT_FOUND', '任务不存在', { taskId }, 404);
      const runtime = parseJsonRecord(row.result_json);
      const automationRunId = String(input.automationRunId || '').trim();
      if (!automationRunId || String(runtime.automationRunId || '') !== automationRunId) {
        throw new AppError('COMPATIBLE_RECOVERY_UNSAFE', 'automationRunId 与待恢复任务不一致，禁止恢复', { taskId }, 409);
      }
      if (String(runtime.submissionMode || '').toUpperCase() !== 'COMPATIBLE_UPSERT') {
        throw new AppError('CONFIG_INVALID', 'recover-compatible 仅允许恢复 COMPATIBLE_UPSERT 任务', { taskId }, 409);
      }
      if (String(row.state || '').toUpperCase() !== 'FAILED') {
        throw new AppError('CONFIG_INVALID', 'recover-compatible 仅允许恢复 FAILED 任务', { taskId, state: row.state }, 409);
      }
      if (!row.partial_effects) throw new AppError('CONFIG_INVALID', '任务未登记 partial_effects，禁止自动恢复', { taskId }, 409);

      const product = asObject(runtime.product);
      const variants = Array.isArray(product.variants) ? product.variants.map(asObject) : [];
      const expectedVendorCodes = variants.map((variant) => stringOr(variant.vendorCode)).filter(Boolean);
      assertUniqueNonEmptyStrings(expectedVendorCodes, 'product variants vendorCode', taskId);
      const normalizedMatches = normalizeRuntimeCardMatches(input.matches);
      const trashMatches = normalizedMatches.filter((match) => match.location === 'TRASH');
      if (trashMatches.length) {
        throw new AppError('WB_CARD_ALREADY_EXISTS', '回收站中存在相同卖家商品编码，兼容恢复已停止', { taskId, matches: trashMatches }, 409);
      }
      const activeMatches = normalizedMatches.filter((match) => match.location === 'ACTIVE');
      const expectedSubjectId = positiveInteger(runtime.expectedSubjectId ?? asObject(product.category).subjectId);
      assertExactActiveMatches(expectedVendorCodes, activeMatches, taskId, expectedSubjectId);

      const origins = await client.query<SqlRow>(`SELECT * FROM wb_publish_jobs
        WHERE product_code=$1 AND result_json->>'automationRunId'=$2 AND result_json ? 'cardCreateIntent'
        ORDER BY revision ASC,created_at ASC FOR UPDATE`, [String(row.product_code || ''), automationRunId]);
      const origin = origins.rows.find((candidate) => compatibleOriginMatches(candidate, expectedVendorCodes, automationRunId));
      if (!origin) {
        throw new AppError('COMPATIBLE_RECOVERY_UNSAFE', '同一自动上品轮次中未找到可验证的原始建卡意图', {
          taskId, automationRunId, expectedVendorCodes
        }, 409);
      }
      const originRuntime = parseJsonRecord(origin.result_json);
      const originCards = validatedOriginCards(originRuntime, expectedVendorCodes, taskId);
      const currentCards = Array.isArray(runtime.cards) ? runtime.cards.map(asObject) : [];
      const currentCardByVendor = new Map(currentCards.map((card) => [stringOr(card.vendorCode), card]));
      const matchByVendor = new Map(activeMatches.map((match) => [match.vendorCode, match]));
      const originCardByVendor = new Map(originCards.map((card) => [stringOr(card.vendorCode), card]));
      for (const vendorCode of expectedVendorCodes) {
        const live = matchByVendor.get(vendorCode)!;
        const originCard = originCardByVendor.get(vendorCode)!;
        const originNmId = positiveInteger(originCard.nmID ?? originCard.nmId);
        const originImtId = positiveInteger(originCard.imtID ?? originCard.imtId);
        const originSubjectId = positiveInteger(originCard.subjectID ?? originCard.subjectId);
        const currentCard = currentCardByVendor.get(vendorCode);
        const currentNmId = positiveInteger(currentCard?.nmID ?? currentCard?.nmId);
        const currentImtId = positiveInteger(currentCard?.imtID ?? currentCard?.imtId);
        const currentSubjectId = positiveInteger(currentCard?.subjectID ?? currentCard?.subjectId);
        if (live.nmId !== originNmId || !live.imtId || live.imtId !== originImtId) {
          throw new AppError('COMPATIBLE_RECOVERY_UNSAFE', 'WB ACTIVE 商品卡与原始建卡任务身份不一致', {
            taskId, vendorCode, expectedNmId: originNmId, actualNmId: live.nmId,
            expectedImtId: originImtId, actualImtId: live.imtId
          }, 409);
        }
        if (expectedSubjectId && originSubjectId !== expectedSubjectId) {
          throw new AppError('COMPATIBLE_RECOVERY_UNSAFE', '原始商品卡 subject 与当前任务不一致', {
            taskId, vendorCode, expectedSubjectId, actualSubjectId: originSubjectId
          }, 409);
        }
        if (expectedSubjectId && live.subjectId !== expectedSubjectId) {
          throw new AppError('COMPATIBLE_RECOVERY_UNSAFE', 'WB ACTIVE 商品卡 subject 无法与当前任务精确对应', {
            taskId, vendorCode, expectedSubjectId, actualSubjectId: live.subjectId
          }, 409);
        }
        if (!currentCard || currentNmId !== originNmId || currentImtId !== originImtId || currentSubjectId !== originSubjectId) {
          throw new AppError('COMPATIBLE_RECOVERY_UNSAFE', '当前 runtime.cards 与原始建卡身份不一致', {
            taskId, vendorCode, currentNmId, currentImtId, currentSubjectId
          }, 409);
        }
      }

      const originMediaSignature = String(originRuntime.mediaSignature || '');
      const currentMediaSignature = String(runtime.mediaSignature || '');
      if (!originMediaSignature || !currentMediaSignature || originMediaSignature !== currentMediaSignature) {
        throw new AppError('COMPATIBLE_RECOVERY_UNSAFE', '原始建卡任务与当前任务的媒体签名不一致，禁止跳过媒体重传', {
          taskId, originTaskId: origin.task_id
        }, 409);
      }

      const existingCardBaseline = expectedVendorCodes.map((vendorCode) => ({
        vendorCode,
        nmID: String(matchByVendor.get(vendorCode)!.nmId)
      }));
      const previousBaseline = Array.isArray(runtime.existingCardBaseline) ? runtime.existingCardBaseline.map(asObject) : [];
      if (previousBaseline.length && stableJson(previousBaseline) !== stableJson(existingCardBaseline)) {
        throw new AppError('COMPATIBLE_RECOVERY_UNSAFE', '任务已有的 existingCardBaseline 与实时商品卡不一致', { taskId }, 409);
      }

      const restoredCards: JsonRecord[] = expectedVendorCodes.map((vendorCode, variantIndex) => {
        const originCard = originCardByVendor.get(vendorCode)!;
        const currentCard = currentCardByVendor.get(vendorCode) || {};
        const variant = variants[variantIndex] || {};
        return {
          ...currentCard,
          ...originCard,
          vendorCode,
          variantCode: stringOr(variant.variantCode) || stringOr(originCard.variantCode) || vendorCode,
          sizes: (Array.isArray(originCard.sizes) ? originCard.sizes : []).map((size, sizeIndex) => ({
            ...asObject(size), variantIndex, sizeIndex, vendorCode
          }))
        } as JsonRecord;
      });
      const restoredBarcodes: JsonRecord = {};
      for (const [variantIndex, card] of restoredCards.entries()) {
        for (const [sizeIndex, size] of (Array.isArray(card.sizes) ? card.sizes : []).entries()) {
          const barcode = stringOr(asObject(size).barcode);
          if (barcode) restoredBarcodes[`${variantIndex}:${sizeIndex}`] = barcode;
        }
      }
      runtime.cards = restoredCards;
      runtime.barcodes = restoredBarcodes;
      runtime.missingBarcodeSlots = [];
      runtime.isUpdate = true;
      runtime.registryVendorCodes = expectedVendorCodes;
      runtime.existingCardBaseline = existingCardBaseline;
      // 兼容恢复会从 MEDIA_RECONCILING 重新回读平台，后续价格状态也必须由新的
      // PRICE_LIST 重建。保留旧失败轮次的 uploadId/队列会让新价格任务提交后仍轮询
      // 旧 status=5/6 任务，导致恢复被过期游标再次标记失败。清理这些本地游标不会
      // 重放 WB 写入：S001 仍会先回读实际价格，只对不一致项创建新的幂等任务。
      runtime.price = { ...asObject(runtime.price), verified: false, uploadIds: [] };
      runtime.priceUploadIds = [];
      runtime.priceQueue = [];
      runtime.priceIntent = null;
      runtime.priceIntentAt = '';
      runtime.priceVerifyStartedAt = '';
      runtime.compatibleRecovery = {
        recoveredTaskId: taskId,
        originTaskId: String(origin.task_id || ''),
        automationRunId,
        recoveredAt: new Date().toISOString(),
        verifyMediaBeforeSkip: true,
        mediaSignatureMatched: true
      };
      const audit = Array.isArray(runtime.audit) ? runtime.audit as JsonRecord[] : [];
      audit.push({
        at: new Date().toISOString(), event: 'RECOVER_COMPATIBLE_UPSERT', taskId,
        originTaskId: String(origin.task_id || ''), automationRunId, existingCardBaseline
      });
      runtime.audit = audit;

      const mediaComplete = restoredCards.every((card, variantIndex) => {
        const variant = variants[variantIndex] || {};
        const targetPhotos = Array.isArray(variant.images) ? variant.images.length : 0;
        const photosCount = Number(card.photosCount ?? (Array.isArray(card.photos) ? card.photos.length : 0));
        const targetVideo = Boolean(stringOr(variant.video));
        const videoPresent = Boolean(card.videoPresent ?? stringOr(card.video));
        return targetPhotos > 0 && photosCount === targetPhotos && videoPresent === targetVideo;
      });
      // CHECK_VENDOR_CODES intentionally does not carry current media details.
      // Always force one live CARDS_LIST verification before S001 may skip media.
      const resumedState = 'MEDIA_RECONCILING';

      for (const [variantIndex, card] of restoredCards.entries()) {
        for (const size of Array.isArray(card.sizes) ? card.sizes : []) {
          const sizeRecord = asObject(size);
          const techSize = stringOr(sizeRecord.techSize);
          const variant = variants[variantIndex] || {};
          const variantCode = stringOr(variant.variantCode) || stringOr(card.variantCode) || stringOr(card.vendorCode);
          const registryKey = `${String(row.product_code || '')}|${variantCode}|${techSize}`;
          await client.query(`INSERT INTO wb_product_registry(
              store_id,store_alias,registry_key,product_code,category_key,variant_code,vendor_code,tech_size,barcode,nm_id,imt_id,chrt_id,size_id,subject_id,
              last_applied_revision,desired_signature,media_signature,status,last_verified_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'DISCOVERED',NULL,NOW())
            ON CONFLICT(store_id,registry_key) DO UPDATE SET
              product_code=EXCLUDED.product_code,category_key=EXCLUDED.category_key,variant_code=EXCLUDED.variant_code,
              vendor_code=EXCLUDED.vendor_code,tech_size=EXCLUDED.tech_size,barcode=EXCLUDED.barcode,nm_id=EXCLUDED.nm_id,
              imt_id=EXCLUDED.imt_id,chrt_id=EXCLUDED.chrt_id,size_id=EXCLUDED.size_id,subject_id=EXCLUDED.subject_id,
              media_signature=EXCLUDED.media_signature,status='DISCOVERED',last_verified_at=NULL,updated_at=NOW()`, [
            String(row.store_id || WB_DEFAULT_STORE_ID), String(row.store_alias || WB_DEFAULT_STORE_ALIAS),
            registryKey, String(row.product_code || ''), stringOr(asObject(product.category).key), variantCode,
            stringOr(card.vendorCode), techSize, stringOr(sizeRecord.barcode), stringOr(card.nmID ?? card.nmId),
            stringOr(card.imtID ?? card.imtId), stringOr(sizeRecord.chrtID ?? sizeRecord.chrtId),
            stringOr(sizeRecord.sizeID ?? sizeRecord.sizeId), stringOr(card.subjectID ?? card.subjectId),
            Number(origin.revision || 0), String(origin.payload_signature || ''), currentMediaSignature
          ]);
        }
      }

      await client.query(`UPDATE wb_publish_jobs SET state=$2,resume_state=$2,stage_attempt=0,poll_count=0,next_run_at=NOW(),
        stage_deadline_at=NOW()+INTERVAL '15 minutes',
        lease_owner='',lease_expires_at=NULL,last_error_code='',last_error_message='',finished_at=NULL,
        result_json=$3::jsonb,updated_at=NOW(),row_version=row_version+1 WHERE task_id=$1`, [taskId, resumedState, JSON.stringify(runtime)]);
      await insertRuntimeEvent(client, taskId, 'RECOVER_COMPATIBLE_UPSERT', String(row.state || ''), resumedState,
        'compatible-upsert 任务已按同一自动轮次的原始卡片身份恢复', {
          taskId, originTaskId: origin.task_id, automationRunId, existingCardBaseline, mediaComplete
        });
      const updated = await client.query<SqlRow>('SELECT * FROM wb_publish_jobs WHERE task_id=$1', [taskId]);
      return { ...toRuntimeJobRow(updated.rows[0]!), resumedState, originTaskId: String(origin.task_id || '') };
    });
  }

  async upsertRuntimeRegistry(taskId: string, rows: JsonRecord[]): Promise<JsonRecord[]> {
    return this.transaction(async (client) => {
      const task = await client.query<{ store_id: string; product_code: string }>('SELECT store_id,product_code FROM wb_publish_jobs WHERE task_id=$1 FOR SHARE', [taskId]);
      if (!task.rows[0]) throw new AppError('NOT_FOUND', 'WB runtime job 不存在', { taskId }, 404);
      const output: JsonRecord[] = [];
      for (const row of rows) {
        const normalized = await upsertRuntimeRegistryRow(client, taskId, String(task.rows[0].store_id), String(task.rows[0].product_code || ''), row);
        if (normalized) output.push(normalized);
      }
      await insertRuntimeEvent(client, taskId, 'REGISTRY_UPSERTED', undefined, undefined, 'WB 商品 registry 已写入 PostgreSQL', { count: output.length });
      return output;
    });
  }

  async listRuntimeRegistry(productCode: string, storeId: string = WB_DEFAULT_STORE_ID): Promise<JsonRecord[]> {
    const result = await this.query<SqlRow>('SELECT * FROM wb_product_registry WHERE store_id=$1 AND product_code=$2 ORDER BY registry_key', [storeId, productCode]);
    return result.rows.map(toRuntimeRegistryRow);
  }

  async recordRuntimeError(input: JsonRecord): Promise<JsonRecord> {
    const errorId = stringOr(input.error_id, input.errorId) || randomUUID();
    await this.query(`INSERT INTO wb_system_errors(
      error_id,workflow_id,workflow_name,execution_id,execution_url,last_node,error_name,error_message,occurred_at,captured_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(error_id) DO UPDATE SET
        workflow_id=EXCLUDED.workflow_id,workflow_name=EXCLUDED.workflow_name,execution_id=EXCLUDED.execution_id,
        execution_url=EXCLUDED.execution_url,last_node=EXCLUDED.last_node,error_name=EXCLUDED.error_name,
        error_message=EXCLUDED.error_message,occurred_at=EXCLUDED.occurred_at,captured_at=EXCLUDED.captured_at`, [
      errorId, stringOr(input.workflow_id), stringOr(input.workflow_name), stringOr(input.execution_id), stringOr(input.execution_url),
      stringOr(input.last_node), stringOr(input.error_name), stringOr(input.error_message).slice(0, 4000),
      dateOr(input.occurred_at, new Date().toISOString()), dateOr(input.captured_at, new Date().toISOString())
    ]);
    return { ...input, error_id: errorId };
  }

  async beginCatalogRun(trigger: WbCatalogTrigger, scheduleKey?: string): Promise<{ run: WbCatalogRun; created: boolean }> {
    const runId = randomUUID();
    try {
      const result = await this.query<SqlRow>(`INSERT INTO wb_catalog_sync_runs(id,trigger,status,schedule_key)
        VALUES($1,$2,'RUNNING',$3) RETURNING *`, [runId, trigger, scheduleKey || null]);
      return { run: toCatalogRun(result.rows[0]!), created: true };
    } catch (error: any) {
      if (error?.code !== '23505') throw error;
      const existing = scheduleKey && trigger === 'SCHEDULED'
        ? await this.query<SqlRow>("SELECT * FROM wb_catalog_sync_runs WHERE trigger='SCHEDULED' AND schedule_key=$1 ORDER BY started_at DESC LIMIT 1", [scheduleKey])
        : await this.query<SqlRow>("SELECT * FROM wb_catalog_sync_runs WHERE status='RUNNING' ORDER BY started_at DESC LIMIT 1");
      if (!existing.rows[0]) throw error;
      return { run: toCatalogRun(existing.rows[0]), created: false };
    }
  }

  async getRunningCatalogRun(): Promise<WbCatalogRun | undefined> {
    const result = await this.query<SqlRow>("SELECT * FROM wb_catalog_sync_runs WHERE status='RUNNING' ORDER BY started_at DESC LIMIT 1");
    return result.rows[0] ? toCatalogRun(result.rows[0]) : undefined;
  }

  async updateCatalogRunProgress(runId: string, input: { processedParents?: number; totalParents?: number; processedSubjects?: number }): Promise<void> {
    await this.query(`UPDATE wb_catalog_sync_runs SET
      processed_parents=COALESCE($2,processed_parents),total_parents=COALESCE($3,total_parents),
      processed_subjects=COALESCE($4,processed_subjects),heartbeat_at=NOW() WHERE id=$1 AND status='RUNNING'`, [
      runId, input.processedParents ?? null, input.totalParents ?? null, input.processedSubjects ?? null
    ]);
  }

  async completeCatalogRun(
    runId: string,
    parents: WbCatalogParentInput[],
    subjects: WbCatalogSubjectInput[],
    colors: WbCatalogColorInput[],
    dictionaryValues: WbCatalogDictionaryValueInput[],
    snapshotPath: string,
    sourceHash: string
  ): Promise<void> {
    await this.transaction(async (client) => {
      const run = await client.query<SqlRow>("SELECT id FROM wb_catalog_sync_runs WHERE id=$1 AND status='RUNNING' FOR UPDATE", [runId]);
      if (!run.rows[0]) throw new AppError('TASK_LOCKED', 'WB 目录同步任务不存在或状态已变化', { runId }, 409);
      await client.query(`WITH incoming AS (
          SELECT * FROM jsonb_to_recordset($2::jsonb) AS item(parent_id INTEGER,name_ru TEXT,name_zh TEXT,is_visible BOOLEAN)
        ) INSERT INTO wb_catalog_parents(parent_id,name_ru,name_normalized,name_zh,name_zh_normalized,is_visible,active,missing_sync_count,last_seen_run_id,updated_at)
        SELECT parent_id,name_ru,translate(lower(name_ru),'ё','е'),name_zh,lower(name_zh),is_visible,true,0,$1,NOW() FROM incoming
        ON CONFLICT(parent_id) DO UPDATE SET name_ru=EXCLUDED.name_ru,name_normalized=EXCLUDED.name_normalized,
          name_zh=EXCLUDED.name_zh,name_zh_normalized=EXCLUDED.name_zh_normalized,
          is_visible=EXCLUDED.is_visible,active=true,missing_sync_count=0,last_seen_run_id=$1,updated_at=NOW()`, [
        runId, JSON.stringify(parents.map((item) => ({ parent_id: item.parentId, name_ru: item.nameRu, name_zh: item.nameZh, is_visible: item.isVisible })))
      ]);
      await client.query(`UPDATE wb_catalog_parents SET missing_sync_count=missing_sync_count+1,
        active=CASE WHEN missing_sync_count+1>=2 THEN false ELSE active END,updated_at=NOW()
        WHERE last_seen_run_id IS DISTINCT FROM $1`, [runId]);
      await client.query(`WITH incoming AS (
          SELECT * FROM jsonb_to_recordset($2::jsonb) AS item(subject_id INTEGER,subject_name_ru TEXT,subject_name_zh TEXT,parent_id INTEGER,parent_name_ru TEXT,parent_name_zh TEXT)
        ) INSERT INTO wb_catalog_subjects(subject_id,subject_name,subject_name_normalized,subject_name_zh,subject_name_zh_normalized,
          parent_id,parent_name,parent_name_normalized,parent_name_zh,parent_name_zh_normalized,search_text,search_text_zh,
          active,missing_sync_count,last_seen_run_id,updated_at)
        SELECT subject_id,subject_name_ru,translate(lower(subject_name_ru),'ё','е'),subject_name_zh,lower(subject_name_zh),
          parent_id,parent_name_ru,translate(lower(parent_name_ru),'ё','е'),parent_name_zh,lower(parent_name_zh),
          translate(lower(subject_name_ru || ' ' || parent_name_ru),'ё','е'),lower(subject_name_zh || ' ' || parent_name_zh),
          true,0,$1,NOW() FROM incoming
        ON CONFLICT(subject_id) DO UPDATE SET subject_name=EXCLUDED.subject_name,subject_name_normalized=EXCLUDED.subject_name_normalized,
          subject_name_zh=EXCLUDED.subject_name_zh,subject_name_zh_normalized=EXCLUDED.subject_name_zh_normalized,
          parent_id=EXCLUDED.parent_id,parent_name=EXCLUDED.parent_name,parent_name_normalized=EXCLUDED.parent_name_normalized,
          parent_name_zh=EXCLUDED.parent_name_zh,parent_name_zh_normalized=EXCLUDED.parent_name_zh_normalized,
          search_text=EXCLUDED.search_text,search_text_zh=EXCLUDED.search_text_zh,
          active=true,missing_sync_count=0,last_seen_run_id=$1,updated_at=NOW()`, [
        runId, JSON.stringify(subjects.map((item) => ({
          subject_id: item.subjectId, subject_name_ru: item.subjectNameRu, subject_name_zh: item.subjectNameZh,
          parent_id: item.parentId, parent_name_ru: item.parentNameRu, parent_name_zh: item.parentNameZh
        })))
      ]);
      await client.query('DELETE FROM wb_catalog_dictionary_values');
      await client.query(`WITH incoming AS (
          SELECT * FROM jsonb_to_recordset($2::jsonb) AS item(directory TEXT,value_key TEXT,position INTEGER,wb_id INTEGER,
            name_ru TEXT,name_zh TEXT,full_name_ru TEXT,full_name_zh TEXT)
        ) INSERT INTO wb_catalog_dictionary_values(directory,value_key,position,wb_id,name_ru,name_ru_normalized,name_zh,name_zh_normalized,
          full_name_ru,full_name_ru_normalized,full_name_zh,full_name_zh_normalized,last_seen_run_id,updated_at)
        SELECT directory,value_key,position,wb_id,name_ru,translate(lower(name_ru),'ё','е'),name_zh,lower(name_zh),
          full_name_ru,translate(lower(full_name_ru),'ё','е'),full_name_zh,lower(full_name_zh),$1,NOW() FROM incoming`, [
        runId, JSON.stringify(dictionaryValues.map((item) => ({
          directory: item.directory, value_key: item.valueKey, position: item.position, wb_id: item.wbId ?? null,
          name_ru: item.nameRu, name_zh: item.nameZh, full_name_ru: item.fullNameRu, full_name_zh: item.fullNameZh
        })))
      ]);
      await client.query(`UPDATE wb_catalog_subjects SET missing_sync_count=missing_sync_count+1,
        active=CASE WHEN missing_sync_count+1>=2 THEN false ELSE active END,updated_at=NOW()
        WHERE last_seen_run_id IS DISTINCT FROM $1`, [runId]);
      await client.query('DELETE FROM wb_catalog_colors');
      await client.query(`WITH incoming AS (
          SELECT * FROM jsonb_to_recordset($2::jsonb) AS item(color_key TEXT,position INTEGER,name_ru TEXT,name_zh TEXT,parent_name_ru TEXT,parent_name_zh TEXT)
        ) INSERT INTO wb_catalog_colors(color_key,position,name_ru,name_ru_normalized,name_zh,name_zh_normalized,
          parent_name_ru,parent_name_ru_normalized,parent_name_zh,parent_name_zh_normalized,last_seen_run_id,updated_at)
        SELECT color_key,position,name_ru,translate(lower(name_ru),'ё','е'),name_zh,lower(name_zh),
          parent_name_ru,translate(lower(parent_name_ru),'ё','е'),parent_name_zh,lower(parent_name_zh),$1,NOW() FROM incoming`, [
        runId, JSON.stringify(colors.map((item) => ({
          color_key: item.colorKey, position: item.position, name_ru: item.nameRu, name_zh: item.nameZh,
          parent_name_ru: item.parentNameRu, parent_name_zh: item.parentNameZh
        })))
      ]);
      const completed = await client.query(`UPDATE wb_catalog_sync_runs SET status='SUCCEEDED',processed_parents=$2,total_parents=$2,
        processed_subjects=$3,snapshot_path=$4,source_hash=$5,error_code=NULL,error_message=NULL,completed_at=NOW(),heartbeat_at=NOW()
        WHERE id=$1 AND status='RUNNING'`, [runId, parents.length, subjects.length, snapshotPath, sourceHash]);
      if (!completed.rowCount) throw new AppError('TASK_LOCKED', 'WB 目录同步任务完成状态冲突', { runId }, 409);
    });
  }

  async failCatalogRun(runId: string, errorCode: string, errorMessage: string): Promise<void> {
    await this.query(`UPDATE wb_catalog_sync_runs SET status='FAILED',error_code=$2,error_message=$3,
      completed_at=NOW(),heartbeat_at=NOW() WHERE id=$1 AND status='RUNNING'`, [runId, errorCode, errorMessage.slice(0, 4_000)]);
  }

  async listSuccessfulCatalogSnapshotPaths(limitInput = 7): Promise<string[]> {
    const limit = Math.min(100, Math.max(1, Math.trunc(limitInput) || 7));
    const result = await this.query<{ snapshot_path: string }>(`SELECT snapshot_path FROM wb_catalog_sync_runs
      WHERE status='SUCCEEDED' AND snapshot_path IS NOT NULL ORDER BY completed_at DESC,id DESC LIMIT $1`, [limit]);
    return result.rows.map((row) => row.snapshot_path);
  }

  async catalogOverview(): Promise<WbCatalogOverview> {
    const [counts, current, latest, successful] = await Promise.all([
      this.query<{ parent_count: string; subject_count: string; color_count: string; country_count: string; season_count: string; kind_count: string }>(`SELECT
        (SELECT COUNT(*)::text FROM wb_catalog_parents WHERE active=true) parent_count,
        (SELECT COUNT(*)::text FROM wb_catalog_subjects WHERE active=true) subject_count,
        (SELECT COUNT(*)::text FROM wb_catalog_colors) color_count,
        (SELECT COUNT(*)::text FROM wb_catalog_dictionary_values WHERE directory='countries') country_count,
        (SELECT COUNT(*)::text FROM wb_catalog_dictionary_values WHERE directory='seasons') season_count,
        (SELECT COUNT(*)::text FROM wb_catalog_dictionary_values WHERE directory='kinds') kind_count`),
      this.query<SqlRow>("SELECT * FROM wb_catalog_sync_runs WHERE status='RUNNING' ORDER BY started_at DESC LIMIT 1"),
      this.query<SqlRow>('SELECT * FROM wb_catalog_sync_runs ORDER BY started_at DESC LIMIT 1'),
      this.query<{ completed_at: string }>("SELECT completed_at FROM wb_catalog_sync_runs WHERE status='SUCCEEDED' ORDER BY completed_at DESC LIMIT 1")
    ]);
    const dictionaryCounts = {
      countries: Number(counts.rows[0]?.country_count || 0),
      seasons: Number(counts.rows[0]?.season_count || 0),
      kinds: Number(counts.rows[0]?.kind_count || 0),
      colors: Number(counts.rows[0]?.color_count || 0)
    };
    return {
      parentCount: Number(counts.rows[0]?.parent_count || 0),
      subjectCount: Number(counts.rows[0]?.subject_count || 0),
      colorCount: dictionaryCounts.colors,
      dictionaryCounts,
      ...(current.rows[0] ? { currentRun: toCatalogRun(current.rows[0]) } : {}),
      ...(latest.rows[0] ? { latestRun: toCatalogRun(latest.rows[0]) } : {}),
      ...(successful.rows[0]?.completed_at ? { lastSuccessfulAt: successful.rows[0].completed_at } : {})
    };
  }

  async searchCatalogSubjects(queryInput: string, limitInput = 30): Promise<Array<{
    subjectId: number; subjectName: string; subjectNameRu: string; subjectNameZh: string;
    parentId: number; parentName: string; parentNameRu: string; parentNameZh: string; active: boolean;
  }>> {
    const query = normalizeCatalogText(queryInput);
    const limit = Math.min(50, Math.max(1, Math.trunc(limitInput) || 30));
    const numeric = /^\d+$/.test(query) ? Number(query) : null;
    const fuzzyWhere = this.trigramAvailable ? ` OR similarity(subject_name_normalized,$1)>=0.2 OR similarity(parent_name_normalized,$1)>=0.2
      OR similarity(subject_name_zh_normalized,$1)>=0.2 OR similarity(parent_name_zh_normalized,$1)>=0.2` : '';
    const fuzzyScore = this.trigramAvailable ? `GREATEST(similarity(subject_name_normalized,$1),similarity(parent_name_normalized,$1),
      similarity(subject_name_zh_normalized,$1),similarity(parent_name_zh_normalized,$1))` : '0';
    const result = await this.query<SqlRow>(`SELECT subject_id,subject_name,subject_name_zh,parent_id,parent_name,parent_name_zh,active FROM wb_catalog_subjects
      WHERE active=true AND (subject_id=$2 OR subject_name_normalized=$1 OR parent_name_normalized=$1
        OR subject_name_zh_normalized=$1 OR parent_name_zh_normalized=$1
        OR subject_name_normalized LIKE $1 || '%' OR parent_name_normalized LIKE $1 || '%'
        OR subject_name_zh_normalized LIKE $1 || '%' OR parent_name_zh_normalized LIKE $1 || '%'
        OR to_tsvector('russian',search_text) @@ plainto_tsquery('russian',$1)
        OR subject_name_normalized LIKE '%' || $1 || '%' OR parent_name_normalized LIKE '%' || $1 || '%'
        OR subject_name_zh_normalized LIKE '%' || $1 || '%' OR parent_name_zh_normalized LIKE '%' || $1 || '%'${fuzzyWhere})
      ORDER BY CASE WHEN subject_id=$2 THEN 0 WHEN subject_name_normalized=$1 OR subject_name_zh_normalized=$1 THEN 1
        WHEN subject_name_normalized LIKE $1 || '%' OR subject_name_zh_normalized LIKE $1 || '%' THEN 2
        WHEN to_tsvector('russian',search_text) @@ plainto_tsquery('russian',$1) THEN 3
        WHEN subject_name_normalized LIKE '%' || $1 || '%' OR subject_name_zh_normalized LIKE '%' || $1 || '%' THEN 4 ELSE 5 END,
        ${fuzzyScore} DESC,subject_name ASC,subject_id ASC LIMIT $3`, [query, numeric, limit]);
    return result.rows.map((row) => ({
      subjectId: Number(row.subject_id), subjectName: String(row.subject_name),
      subjectNameRu: String(row.subject_name), subjectNameZh: String(row.subject_name_zh || ''), parentId: Number(row.parent_id),
      parentName: String(row.parent_name), parentNameRu: String(row.parent_name), parentNameZh: String(row.parent_name_zh || ''), active: Boolean(row.active)
    }));
  }

  async searchCatalogColors(queryInput = '', limitInput = 1_000): Promise<Array<{
    colorKey: string; nameRu: string; nameZh: string; parentNameRu: string; parentNameZh: string;
  }>> {
    const query = normalizeCatalogText(queryInput);
    const limit = Math.min(1_000, Math.max(1, Math.trunc(limitInput) || 1_000));
    const result = query ? await this.query<SqlRow>(`SELECT color_key,name_ru,name_zh,parent_name_ru,parent_name_zh FROM wb_catalog_colors
      WHERE name_ru_normalized LIKE '%' || $1 || '%' OR parent_name_ru_normalized LIKE '%' || $1 || '%'
        OR name_zh_normalized LIKE '%' || $1 || '%' OR parent_name_zh_normalized LIKE '%' || $1 || '%'
      ORDER BY CASE WHEN name_ru_normalized=$1 OR name_zh_normalized=$1 THEN 0
        WHEN name_ru_normalized LIKE $1 || '%' OR name_zh_normalized LIKE $1 || '%' THEN 1 ELSE 2 END,
        position ASC LIMIT $2`, [query, limit])
      : await this.query<SqlRow>(`SELECT color_key,name_ru,name_zh,parent_name_ru,parent_name_zh FROM wb_catalog_colors ORDER BY position ASC LIMIT $1`, [limit]);
    return result.rows.map((row) => ({
      colorKey: String(row.color_key), nameRu: String(row.name_ru), nameZh: String(row.name_zh || ''),
      parentNameRu: String(row.parent_name_ru), parentNameZh: String(row.parent_name_zh || '')
    }));
  }

  async getCatalogColorByKey(colorKeyInput: string): Promise<{ colorKey: string; nameRu: string; nameZh: string } | undefined> {
    const colorKey = String(colorKeyInput || '').trim().toLocaleLowerCase('en-US');
    if (!/^[a-f0-9]{64}$/.test(colorKey)) return undefined;
    const result = await this.query<SqlRow>('SELECT color_key,name_ru,name_zh FROM wb_catalog_colors WHERE color_key=$1', [colorKey]);
    const row = result.rows[0];
    return row ? { colorKey: String(row.color_key), nameRu: String(row.name_ru), nameZh: String(row.name_zh || '') } : undefined;
  }

  async listCatalogColorIdentities(): Promise<Array<{ colorKey: string; nameRu: string; nameZh: string }>> {
    const result = await this.query<SqlRow>('SELECT color_key,name_ru,name_zh FROM wb_catalog_colors ORDER BY position ASC');
    return result.rows.map((row) => ({ colorKey: String(row.color_key), nameRu: String(row.name_ru), nameZh: String(row.name_zh || '') }));
  }

  async searchCatalogDictionary(directory: Exclude<WbCatalogDictionaryName, 'colors'>, queryInput = '', limitInput = 1_000): Promise<Array<{
    itemKey: string; wbId?: number; nameRu: string; nameZh: string; fullNameRu: string; fullNameZh: string;
  }>> {
    const query = normalizeCatalogText(queryInput);
    const limit = Math.min(1_000, Math.max(1, Math.trunc(limitInput) || 1_000));
    const result = query ? await this.query<SqlRow>(`SELECT value_key,wb_id,name_ru,name_zh,full_name_ru,full_name_zh FROM wb_catalog_dictionary_values
      WHERE directory=$1 AND (name_ru_normalized LIKE '%' || $2 || '%' OR name_zh_normalized LIKE '%' || $2 || '%'
        OR full_name_ru_normalized LIKE '%' || $2 || '%' OR full_name_zh_normalized LIKE '%' || $2 || '%'
        OR wb_id::text=$2)
      ORDER BY CASE WHEN name_ru_normalized=$2 OR name_zh_normalized=$2 OR wb_id::text=$2 THEN 0
        WHEN name_ru_normalized LIKE $2 || '%' OR name_zh_normalized LIKE $2 || '%' THEN 1 ELSE 2 END,
        position ASC LIMIT $3`, [directory, query, limit])
      : await this.query<SqlRow>(`SELECT value_key,wb_id,name_ru,name_zh,full_name_ru,full_name_zh FROM wb_catalog_dictionary_values
        WHERE directory=$1 ORDER BY position ASC LIMIT $2`, [directory, limit]);
    return result.rows.map((row) => ({
      itemKey: String(row.value_key), ...(row.wb_id == null ? {} : { wbId: Number(row.wb_id) }),
      nameRu: String(row.name_ru), nameZh: String(row.name_zh || ''),
      fullNameRu: String(row.full_name_ru || ''), fullNameZh: String(row.full_name_zh || '')
    }));
  }

  private async migrate() {
    await this.query('CREATE TABLE IF NOT EXISTS wb_schema_migrations(id TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const migrationLock = await this.requirePool().connect();
    try {
      await migrationLock.query("SELECT pg_advisory_lock(hashtext('pixroute_wb_schema_migrations'))");
      await this.applyMigrations();
    } finally {
      await migrationLock.query("SELECT pg_advisory_unlock(hashtext('pixroute_wb_schema_migrations'))").catch(() => undefined);
      migrationLock.release();
    }
  }

  private async applyMigrations() {
    const applied = await this.query("SELECT id FROM wb_schema_migrations WHERE id='001_wb_listing_management'");
    if (!applied.rows[0]) await this.transaction(async (client) => {
      await client.query(`CREATE TABLE wb_category_templates(
        id UUID PRIMARY KEY,category_key TEXT NOT NULL UNIQUE CHECK(category_key ~ '^[a-z0-9][a-z0-9_-]{1,95}$'),name_ru TEXT NOT NULL,name_zh TEXT NOT NULL DEFAULT '',
        subject_id INTEGER NOT NULL CHECK(subject_id>0),active BOOLEAN NOT NULL DEFAULT true,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await client.query(`CREATE TABLE wb_category_template_versions(
        id UUID PRIMARY KEY,template_id UUID NOT NULL REFERENCES wb_category_templates(id) ON DELETE RESTRICT,version_no INTEGER NOT NULL CHECK(version_no>0),
        status TEXT NOT NULL CHECK(status IN ('DRAFT','PUBLISHED','ARCHIVED')),name_ru TEXT NOT NULL,name_zh TEXT NOT NULL DEFAULT '',subject_id INTEGER NOT NULL CHECK(subject_id>0),
        live_schema JSONB NOT NULL,form_config JSONB NOT NULL,
        managed_characteristic_ids JSONB NOT NULL,schema_hash TEXT NOT NULL,confirmed_by TEXT,confirmed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),published_at TIMESTAMPTZ,UNIQUE(template_id,version_no))`);
      await client.query("CREATE UNIQUE INDEX wb_category_one_draft ON wb_category_template_versions(template_id) WHERE status='DRAFT'");
      await client.query("CREATE UNIQUE INDEX wb_category_one_published ON wb_category_template_versions(template_id) WHERE status='PUBLISHED'");
      await client.query(`CREATE TABLE wb_category_projection_state(
        category_key TEXT PRIMARY KEY REFERENCES wb_category_templates(category_key) ON DELETE CASCADE,status TEXT NOT NULL CHECK(status IN ('NOT_SYNCED','PENDING','SYNCED','FAILED')) DEFAULT 'NOT_SYNCED',
        source_version_id UUID,schema_hash TEXT,definition_hash TEXT,last_error TEXT,synced_at TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await client.query(`CREATE TABLE wb_listing_drafts(
        sku CHAR(7) PRIMARY KEY REFERENCES products(sku) ON DELETE CASCADE,draft_version INTEGER NOT NULL DEFAULT 1 CHECK(draft_version>0),
        status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','STALE','GENERATING','GENERATED','SUBMITTING','QUEUED','RUNNING','SUCCEEDED','BLOCKED','FAILED','NEEDS_ATTENTION')),
        category_key TEXT REFERENCES wb_category_templates(category_key),category_version_id UUID REFERENCES wb_category_template_versions(id),data JSONB NOT NULL DEFAULT '{}'::jsonb,
        media_assets JSONB NOT NULL DEFAULT '[]'::jsonb,variant_media JSONB NOT NULL DEFAULT '[]'::jsonb,generated_version_id UUID,n8n_task_id TEXT,
        nm_ids JSONB NOT NULL DEFAULT '[]'::jsonb,product_urls JSONB NOT NULL DEFAULT '[]'::jsonb,last_error TEXT,
        network_recovery JSONB NOT NULL DEFAULT '{}'::jsonb,network_next_attempt_at TIMESTAMPTZ,generated_at TIMESTAMPTZ,submitted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await client.query(`CREATE TABLE wb_listing_versions(
        id UUID PRIMARY KEY,sku CHAR(7) NOT NULL REFERENCES products(sku) ON DELETE RESTRICT,revision INTEGER NOT NULL CHECK(revision>0),
        status TEXT NOT NULL CHECK(status IN ('GENERATING','GENERATED','SUBMITTING','QUEUED','RUNNING','SUCCEEDED','BLOCKED','FAILED','NEEDS_ATTENTION')),
        category_version_id UUID NOT NULL REFERENCES wb_category_template_versions(id),product_json JSONB NOT NULL,media_manifest JSONB NOT NULL,n8n_task_id TEXT,
        nm_ids JSONB NOT NULL DEFAULT '[]'::jsonb,product_urls JSONB NOT NULL DEFAULT '[]'::jsonb,result_json JSONB,error_message TEXT,
        network_recovery JSONB NOT NULL DEFAULT '{}'::jsonb,network_next_attempt_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),generated_at TIMESTAMPTZ,submitted_at TIMESTAMPTZ,completed_at TIMESTAMPTZ,
        UNIQUE(sku,revision),UNIQUE(n8n_task_id))`);
      await client.query("CREATE UNIQUE INDEX wb_listing_one_active_per_sku ON wb_listing_versions(sku) WHERE status IN ('GENERATING','SUBMITTING','QUEUED','RUNNING','NEEDS_ATTENTION')");
      await client.query('CREATE INDEX wb_listing_versions_sku_revision ON wb_listing_versions(sku,revision DESC)');
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('001_wb_listing_management')");
    });
    const hardened = await this.query("SELECT id FROM wb_schema_migrations WHERE id='002_wb_contract_hardening'");
    if (!hardened.rows[0]) await this.transaction(async (client) => {
      await client.query('ALTER TABLE wb_category_template_versions ADD COLUMN IF NOT EXISTS name_ru TEXT');
      await client.query('ALTER TABLE wb_category_template_versions ADD COLUMN IF NOT EXISTS subject_id INTEGER');
      await client.query(`UPDATE wb_category_template_versions v SET name_ru=t.name_ru,subject_id=t.subject_id
        FROM wb_category_templates t WHERE t.id=v.template_id AND (v.name_ru IS NULL OR v.subject_id IS NULL)`);
      await client.query('ALTER TABLE wb_category_template_versions ALTER COLUMN name_ru SET NOT NULL');
      await client.query('ALTER TABLE wb_category_template_versions ALTER COLUMN subject_id SET NOT NULL');
      await client.query('ALTER TABLE wb_category_template_versions DROP CONSTRAINT IF EXISTS wb_category_template_versions_subject_id_check');
      await client.query('ALTER TABLE wb_category_template_versions ADD CONSTRAINT wb_category_template_versions_subject_id_check CHECK(subject_id>0)');
      await client.query('ALTER TABLE wb_category_projection_state ADD COLUMN IF NOT EXISTS schema_hash TEXT');
      await client.query('ALTER TABLE wb_listing_drafts DROP CONSTRAINT IF EXISTS wb_listing_drafts_status_check');
      await client.query("ALTER TABLE wb_listing_drafts ADD CONSTRAINT wb_listing_drafts_status_check CHECK(status IN ('DRAFT','STALE','GENERATING','GENERATED','SUBMITTING','QUEUED','RUNNING','SUCCEEDED','BLOCKED','FAILED','NEEDS_ATTENTION'))");
      await client.query('ALTER TABLE wb_listing_versions DROP CONSTRAINT IF EXISTS wb_listing_versions_status_check');
      await client.query("ALTER TABLE wb_listing_versions ADD CONSTRAINT wb_listing_versions_status_check CHECK(status IN ('GENERATING','GENERATED','SUBMITTING','QUEUED','RUNNING','SUCCEEDED','BLOCKED','FAILED','NEEDS_ATTENTION'))");
      await client.query('DROP INDEX IF EXISTS wb_listing_one_active_per_sku');
      await client.query("CREATE UNIQUE INDEX wb_listing_one_active_per_sku ON wb_listing_versions(sku) WHERE status IN ('GENERATING','SUBMITTING','QUEUED','RUNNING','NEEDS_ATTENTION')");
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('002_wb_contract_hardening')");
    });
    const catalog = await this.query("SELECT id FROM wb_schema_migrations WHERE id='003_wb_local_catalog'");
    if (!catalog.rows[0]) await this.transaction(async (client) => {
      await client.query(`CREATE TABLE wb_catalog_sync_runs(
        id UUID PRIMARY KEY,trigger TEXT NOT NULL CHECK(trigger IN ('MANUAL','SCHEDULED','STARTUP')),
        status TEXT NOT NULL CHECK(status IN ('RUNNING','SUCCEEDED','FAILED')),schedule_key TEXT,
        processed_parents INTEGER NOT NULL DEFAULT 0 CHECK(processed_parents>=0),total_parents INTEGER NOT NULL DEFAULT 0 CHECK(total_parents>=0),
        processed_subjects INTEGER NOT NULL DEFAULT 0 CHECK(processed_subjects>=0),snapshot_path TEXT,source_hash TEXT,
        error_code TEXT,error_message TEXT,started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ)`);
      await client.query("CREATE UNIQUE INDEX wb_catalog_one_running ON wb_catalog_sync_runs((status)) WHERE status='RUNNING'");
      await client.query("CREATE UNIQUE INDEX wb_catalog_one_scheduled_week ON wb_catalog_sync_runs(schedule_key) WHERE trigger='SCHEDULED' AND schedule_key IS NOT NULL");
      await client.query('CREATE INDEX wb_catalog_sync_runs_started ON wb_catalog_sync_runs(started_at DESC)');
      await client.query(`CREATE TABLE wb_catalog_parents(
        parent_id INTEGER PRIMARY KEY CHECK(parent_id>0),name_ru TEXT NOT NULL,name_normalized TEXT NOT NULL,
        name_zh TEXT NOT NULL DEFAULT '',name_zh_normalized TEXT NOT NULL DEFAULT '',is_visible BOOLEAN NOT NULL DEFAULT true,
        active BOOLEAN NOT NULL DEFAULT true,missing_sync_count INTEGER NOT NULL DEFAULT 0 CHECK(missing_sync_count>=0),
        last_seen_run_id UUID REFERENCES wb_catalog_sync_runs(id),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await client.query(`CREATE TABLE wb_catalog_subjects(
        subject_id INTEGER PRIMARY KEY CHECK(subject_id>0),subject_name TEXT NOT NULL,subject_name_normalized TEXT NOT NULL,
        subject_name_zh TEXT NOT NULL DEFAULT '',subject_name_zh_normalized TEXT NOT NULL DEFAULT '',
        parent_id INTEGER NOT NULL REFERENCES wb_catalog_parents(parent_id),parent_name TEXT NOT NULL,parent_name_normalized TEXT NOT NULL,
        parent_name_zh TEXT NOT NULL DEFAULT '',parent_name_zh_normalized TEXT NOT NULL DEFAULT '',search_text TEXT NOT NULL,search_text_zh TEXT NOT NULL DEFAULT '',
        active BOOLEAN NOT NULL DEFAULT true,missing_sync_count INTEGER NOT NULL DEFAULT 0 CHECK(missing_sync_count>=0),
        last_seen_run_id UUID REFERENCES wb_catalog_sync_runs(id),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await client.query('CREATE INDEX wb_catalog_subjects_parent ON wb_catalog_subjects(parent_id)');
      await client.query("CREATE INDEX wb_catalog_subjects_fts ON wb_catalog_subjects USING GIN(to_tsvector('russian',search_text))");
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('003_wb_local_catalog')");
    });
    const bilingual = await this.query("SELECT id FROM wb_schema_migrations WHERE id='004_wb_bilingual_catalog'");
    if (!bilingual.rows[0]) await this.transaction(async (client) => {
      await client.query("ALTER TABLE wb_category_templates ADD COLUMN IF NOT EXISTS name_zh TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE wb_category_template_versions ADD COLUMN IF NOT EXISTS name_zh TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE wb_catalog_parents ADD COLUMN IF NOT EXISTS name_zh TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE wb_catalog_parents ADD COLUMN IF NOT EXISTS name_zh_normalized TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE wb_catalog_subjects ADD COLUMN IF NOT EXISTS subject_name_zh TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE wb_catalog_subjects ADD COLUMN IF NOT EXISTS subject_name_zh_normalized TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE wb_catalog_subjects ADD COLUMN IF NOT EXISTS parent_name_zh TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE wb_catalog_subjects ADD COLUMN IF NOT EXISTS parent_name_zh_normalized TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE wb_catalog_subjects ADD COLUMN IF NOT EXISTS search_text_zh TEXT NOT NULL DEFAULT ''");
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('004_wb_bilingual_catalog') ON CONFLICT(id) DO NOTHING");
    });
    const colors = await this.query("SELECT id FROM wb_schema_migrations WHERE id='005_wb_color_catalog'");
    if (!colors.rows[0]) await this.transaction(async (client) => {
      await client.query(`CREATE TABLE wb_catalog_colors(
        color_key TEXT PRIMARY KEY,position INTEGER NOT NULL UNIQUE CHECK(position>=0),
        name_ru TEXT NOT NULL,name_ru_normalized TEXT NOT NULL,name_zh TEXT NOT NULL,name_zh_normalized TEXT NOT NULL,
        parent_name_ru TEXT NOT NULL,parent_name_ru_normalized TEXT NOT NULL,parent_name_zh TEXT NOT NULL,parent_name_zh_normalized TEXT NOT NULL,
        last_seen_run_id UUID NOT NULL REFERENCES wb_catalog_sync_runs(id),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await client.query('CREATE INDEX wb_catalog_colors_ru ON wb_catalog_colors(name_ru_normalized)');
      await client.query('CREATE INDEX wb_catalog_colors_zh ON wb_catalog_colors(name_zh_normalized)');
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('005_wb_color_catalog')");
    });
    const dictionaries = await this.query("SELECT id FROM wb_schema_migrations WHERE id='006_wb_field_dictionaries'");
    if (!dictionaries.rows[0]) await this.transaction(async (client) => {
      await client.query(`CREATE TABLE wb_catalog_dictionary_values(
        directory TEXT NOT NULL CHECK(directory IN ('countries','seasons','kinds')),value_key TEXT NOT NULL,
        position INTEGER NOT NULL CHECK(position>=0),wb_id INTEGER,
        name_ru TEXT NOT NULL,name_ru_normalized TEXT NOT NULL,name_zh TEXT NOT NULL,name_zh_normalized TEXT NOT NULL,
        full_name_ru TEXT NOT NULL DEFAULT '',full_name_ru_normalized TEXT NOT NULL DEFAULT '',
        full_name_zh TEXT NOT NULL DEFAULT '',full_name_zh_normalized TEXT NOT NULL DEFAULT '',
        last_seen_run_id UUID NOT NULL REFERENCES wb_catalog_sync_runs(id),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(directory,value_key),UNIQUE(directory,position))`);
      await client.query('CREATE INDEX wb_catalog_dictionary_values_ru ON wb_catalog_dictionary_values(directory,name_ru_normalized)');
      await client.query('CREATE INDEX wb_catalog_dictionary_values_zh ON wb_catalog_dictionary_values(directory,name_zh_normalized)');
      await client.query('CREATE INDEX wb_catalog_dictionary_values_wb_id ON wb_catalog_dictionary_values(directory,wb_id) WHERE wb_id IS NOT NULL');
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('006_wb_field_dictionaries')");
    });
    const listingNotificationOutbox = await this.query("SELECT id FROM wb_schema_migrations WHERE id='012_wb_listing_notification_outbox'");
    if (!listingNotificationOutbox.rows[0]) await this.transaction(async (client) => {
      // Existing terminal revisions deliberately retain the false default. Only a
      // future status transition arms delivery, avoiding a deployment-time flood.
      await client.query('ALTER TABLE wb_listing_drafts ADD COLUMN IF NOT EXISTS auto_publish_locked BOOLEAN NOT NULL DEFAULT false');
      await client.query('ALTER TABLE wb_listing_versions ADD COLUMN IF NOT EXISTS terminal_notification_pending BOOLEAN NOT NULL DEFAULT false');
      await client.query('ALTER TABLE wb_listing_versions ADD COLUMN IF NOT EXISTS terminal_notification_delivered_at TIMESTAMPTZ');
      await client.query(`CREATE INDEX IF NOT EXISTS wb_listing_terminal_notification_pending
        ON wb_listing_versions(completed_at,id) WHERE terminal_notification_pending=true`);
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('012_wb_listing_notification_outbox')");
    });
    const listingAutomationContext = await this.query("SELECT id FROM wb_schema_migrations WHERE id='017_wb_listing_automation_context'");
    if (!listingAutomationContext.rows[0]) await this.transaction(async (client) => {
      await client.query("ALTER TABLE wb_listing_versions ADD COLUMN IF NOT EXISTS automation_context JSONB NOT NULL DEFAULT '{}'::jsonb");
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('017_wb_listing_automation_context')");
    });
    const listingOperationSource = await this.query("SELECT id FROM wb_schema_migrations WHERE id='020_wb_listing_operation_source'");
    if (!listingOperationSource.rows[0]) await this.transaction(async (client) => {
      await client.query("ALTER TABLE wb_listing_drafts ADD COLUMN IF NOT EXISTS latest_operation_source TEXT NOT NULL DEFAULT 'MANUAL'");
      await client.query('ALTER TABLE wb_listing_drafts ADD COLUMN IF NOT EXISTS latest_operation_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
      await client.query('ALTER TABLE wb_listing_drafts ADD COLUMN IF NOT EXISTS latest_operation_ref TEXT');
      await client.query('ALTER TABLE wb_listing_drafts DROP CONSTRAINT IF EXISTS wb_listing_drafts_latest_operation_source_check');
      await client.query("ALTER TABLE wb_listing_drafts ADD CONSTRAINT wb_listing_drafts_latest_operation_source_check CHECK(latest_operation_source IN ('MANUAL','AUTOMATION'))");
      await client.query(`UPDATE wb_listing_drafts SET
        latest_operation_source='MANUAL',
        latest_operation_at=COALESCE(updated_at,created_at,NOW()),
        latest_operation_ref=COALESCE(latest_operation_ref,'migration:manual')`);
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('020_wb_listing_operation_source')");
    });
    const purchaseMeasurements = await this.query("SELECT id FROM wb_schema_migrations WHERE id='022_wb_listing_purchase_measurements'");
    if (!purchaseMeasurements.rows[0]) await this.transaction(async (client) => {
      await client.query("ALTER TABLE wb_listing_versions ADD COLUMN IF NOT EXISTS purchase_measurements JSONB NOT NULL DEFAULT '{}'::jsonb");
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('022_wb_listing_purchase_measurements')");
    });
    const runtimePg = await this.query("SELECT id FROM wb_schema_migrations WHERE id='023_wb_runtime_postgresql'");
    if (!runtimePg.rows[0]) await this.transaction(async (client) => {
      await client.query(`CREATE TABLE IF NOT EXISTS wb_runtime_config(
        config_id TEXT PRIMARY KEY DEFAULT 'default',
        schema_version INTEGER NOT NULL DEFAULT 1,
        config_version INTEGER NOT NULL DEFAULT 1,
        publish_enabled BOOLEAN NOT NULL DEFAULT false,
        credential_ready BOOLEAN NOT NULL DEFAULT false,
        import_root TEXT NOT NULL DEFAULT '',
        root_source TEXT NOT NULL DEFAULT 'merchroute-postgresql',
        root_sync_hash TEXT NOT NULL DEFAULT '',
        root_synced_at TIMESTAMPTZ,
        warehouse_id TEXT NOT NULL DEFAULT '',
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        dispatch_batch_size INTEGER NOT NULL DEFAULT 1 CHECK(dispatch_batch_size BETWEEN 1 AND 100),
        dispatch_concurrency INTEGER NOT NULL DEFAULT 1 CHECK(dispatch_concurrency=1),
        media_batch_size INTEGER NOT NULL DEFAULT 7 CHECK(media_batch_size BETWEEN 1 AND 7),
        media_upload_interval_ms INTEGER NOT NULL DEFAULT 650 CHECK(media_upload_interval_ms>=650),
        video_optimize_enabled BOOLEAN NOT NULL DEFAULT true,
        video_optimize_threshold_bytes BIGINT NOT NULL DEFAULT 5242880 CHECK(video_optimize_threshold_bytes>=0),
        video_optimize_target_kbps INTEGER NOT NULL DEFAULT 1500 CHECK(video_optimize_target_kbps>0),
        video_optimize_maxrate_kbps INTEGER NOT NULL DEFAULT 1800 CHECK(video_optimize_maxrate_kbps>0),
        lock_ttl_seconds INTEGER NOT NULL DEFAULT 600 CHECK(lock_ttl_seconds>0),
        max_daily_styles INTEGER NOT NULL DEFAULT 100 CHECK(max_daily_styles>0),
        price_currency_expected TEXT NOT NULL DEFAULT 'CNY',
        preflight_report_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        network_attempt INTEGER NOT NULL DEFAULT 0 CHECK(network_attempt>=0),
        network_next_attempt_at TIMESTAMPTZ,
        network_last_error_code TEXT NOT NULL DEFAULT '',
        network_last_error_message TEXT NOT NULL DEFAULT '',
        network_updated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS wb_publish_jobs(
        task_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL DEFAULT 0,
        folder_name TEXT NOT NULL DEFAULT '',
        work_relpath TEXT NOT NULL DEFAULT '',
        product_code TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 0,
        payload_signature TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'QUEUED',
        resume_state TEXT NOT NULL DEFAULT '',
        stage_attempt INTEGER NOT NULL DEFAULT 0,
        total_attempt INTEGER NOT NULL DEFAULT 0,
        poll_count INTEGER NOT NULL DEFAULT 0,
        next_run_at TIMESTAMPTZ,
        stage_deadline_at TIMESTAMPTZ,
        lease_owner TEXT NOT NULL DEFAULT '',
        lease_expires_at TIMESTAMPTZ,
        template_version INTEGER NOT NULL DEFAULT 0,
        config_version INTEGER NOT NULL DEFAULT 1,
        partial_effects BOOLEAN NOT NULL DEFAULT false,
        wb_request_ref TEXT NOT NULL DEFAULT '',
        result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_error_code TEXT NOT NULL DEFAULT '',
        last_error_message TEXT NOT NULL DEFAULT '',
        submitted_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        row_version INTEGER NOT NULL DEFAULT 1
      )`);
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS wb_publish_jobs_idempotency ON wb_publish_jobs(idempotency_key) WHERE idempotency_key <> \'\'');
      await client.query('CREATE INDEX IF NOT EXISTS wb_publish_jobs_state_due ON wb_publish_jobs(state,next_run_at)');
      await client.query('CREATE INDEX IF NOT EXISTS wb_publish_jobs_product_revision ON wb_publish_jobs(product_code,revision)');
      await client.query('CREATE INDEX IF NOT EXISTS wb_publish_jobs_updated ON wb_publish_jobs(updated_at DESC)');
      await client.query(`CREATE TABLE IF NOT EXISTS wb_publish_events(
        id UUID PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES wb_publish_jobs(task_id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT,
        message TEXT NOT NULL DEFAULT '',
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query('CREATE INDEX IF NOT EXISTS wb_publish_events_task_created ON wb_publish_events(task_id,created_at DESC)');
      await client.query(`CREATE TABLE IF NOT EXISTS wb_product_registry(
        registry_key TEXT PRIMARY KEY,
        product_code TEXT NOT NULL DEFAULT '',
        category_key TEXT NOT NULL DEFAULT '',
        variant_code TEXT NOT NULL DEFAULT '',
        vendor_code TEXT NOT NULL DEFAULT '',
        tech_size TEXT NOT NULL DEFAULT '',
        barcode TEXT NOT NULL DEFAULT '',
        nm_id TEXT NOT NULL DEFAULT '',
        imt_id TEXT NOT NULL DEFAULT '',
        chrt_id TEXT NOT NULL DEFAULT '',
        size_id TEXT NOT NULL DEFAULT '',
        subject_id TEXT NOT NULL DEFAULT '',
        last_applied_revision INTEGER NOT NULL DEFAULT 0,
        desired_signature TEXT NOT NULL DEFAULT '',
        media_signature TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        last_verified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS wb_product_registry_vendor_nm ON wb_product_registry(vendor_code,nm_id) WHERE vendor_code<>'' AND nm_id<>''");
      await client.query('CREATE INDEX IF NOT EXISTS wb_product_registry_product ON wb_product_registry(product_code)');
      await client.query(`CREATE TABLE IF NOT EXISTS wb_system_errors(
        error_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL DEFAULT '',
        workflow_name TEXT NOT NULL DEFAULT '',
        execution_id TEXT NOT NULL DEFAULT '',
        execution_url TEXT NOT NULL DEFAULT '',
        last_node TEXT NOT NULL DEFAULT '',
        error_name TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query('CREATE INDEX IF NOT EXISTS wb_system_errors_captured ON wb_system_errors(captured_at DESC)');
      await client.query("INSERT INTO wb_runtime_config(config_id) VALUES('default') ON CONFLICT(config_id) DO NOTHING");
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('023_wb_runtime_postgresql')");
    });
    const registrySizeRows = await this.query("SELECT id FROM wb_schema_migrations WHERE id='024_wb_registry_vendor_nm_nonunique'");
    if (!registrySizeRows.rows[0]) await this.transaction(async (client) => {
      await client.query('DROP INDEX IF EXISTS wb_product_registry_vendor_nm');
      await client.query("CREATE INDEX wb_product_registry_vendor_nm ON wb_product_registry(vendor_code,nm_id) WHERE vendor_code<>'' AND nm_id<>''");
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('024_wb_registry_vendor_nm_nonunique')");
    });
    const runtimeDispatchConcurrency = await this.query("SELECT id FROM wb_schema_migrations WHERE id='025_wb_runtime_dispatch_concurrency'");
    if (!runtimeDispatchConcurrency.rows[0]) await this.transaction(async (client) => {
      await client.query('ALTER TABLE wb_runtime_config ADD COLUMN IF NOT EXISTS dispatch_concurrency INTEGER');
      await client.query('UPDATE wb_runtime_config SET dispatch_concurrency=1 WHERE dispatch_concurrency IS DISTINCT FROM 1');
      await client.query('ALTER TABLE wb_runtime_config ALTER COLUMN dispatch_concurrency SET DEFAULT 1');
      await client.query('ALTER TABLE wb_runtime_config ALTER COLUMN dispatch_concurrency SET NOT NULL');
      await client.query('ALTER TABLE wb_runtime_config DROP CONSTRAINT IF EXISTS wb_runtime_config_dispatch_concurrency_check');
      await client.query('ALTER TABLE wb_runtime_config ADD CONSTRAINT wb_runtime_config_dispatch_concurrency_check CHECK(dispatch_concurrency=1)');
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('025_wb_runtime_dispatch_concurrency')");
    });
    const networkRecovery = await this.query("SELECT id FROM wb_schema_migrations WHERE id='026_wb_network_recovery'");
    if (!networkRecovery.rows[0]) await this.transaction(async (client) => {
      await client.query("ALTER TABLE wb_listing_drafts ADD COLUMN IF NOT EXISTS network_recovery JSONB NOT NULL DEFAULT '{}'::jsonb");
      await client.query('ALTER TABLE wb_listing_drafts ADD COLUMN IF NOT EXISTS network_next_attempt_at TIMESTAMPTZ');
      await client.query("ALTER TABLE wb_listing_versions ADD COLUMN IF NOT EXISTS network_recovery JSONB NOT NULL DEFAULT '{}'::jsonb");
      await client.query('ALTER TABLE wb_listing_versions ADD COLUMN IF NOT EXISTS network_next_attempt_at TIMESTAMPTZ');
      await client.query('ALTER TABLE wb_listing_drafts DROP CONSTRAINT IF EXISTS wb_listing_drafts_status_check');
      await client.query("ALTER TABLE wb_listing_drafts ADD CONSTRAINT wb_listing_drafts_status_check CHECK(status IN ('DRAFT','STALE','GENERATING','GENERATED','SUBMITTING','QUEUED','RUNNING','SUCCEEDED','BLOCKED','FAILED','NEEDS_ATTENTION'))");
      await client.query('ALTER TABLE wb_listing_versions DROP CONSTRAINT IF EXISTS wb_listing_versions_status_check');
      await client.query("ALTER TABLE wb_listing_versions ADD CONSTRAINT wb_listing_versions_status_check CHECK(status IN ('GENERATING','GENERATED','SUBMITTING','QUEUED','RUNNING','SUCCEEDED','BLOCKED','FAILED','NEEDS_ATTENTION'))");
      await client.query('DROP INDEX IF EXISTS wb_listing_one_active_per_sku');
      await client.query("CREATE UNIQUE INDEX wb_listing_one_active_per_sku ON wb_listing_versions(sku) WHERE status IN ('GENERATING','SUBMITTING','QUEUED','RUNNING','NEEDS_ATTENTION')");
      await client.query(`CREATE INDEX IF NOT EXISTS wb_listing_network_due
        ON wb_listing_drafts(network_next_attempt_at,status)
        WHERE status IN ('SUBMITTING','QUEUED','RUNNING') AND n8n_task_id IS NOT NULL`);
      await client.query('ALTER TABLE wb_runtime_config ADD COLUMN IF NOT EXISTS network_attempt INTEGER NOT NULL DEFAULT 0');
      await client.query('ALTER TABLE wb_runtime_config ADD COLUMN IF NOT EXISTS network_next_attempt_at TIMESTAMPTZ');
      await client.query("ALTER TABLE wb_runtime_config ADD COLUMN IF NOT EXISTS network_last_error_code TEXT NOT NULL DEFAULT ''");
      await client.query("ALTER TABLE wb_runtime_config ADD COLUMN IF NOT EXISTS network_last_error_message TEXT NOT NULL DEFAULT ''");
      await client.query('ALTER TABLE wb_runtime_config ADD COLUMN IF NOT EXISTS network_updated_at TIMESTAMPTZ');
      await client.query('ALTER TABLE wb_runtime_config DROP CONSTRAINT IF EXISTS wb_runtime_config_network_attempt_check');
      await client.query('ALTER TABLE wb_runtime_config ADD CONSTRAINT wb_runtime_config_network_attempt_check CHECK(network_attempt>=0)');
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('026_wb_network_recovery')");
    });
    const runtimeSingleWriteSlot = await this.query("SELECT id FROM wb_schema_migrations WHERE id='027_wb_runtime_single_write_slot'");
    if (!runtimeSingleWriteSlot.rows[0]) await this.transaction(async (client) => {
      await client.query('UPDATE wb_runtime_config SET dispatch_concurrency=1 WHERE dispatch_concurrency IS DISTINCT FROM 1');
      await client.query('ALTER TABLE wb_runtime_config ALTER COLUMN dispatch_concurrency SET DEFAULT 1');
      await client.query('ALTER TABLE wb_runtime_config ALTER COLUMN dispatch_concurrency SET NOT NULL');
      await client.query('ALTER TABLE wb_runtime_config DROP CONSTRAINT IF EXISTS wb_runtime_config_dispatch_concurrency_check');
      await client.query('ALTER TABLE wb_runtime_config ADD CONSTRAINT wb_runtime_config_dispatch_concurrency_check CHECK(dispatch_concurrency=1)');
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('027_wb_runtime_single_write_slot')");
    });
    const sourceMediaState = await this.query("SELECT id FROM wb_schema_migrations WHERE id='028_wb_source_media_state'");
    if (!sourceMediaState.rows[0]) await this.transaction(async (client) => {
      await client.query(`ALTER TABLE wb_listing_drafts
        ADD COLUMN IF NOT EXISTS source_media_state TEXT NOT NULL DEFAULT 'AVAILABLE',
        ADD COLUMN IF NOT EXISTS source_media_cleaned_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS source_media_cleanup_id UUID`);
      await client.query('ALTER TABLE wb_listing_drafts DROP CONSTRAINT IF EXISTS wb_listing_drafts_source_media_state_check');
      await client.query(`ALTER TABLE wb_listing_drafts ADD CONSTRAINT wb_listing_drafts_source_media_state_check
        CHECK(source_media_state IN ('AVAILABLE','CLEANUP_PENDING','CLEANED'))`);
      await client.query("INSERT INTO wb_schema_migrations(id) VALUES('028_wb_source_media_state')");
    });
    await this.query('CREATE INDEX IF NOT EXISTS wb_listing_drafts_updated ON wb_listing_drafts(updated_at DESC)');
    await this.query('CREATE INDEX IF NOT EXISTS wb_listing_drafts_source_updated ON wb_listing_drafts(latest_operation_source,updated_at DESC)');
    try {
      await this.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await this.query('CREATE INDEX IF NOT EXISTS wb_catalog_subjects_name_trgm ON wb_catalog_subjects USING GIN(subject_name_normalized gin_trgm_ops)');
      await this.query('CREATE INDEX IF NOT EXISTS wb_catalog_parent_name_trgm ON wb_catalog_subjects USING GIN(parent_name_normalized gin_trgm_ops)');
      await this.query('CREATE INDEX IF NOT EXISTS wb_catalog_subjects_name_zh_trgm ON wb_catalog_subjects USING GIN(subject_name_zh_normalized gin_trgm_ops)');
      await this.query('CREATE INDEX IF NOT EXISTS wb_catalog_parent_name_zh_trgm ON wb_catalog_subjects USING GIN(parent_name_zh_normalized gin_trgm_ops)');
    } catch {
      // Managed PostgreSQL deployments may forbid CREATE EXTENSION; FTS and ILIKE remain available.
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
    if (!this.pool) throw new AppError('DATABASE_UNAVAILABLE', 'WB 上品管理尚未配置 PostgreSQL DATABASE_URL', undefined, 503);
    return this.pool;
  }
}

function listingSelect() {
  return `SELECT d.*,p.product_name,t.name_ru category_name_ru,v.revision current_revision,v.product_json current_product_json,
    v.result_json current_result,v.updated_at version_updated_at,
    v.terminal_notification_pending current_terminal_notification_pending,
    v.terminal_notification_delivered_at current_terminal_notification_delivered_at
    FROM wb_listing_drafts d JOIN products p ON p.sku=d.sku
    LEFT JOIN wb_category_templates t ON t.category_key=d.category_key LEFT JOIN wb_listing_versions v ON v.id=d.generated_version_id`;
}

function pendingTerminalNotificationSelect() {
  return `SELECT
    v.id version_id,v.sku,v.revision,v.status,v.n8n_task_id,v.nm_ids,v.product_urls,v.error_message,v.result_json,
    v.completed_at,v.updated_at,v.automation_context,p.product_name,COALESCE(d.auto_publish_locked,false) auto_publish_locked
    FROM wb_listing_versions v
    JOIN products p ON p.sku=v.sku
    LEFT JOIN wb_listing_drafts d ON d.sku=v.sku`;
}

function toPendingTerminalNotification(row: SqlRow): WbPendingTerminalNotification {
  return {
    sku: String(row.sku),
    versionId: String(row.version_id),
    expectedStatus: row.status as WbPendingTerminalNotification['expectedStatus'],
    listing: {
      sku: String(row.sku),
      productName: String(row.product_name || ''),
      status: String(row.status),
      revision: Number(row.revision),
      generatedVersionId: String(row.version_id),
      ...(row.n8n_task_id ? { n8nTaskId: String(row.n8n_task_id) } : {}),
      nmIds: Array.isArray(row.nm_ids) ? row.nm_ids : [],
      productUrls: Array.isArray(row.product_urls) ? row.product_urls : [],
      ...(row.error_message ? { lastError: String(row.error_message) } : {}),
      task: parseJsonRecord(row.result_json),
      autoPublishLocked: Boolean(row.auto_publish_locked),
      automationContext: asObject(row.automation_context)
    }
  };
}

async function getListingWith(client: PoolClient, sku: string) {
  const result = await client.query<SqlRow>(`${listingSelect()} WHERE d.sku=$1`, [sku]);
  if (!result.rows[0]) throw new AppError('NOT_FOUND', 'WB 上品草稿不存在', { sku }, 404);
  return toListing(result.rows[0]);
}

function toListingSummary(row: SqlRow) {
  const networkRecovery = parseJsonRecord(row.network_recovery);
  return {
    sku: row.sku, productName: row.product_name, status: row.status, draftVersion: Number(row.draft_version),
    revision: row.current_revision ? Number(row.current_revision) : undefined, categoryKey: row.category_key || undefined,
    generatedVersionId: row.generated_version_id || undefined,
    categoryNameRu: row.category_name_ru || undefined, mediaCount: Array.isArray(row.media_assets) ? row.media_assets.length : 0,
    n8nTaskId: row.n8n_task_id || undefined, nmIds: row.nm_ids || [], productUrls: row.product_urls || [],
    lastError: row.last_error || undefined, updatedAt: row.updated_at,
    ...(Object.keys(networkRecovery).length ? { networkRecovery } : {}),
    ...(row.network_next_attempt_at ? { networkNextAttemptAt: new Date(row.network_next_attempt_at).toISOString() } : {}),
    autoPublishLocked: Boolean(row.auto_publish_locked),
    latestOperationSource: row.latest_operation_source === 'AUTOMATION' ? 'AUTOMATION' : 'MANUAL',
    latestOperationAt: row.latest_operation_at || row.updated_at,
    latestOperationRef: row.latest_operation_ref || undefined,
    sourceMediaState: row.source_media_state || 'AVAILABLE',
    sourceMediaCleanedAt: row.source_media_cleaned_at || undefined
  };
}

function toListing(row: SqlRow) {
  const data = { ...EMPTY_DRAFT, ...asObject(row.data) };
  return {
    ...toListingSummary(row),
    categoryVersionId: row.category_version_id || undefined,
    ...data,
    mediaAssets: row.media_assets || [],
    variantMedia: row.variant_media || [],
    generatedAt: row.generated_at || undefined,
    submittedAt: row.submitted_at || undefined,
    productJson: row.current_product_json || undefined,
    task: row.current_result || undefined,
    createdAt: row.created_at
  };
}

function categorySummarySelect() {
  return `SELECT t.*,
    d.id draft_version_id,d.version_no draft_version_no,d.updated_at draft_updated_at,
    p.id published_version_id,p.version_no published_version_no,p.name_ru published_name_ru,p.name_zh published_name_zh,p.subject_id published_subject_id,
    p.schema_hash published_schema_hash,p.confirmed_by,p.confirmed_at,p.published_at,
    s.status projection_status,s.source_version_id,s.schema_hash projection_schema_hash,s.definition_hash projection_hash,s.synced_at,s.last_error projection_error
    FROM wb_category_templates t
    LEFT JOIN wb_category_template_versions d ON d.template_id=t.id AND d.status='DRAFT'
    LEFT JOIN wb_category_template_versions p ON p.template_id=t.id AND p.status='PUBLISHED'
    LEFT JOIN wb_category_projection_state s ON s.category_key=t.category_key`;
}

async function assertNoCategoryReferences(client: PoolClient, templateId: string, categoryKey: string): Promise<void> {
  // A checked-out pg PoolClient executes one query at a time. Keep these reads sequential
  // so this transaction remains compatible with pg 9, which removes concurrent client queries.
  const drafts = await client.query<{ count: string }>('SELECT COUNT(*)::text count FROM wb_listing_drafts WHERE category_key=$1', [categoryKey]);
  const history = await client.query<{ count: string }>(`SELECT COUNT(*)::text count FROM wb_listing_versions v
    JOIN wb_category_template_versions c ON c.id=v.category_version_id WHERE c.template_id=$1`, [templateId]);
  const skus = await client.query<{ sku: string }>(`SELECT DISTINCT sku::text sku FROM (
    SELECT sku FROM wb_listing_drafts WHERE category_key=$1
    UNION ALL
    SELECT v.sku FROM wb_listing_versions v JOIN wb_category_template_versions c ON c.id=v.category_version_id WHERE c.template_id=$2
  ) referenced ORDER BY sku LIMIT 10`, [categoryKey, templateId]);
  const draftCount = Number(drafts.rows[0]?.count || 0);
  const historyCount = Number(history.rows[0]?.count || 0);
  const presetTable = await client.query<{ relation: string | null }>("SELECT to_regclass('wb_listing_presets')::text relation");
  const presetCount = presetTable.rows[0]?.relation
    ? Number((await client.query<{ count: string }>('SELECT COUNT(*)::text count FROM wb_listing_presets WHERE category_key=$1', [categoryKey])).rows[0]?.count || 0)
    : 0;
  if (!draftCount && !historyCount && !presetCount) return;
  throw new AppError('TASK_LOCKED', '该类目模板已被上品资料或历史版本引用，不能删除', {
    categoryKey, draftCount, historyCount, presetCount, skus: skus.rows.map((row) => row.sku.trim())
  }, 409);
}

async function getCategoryWith(client: PoolClient, categoryKey: string) {
  const template = await client.query<SqlRow>(`${categorySummarySelect()} WHERE t.category_key=$1`, [categoryKey]);
  if (!template.rows[0]) throw new AppError('NOT_FOUND', 'WB 类目模板不存在', { categoryKey }, 404);
  const versions = await client.query<SqlRow>('SELECT * FROM wb_category_template_versions WHERE template_id=$1 ORDER BY version_no DESC', [template.rows[0].id]);
  return { ...toCategorySummary(template.rows[0]), versions: versions.rows.map(toCategoryVersion) };
}

function toCategorySummary(row: SqlRow) {
  return {
    categoryKey: row.category_key, nameRu: row.name_ru, nameZh: row.name_zh || '', subjectId: Number(row.subject_id), active: Boolean(row.active),
    draftVersion: row.draft_version_id ? { id: row.draft_version_id, versionNo: Number(row.draft_version_no), updatedAt: row.draft_updated_at } : undefined,
    publishedVersion: row.published_version_id ? {
      id: row.published_version_id, versionNo: Number(row.published_version_no), schemaHash: row.published_schema_hash,
      nameRu: row.published_name_ru, nameZh: row.published_name_zh || '', subjectId: Number(row.published_subject_id),
      confirmedBy: row.confirmed_by, confirmedAt: row.confirmed_at, publishedAt: row.published_at
    } : undefined,
    projection: {
      status: row.projection_status || 'NOT_SYNCED', sourceVersionId: row.source_version_id || undefined,
      schemaHash: row.projection_schema_hash || undefined, definitionHash: row.projection_hash || undefined,
      syncedAt: row.synced_at || undefined, lastError: row.projection_error || undefined
    },
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function toCategoryVersion(row: SqlRow) {
  const formConfig = normalizeWbFormConfigTnvedPolicy(row.form_config, row.live_schema);
  return {
    id: row.id, versionNo: Number(row.version_no), status: row.status, nameRu: row.name_ru, nameZh: row.name_zh || '', subjectId: Number(row.subject_id), liveSchema: row.live_schema, formConfig,
    managedCharacteristicIds: row.managed_characteristic_ids || [], schemaHash: row.schema_hash, confirmedBy: row.confirmed_by || undefined,
    confirmedAt: row.confirmed_at || undefined, createdAt: row.created_at, updatedAt: row.updated_at, publishedAt: row.published_at || undefined
  };
}

function toPublishedCategory(row: SqlRow) {
  const formConfig = normalizeWbFormConfigTnvedPolicy(row.form_config, row.live_schema);
  return {
    categoryKey: row.category_key, nameRu: row.name_ru, nameZh: row.name_zh || '', subjectId: Number(row.subject_id), id: row.id,
    versionNo: Number(row.version_no), liveSchema: row.live_schema, formConfig,
    managedCharacteristicIds: row.managed_characteristic_ids || [], schemaHash: row.schema_hash,
    confirmedBy: row.confirmed_by, confirmedAt: row.confirmed_at
  };
}

function parseCategoryDraft(input: unknown): WbCategoryDraftInput {
  const parsed = wbCategoryDraftInputSchema.safeParse(input);
  if (!parsed.success) throw validationError(parsed.error.issues);
  const root = asObject(parsed.data.liveSchema);
  if (!Array.isArray(parsed.data.liveSchema) && (parsed.data.liveSchema === null || typeof parsed.data.liveSchema !== 'object' || (Object.keys(root).length > 0 && !Array.isArray(root.data) && !Array.isArray(root.characteristics)))) {
    throw new AppError('CONFIG_INVALID', 'WB live schema 必须是 characteristic 数组或 WB data 包装对象');
  }
  const liveSchema = Array.isArray(parsed.data.liveSchema) ? parsed.data.liveSchema
    : Array.isArray(root.data) ? root.data : Array.isArray(root.characteristics) ? root.characteristics : [];
  const ids = liveSchema.map((value) => Number(asObject(value).charcID ?? asObject(value).id));
  if (ids.some((id) => !Number.isInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
    throw new AppError('CONFIG_INVALID', 'WB live schema 中的 characteristic ID 必须是唯一正整数');
  }
  return { ...parsed.data, liveSchema };
}

export function deriveCategoryVersion(input: WbCategoryDraftInput) {
  const managedCharacteristicIds = [...new Set(input.formConfig.fields.map((field) => field.characteristicId))].sort((a, b) => a - b);
  const liveSchema = canonicalizeWbLiveSchema(input.liveSchema);
  const liveIds = new Set((liveSchema as unknown[]).map((value) => Number(asObject(value).charcID ?? asObject(value).id)));
  const missing = managedCharacteristicIds.filter((id) => !liveIds.has(id));
  if (missing.length) throw new AppError('CONFIG_INVALID', '表单 characteristic ID 不存在于 WB live schema', { missing });
  const detectedTnvedId = detectTnvedCharacteristicId(liveSchema);
  const configuredTnvedId = input.formConfig.compliance.tnvedCharacteristicId;
  const tnvedId = detectedTnvedId && managedCharacteristicIds.includes(detectedTnvedId) ? detectedTnvedId : configuredTnvedId;
  if (tnvedId && !managedCharacteristicIds.includes(tnvedId)) {
    throw new AppError('CONFIG_INVALID', 'TNVED characteristic 必须同时配置为可视化表单字段', { tnvedCharacteristicId: tnvedId });
  }
  const tnvedLiveCharacteristic = tnvedId === null || tnvedId === undefined
    ? undefined
    : liveSchemaCharacteristics(liveSchema).find((item) => Number(item.charcID ?? item.id) === tnvedId);
  const tnvedRequired = Boolean(tnvedLiveCharacteristic?.required === true || tnvedLiveCharacteristic?.isRequired === true);
  const formConfig = {
    ...input.formConfig,
    compliance: {
      tnvedCharacteristicId: tnvedId || null,
      tnvedRequired: Boolean(tnvedId && tnvedRequired)
    }
  };
  return { liveSchema, formConfig, managedCharacteristicIds, schemaHash: computeWbLiveSchemaHash(liveSchema) };
}

export type WbTnvedPolicy = {
  characteristicId: number | null;
  supported: boolean;
  required: boolean;
};

/**
 * Resolve the effective TNVED rule from the immutable WB schema snapshot.
 * `formConfig` only proves that the characteristic is managed by this template;
 * it must never promote an optional WB characteristic to required.
 */
export function resolveWbTnvedPolicy(formConfigInput: unknown, liveSchemaInput: unknown): WbTnvedPolicy {
  const formConfig = asObject(formConfigInput);
  const fields = Array.isArray(formConfig.fields) ? formConfig.fields.map(asObject) : [];
  const managedIds = new Set(fields.map((field) => Number(field.characteristicId)).filter((id) => Number.isInteger(id) && id > 0));
  const liveSchema = liveSchemaCharacteristics(liveSchemaInput);
  const configuredId = Number(asObject(formConfig.compliance).tnvedCharacteristicId || 0);
  const detectedId = detectTnvedCharacteristicId(liveSchema);
  const candidateIds = [...new Set([
    ...(Number.isInteger(configuredId) && configuredId > 0 ? [configuredId] : []),
    ...(detectedId ? [detectedId] : [])
  ])];
  const characteristicId = candidateIds.find((candidateId) => managedIds.has(candidateId)
    && liveSchema.some((item) => Number(item.charcID ?? item.id) === candidateId)) ?? null;
  const characteristic = characteristicId
    ? liveSchema.find((item) => Number(item.charcID ?? item.id) === characteristicId)
    : undefined;
  return {
    characteristicId,
    supported: characteristicId !== null,
    required: Boolean(characteristicId && (characteristic?.required === true || characteristic?.isRequired === true))
  };
}

export function normalizeWbFormConfigTnvedPolicy(formConfigInput: unknown, liveSchemaInput: unknown): JsonRecord {
  const formConfig = asObject(formConfigInput);
  const policy = resolveWbTnvedPolicy(formConfig, liveSchemaInput);
  return {
    ...formConfig,
    compliance: {
      ...asObject(formConfig.compliance),
      tnvedCharacteristicId: policy.characteristicId,
      tnvedRequired: policy.required
    }
  };
}

function detectTnvedCharacteristicId(liveSchema: unknown): number | undefined {
  const characteristics = liveSchemaCharacteristics(liveSchema);
  for (const value of characteristics) {
    const item = asObject(value);
    const id = Number(item.charcID ?? item.id);
    const name = String(item.name ?? item.label ?? '').trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').replace(/[\s_-]+/g, ' ');
    if (id === 15004139 || name.includes('тн вэд') || name.includes('тнвэд')) return id;
  }
  return undefined;
}

function liveSchemaCharacteristics(input: unknown): JsonRecord[] {
  if (Array.isArray(input)) return input.map(asObject);
  const root = asObject(input);
  if (Array.isArray(root.data)) return root.data.map(asObject);
  if (Array.isArray(root.characteristics)) return root.characteristics.map(asObject);
  return [];
}

export function canonicalizeWbLiveSchema(input: unknown): unknown {
  if (Array.isArray(input)) return [...input].sort(compareCharacteristicId);
  if (!input || typeof input !== 'object') return input;
  const output = { ...(input as JsonRecord) };
  if (Array.isArray(output.data)) output.data = [...output.data].sort(compareCharacteristicId);
  if (Array.isArray(output.characteristics)) output.characteristics = [...output.characteristics].sort(compareCharacteristicId);
  return output;
}

export function computeWbLiveSchemaHash(input: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(canonicalizeWbLiveSchema(input))).digest('hex')}`;
}

function compareCharacteristicId(left: unknown, right: unknown): number {
  const leftRecord = asObject(left);
  const rightRecord = asObject(right);
  return Number(leftRecord.charcID ?? leftRecord.id ?? Number.MAX_SAFE_INTEGER) - Number(rightRecord.charcID ?? rightRecord.id ?? Number.MAX_SAFE_INTEGER);
}

async function requirePublishedCategoryVersion(client: PoolClient, categoryKey: string | null, versionId: string) {
  const result = await client.query<SqlRow>(`SELECT t.category_key,v.* FROM wb_category_template_versions v
    JOIN wb_category_templates t ON t.id=v.template_id WHERE v.id=$1 AND v.status='PUBLISHED' AND t.active=true AND ($2::text IS NULL OR t.category_key=$2)`, [versionId, categoryKey]);
  if (!result.rows[0]) throw new AppError('CONFIG_INVALID', '所选 WB 类目版本未发布、已停用或与类目 Key 不匹配', { categoryKey, versionId }, 409);
  return result.rows[0];
}

async function loadLatestPurchaseMeasurementProjection(
  client: PoolClient,
  sku: string,
  formConfig: unknown,
  liveSchema: unknown
) {
  const result = await client.query<{
    id: string;
    version_no: number;
    product_height_cm: string | number | null;
    product_depth_cm: string | number | null;
    product_width_cm: string | number | null;
    net_weight_g: string | number | null;
  }>(`SELECT id,version_no,product_height_cm,product_depth_cm,product_width_cm,net_weight_g
    FROM procurement_versions WHERE sku=$1 ORDER BY version_no DESC LIMIT 1`, [sku]);
  const row = result.rows[0];
  if (!row) throw new AppError('CONFIG_INVALID', '采购管理尚无可用采购版本，无法获取产品尺寸与净重', { sku }, 409);
  return projectWbPurchaseMeasurements(createWbPurchaseMeasurements({
    procurementVersionId: row.id,
    procurementVersionNo: Number(row.version_no),
    productHeightCm: row.product_height_cm,
    productDepthCm: row.product_depth_cm,
    productWidthCm: row.product_width_cm,
    netWeightGrams: row.net_weight_g
  }), formConfig, liveSchema);
}

function draftPatch(input: WbListingDraftUpdate): JsonRecord {
  const output: JsonRecord = {};
  for (const key of ['brand', 'titleRu', 'descriptionRu', 'packaging', 'priceCny', 'discountPercent', 'clubDiscount', 'videoUploadMode', 'compliance', 'sharedCharacteristics', 'variants'] as const) {
    if (Object.hasOwn(input, key)) output[key] = input[key] as any;
  }
  return output;
}

type GrossWeightResolution = {
  source: 'PROCUREMENT' | 'PRESET_FALLBACK';
  effectiveGrossWeightGrams: number;
  procurementGrossWeightGrams: number | null;
  presetGrossWeightGrams: number;
  procurementVersionId: string;
  procurementVersionNo: number;
  procurementCapturedAt: string;
};

function readGrossWeightResolution(dataInput: unknown, sku: string): GrossWeightResolution | undefined {
  const initialization = asObject(asObject(dataInput).initialization);
  if (!Object.hasOwn(initialization, 'grossWeightResolution')) return undefined;
  const resolution = asObject(initialization.grossWeightResolution);
  const procurementGrossWeight = resolution.procurementGrossWeightGrams;
  const procurementGrossWeightIsFinite = typeof procurementGrossWeight === 'number'
    && Number.isFinite(procurementGrossWeight);
  const sourceMatchesWeights = resolution.source === 'PROCUREMENT'
    ? procurementGrossWeightIsFinite
      && procurementGrossWeight > 0
      && resolution.effectiveGrossWeightGrams === procurementGrossWeight
    : resolution.source === 'PRESET_FALLBACK'
      && (procurementGrossWeight === null || (procurementGrossWeightIsFinite && procurementGrossWeight <= 0))
      && resolution.effectiveGrossWeightGrams === resolution.presetGrossWeightGrams;
  const valid = (resolution.source === 'PROCUREMENT' || resolution.source === 'PRESET_FALLBACK')
    && typeof resolution.effectiveGrossWeightGrams === 'number'
    && Number.isFinite(resolution.effectiveGrossWeightGrams)
    && resolution.effectiveGrossWeightGrams > 0
    && (procurementGrossWeight === null
      || procurementGrossWeightIsFinite)
    && typeof resolution.presetGrossWeightGrams === 'number'
    && Number.isFinite(resolution.presetGrossWeightGrams)
    && resolution.presetGrossWeightGrams > 0
    && typeof resolution.procurementVersionId === 'string'
    && Boolean(resolution.procurementVersionId.trim())
    && typeof resolution.procurementVersionNo === 'number'
    && Number.isInteger(resolution.procurementVersionNo)
    && resolution.procurementVersionNo > 0
    && typeof resolution.procurementCapturedAt === 'string'
    && Boolean(resolution.procurementCapturedAt.trim())
    && Number.isFinite(Date.parse(resolution.procurementCapturedAt))
    && sourceMatchesWeights;
  if (!valid) {
    throw new AppError('CONFIG_INVALID', '毛重联动审计快照无效，请重新初始化 WB 上品资料', { sku }, 409);
  }
  return resolution as GrossWeightResolution;
}

function assertManagedGrossWeightMatches(
  actualInput: unknown,
  resolution: GrossWeightResolution,
  sku: string,
  message: string
): void {
  const actualGrossWeightGrams = typeof actualInput === 'number' ? actualInput : Number.NaN;
  if (Number.isFinite(actualGrossWeightGrams)
    && actualGrossWeightGrams === resolution.effectiveGrossWeightGrams) return;
  throw new AppError('CONFIG_INVALID', message, {
    sku,
    source: resolution.source,
    expectedGrossWeightGrams: resolution.effectiveGrossWeightGrams,
    actualGrossWeightGrams: actualInput ?? null
  }, 409);
}

function assertManagedPackagingMatches(
  packagingInput: unknown,
  resolution: GrossWeightResolution,
  sku: string,
  message: string
): void {
  const packaging = asObject(packagingInput);
  if (Object.hasOwn(packaging, 'weightKg')) {
    throw new AppError('CONFIG_INVALID', message, {
      sku,
      source: resolution.source,
      field: 'packaging.weightKg',
      expectedGrossWeightGrams: resolution.effectiveGrossWeightGrams,
      actualWeightKg: packaging.weightKg ?? null
    }, 409);
  }
  assertManagedGrossWeightMatches(packaging.grossWeightGrams, resolution, sku, message);
}

function withoutCharacteristic(input: unknown, characteristicId: number): unknown[] {
  if (!Array.isArray(input)) return [];
  return input.filter((item) => Number(asObject(item).id) !== characteristicId);
}

function validateDraftRelations(data: JsonRecord, assetsInput: unknown, assignmentsInput: unknown): void {
  const variants = Array.isArray(data.variants) ? data.variants as Array<{ variantId?: string }> : [];
  const assignments = Array.isArray(assignmentsInput) ? assignmentsInput as Array<{ variantId?: string; imageAssetIds?: string[]; videoAssetId?: string }> : [];
  const assets = Array.isArray(assetsInput) ? assetsInput as WbMediaAsset[] : [];
  const variantIds = new Set(variants.map((item) => item.variantId));
  if (variantIds.size !== variants.length) throw new AppError('CONFIG_INVALID', '变体 variantId 不能重复');
  const assetMap = new Map(assets.map((item) => [item.assetId, item]));
  const assignedVariants = new Set<string>();
  for (const assignment of assignments) {
    if (!assignment.variantId || !variantIds.has(assignment.variantId)) throw new AppError('CONFIG_INVALID', '媒体分配引用了不存在的变体', { variantId: assignment.variantId });
    if (assignedVariants.has(assignment.variantId)) throw new AppError('CONFIG_INVALID', '同一变体只能有一组媒体分配', { variantId: assignment.variantId });
    assignedVariants.add(assignment.variantId);
    for (const assetId of assignment.imageAssetIds || []) {
      const asset = assetMap.get(assetId);
      if (!asset || asset.kind !== 'image') throw new AppError('CONFIG_INVALID', '图片分配引用了无效资产', { assetId });
    }
    if (assignment.videoAssetId) {
      const asset = assetMap.get(assignment.videoAssetId);
      if (!asset || asset.kind !== 'video') throw new AppError('CONFIG_INVALID', '视频分配引用了无效资产', { assetId: assignment.videoAssetId });
    }
  }
}

function referencedAssetIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.flatMap((item: any) => [...(Array.isArray(item?.imageAssetIds) ? item.imageAssetIds : []), ...(item?.videoAssetId ? [item.videoAssetId] : [])]).filter((item): item is string => typeof item === 'string'))];
}

function assertDraftVersion(row: SqlRow, expected: number): void {
  if (Number(row.draft_version) !== expected) throw new AppError('VERSION_CONFLICT', '草稿已被其他操作更新，请刷新后重试', { expected, actual: Number(row.draft_version) }, 409);
}

function normalizeSku(input: string): string {
  const sku = String(input || '').trim();
  if (!/^\d{7}$/.test(sku)) throw new AppError('CONFIG_INVALID', 'SKU 必须是 7 位数字', { sku });
  return sku;
}

function parseCategoryKey(input: string): string {
  const parsed = wbCategoryKeySchema.safeParse(input);
  if (!parsed.success) throw validationError(parsed.error.issues);
  return parsed.data;
}

function normalizeRemoteStatus(result: JsonRecord): { status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED'; errorMessage: string | null; nmIds: unknown[]; productUrls: unknown[] } {
  const raw = String(result.status || result.state || '').toUpperCase();
  const status = raw === 'SUCCEEDED' || raw === 'SUCCESS' || raw === 'COMPLETED' ? 'SUCCEEDED'
    : raw === 'FAILED' || raw === 'ERROR' ? 'FAILED'
      : raw.startsWith('BLOCKED') ? 'BLOCKED'
        : raw === 'QUEUED' || raw === 'PENDING' ? 'QUEUED' : 'RUNNING';
  const errorMessage = typeof result.errorMessage === 'string' ? result.errorMessage : typeof result.message === 'string' ? result.message : typeof result.error === 'string' ? result.error : null;
  const variants = Array.isArray(result.variants) ? result.variants.map(asObject) : [];
  const nmIds = Array.isArray(result.nmIds) ? result.nmIds : result.nmId ? [result.nmId]
    : variants.map((variant) => variant.nmID ?? variant.nmId).filter((value) => value !== undefined && value !== null && value !== '');
  const productUrls = Array.isArray(result.productUrls) ? result.productUrls : result.productUrl ? [result.productUrl]
    : variants.map((variant) => variant.link).filter((value): value is string => typeof value === 'string' && Boolean(value));
  return { status, errorMessage, nmIds, productUrls };
}

function toCatalogRun(row: SqlRow): WbCatalogRun {
  return {
    runId: String(row.id), trigger: row.trigger as WbCatalogTrigger, status: row.status as WbCatalogRunStatus,
    ...(row.schedule_key ? { scheduleKey: String(row.schedule_key) } : {}), startedAt: new Date(row.started_at).toISOString(),
    ...(row.completed_at ? { completedAt: new Date(row.completed_at).toISOString() } : {}),
    processedParents: Number(row.processed_parents || 0), totalParents: Number(row.total_parents || 0),
    processedSubjects: Number(row.processed_subjects || 0),
    ...(row.snapshot_path ? { snapshotPath: String(row.snapshot_path) } : {}),
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
    ...(row.error_message ? { errorMessage: String(row.error_message) } : {})
  };
}

export function normalizeCatalogText(input: string): string {
  return String(input || '').normalize('NFC').trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').replace(/\s+/g, ' ');
}

function toRuntimeConfigRow(row: SqlRow): JsonRecord {
  return {
    config_id: String(row.config_id || 'default'),
    schema_version: Number(row.schema_version || 1),
    config_version: Number(row.config_version || 1),
    publish_enabled: row.system_enabled === undefined ? Boolean(row.publish_enabled) : Boolean(row.system_enabled),
    credential_ready: Boolean(row.credential_ready),
    import_root: String(row.system_root_directory ?? row.import_root ?? ''),
    root_source: String(row.root_source || ''),
    root_sync_hash: String(row.root_sync_hash || ''),
    root_synced_at: isoOrUndefined(row.root_synced_at),
    warehouse_id: String(row.warehouse_id || ''),
    timezone: String(row.timezone || 'Asia/Shanghai'),
    dispatch_batch_size: Number(row.dispatch_batch_size || 1),
    dispatch_concurrency: Math.min(2, Math.max(1, Number(row.global_concurrency ?? row.dispatch_concurrency ?? 1))),
    global_concurrency: Math.min(2, Math.max(1, Number(row.global_concurrency ?? row.dispatch_concurrency ?? 1))),
    per_store_concurrency: 1,
    system_row_version: Number(row.system_row_version || 1),
    media_batch_size: Number(row.media_batch_size || 7),
    media_upload_interval_ms: Number(row.media_upload_interval_ms || 650),
    video_optimize_enabled: row.video_optimize_enabled !== false,
    video_optimize_threshold_bytes: Number(row.video_optimize_threshold_bytes || 5 * 1024 * 1024),
    video_optimize_target_kbps: Number(row.video_optimize_target_kbps || 1500),
    video_optimize_maxrate_kbps: Number(row.video_optimize_maxrate_kbps || 1800),
    lock_ttl_seconds: Number(row.lock_ttl_seconds || 600),
    max_daily_styles: Number(row.max_daily_styles || 100),
    price_currency_expected: String(row.price_currency_expected || 'CNY'),
    preflight_report_json: JSON.stringify(parseJsonRecord(row.preflight_report_json)),
    network_attempt: Math.max(0, Number(row.network_attempt || 0)),
    network_next_attempt_at: isoOrUndefined(row.network_next_attempt_at),
    network_last_error_code: String(row.network_last_error_code || ''),
    network_last_error_message: String(row.network_last_error_message || ''),
    network_updated_at: isoOrUndefined(row.network_updated_at),
    created_at: isoOrUndefined(row.created_at),
    updated_at: isoOrUndefined(row.updated_at)
  };
}

function toRuntimeCategoryProjectionRow(row: SqlRow): JsonRecord {
  const formConfig = normalizeWbFormConfigTnvedPolicy(row.form_config, row.live_schema);
  const policy = resolveWbTnvedPolicy(formConfig, row.live_schema);
  const projectionStatus = String(row.projection_status || 'NOT_SYNCED');
  const confirmedBy = row.confirmed_by || undefined;
  const confirmedAt = isoOrUndefined(row.confirmed_at);
  const status = row.active !== false && projectionStatus === 'SYNCED' && confirmedBy && confirmedAt ? 'READY' : 'NOT_READY';
  const compliance = {
    tnvedCharacteristicId: policy.characteristicId,
    tnvedRequired: policy.required
  };
  const managedCharacteristicIds = row.managed_characteristic_ids || [];
  const projection = {
    sourceVersionId: String(row.source_version_id || ''),
    source_version_id: String(row.source_version_id || ''),
    categoryKey: String(row.category_key || ''),
    category_key: String(row.category_key || ''),
    subjectId: Number(row.subject_id || 0),
    subject_id: Number(row.subject_id || 0),
    subjectName: String(row.subject_name || ''),
    subject_name: String(row.subject_name || ''),
    subjectNameZh: String(row.subject_name_zh || ''),
    templateVersion: Number(row.template_version || 0),
    template_version: Number(row.template_version || 0),
    schemaHash: String(row.schema_hash || ''),
    schema_hash: String(row.schema_hash || ''),
    definitionHash: String(row.definition_hash || ''),
    definition_hash: String(row.definition_hash || ''),
    liveSchema: row.live_schema || [],
    live_schema: row.live_schema || [],
    live_schema_json: JSON.stringify(row.live_schema || []),
    formConfig,
    form_config: formConfig,
    form_config_json: JSON.stringify(formConfig),
    managedCharacteristicIds,
    managed_characteristic_ids: managedCharacteristicIds,
    managed_characteristic_ids_json: JSON.stringify(managedCharacteristicIds),
    compliance,
    compliance_json: JSON.stringify(compliance),
    status,
    confirmedBy,
    confirmed_by: confirmedBy,
    confirmedAt,
    confirmed_at: confirmedAt,
    enabled: row.active !== false,
    projectionStatus,
    projection_status: projectionStatus,
    syncedAt: isoOrUndefined(row.synced_at),
    synced_at: isoOrUndefined(row.synced_at),
    lastError: row.projection_error || undefined,
    last_error: row.projection_error || undefined
  };
  return projection;
}

function toRuntimeJobRow(row: SqlRow): JsonRecord {
  const result = parseJsonRecord(row.result_json);
  return {
    task_id: String(row.task_id || ''),
    taskId: String(row.task_id || ''),
    store_id: String(row.store_id || WB_DEFAULT_STORE_ID),
    storeId: String(row.store_id || WB_DEFAULT_STORE_ID),
    store_alias: String(row.store_alias || WB_DEFAULT_STORE_ALIAS),
    storeAlias: String(row.store_alias || WB_DEFAULT_STORE_ALIAS),
    publication_id: row.publication_id ? String(row.publication_id) : undefined,
    publicationId: row.publication_id ? String(row.publication_id) : undefined,
    credential_version_id: row.credential_version_id ? String(row.credential_version_id) : undefined,
    credentialVersionId: row.credential_version_id ? String(row.credential_version_id) : undefined,
    store_config_version: Number(row.store_config_version || 1),
    storeConfigVersion: Number(row.store_config_version || 1),
    warehouse_id: String(row.warehouse_id || ''),
    warehouseId: String(row.warehouse_id || ''),
    idempotency_key: String(row.idempotency_key || ''),
    source: String(row.source || ''),
    priority: Number(row.priority || 0),
    folder_name: String(row.folder_name || ''),
    folderName: String(row.folder_name || ''),
    work_relpath: String(row.work_relpath || ''),
    product_code: String(row.product_code || ''),
    productCode: String(row.product_code || ''),
    revision: Number(row.revision || 0),
    payload_signature: String(row.payload_signature || ''),
    state: String(row.state || ''),
    status: String(row.state || ''),
    resume_state: String(row.resume_state || ''),
    stage_attempt: Number(row.stage_attempt || 0),
    total_attempt: Number(row.total_attempt || 0),
    poll_count: Number(row.poll_count || 0),
    next_run_at: isoOrUndefined(row.next_run_at),
    stage_deadline_at: isoOrUndefined(row.stage_deadline_at),
    lease_owner: String(row.lease_owner || ''),
    lease_expires_at: isoOrUndefined(row.lease_expires_at),
    template_version: Number(row.template_version || 0),
    config_version: Number(row.config_version || 1),
    partial_effects: Boolean(row.partial_effects),
    wb_request_ref: String(row.wb_request_ref || ''),
    result_json: JSON.stringify(result),
    result,
    last_error_code: String(row.last_error_code || ''),
    last_error_message: String(row.last_error_message || ''),
    errorCode: String(row.last_error_code || ''),
    errorMessage: String(row.last_error_message || ''),
    submitted_at: isoOrUndefined(row.submitted_at),
    finished_at: isoOrUndefined(row.finished_at),
    created_at: isoOrUndefined(row.created_at),
    updated_at: isoOrUndefined(row.updated_at),
    row_version: Number(row.row_version || 1),
    rowVersion: Number(row.row_version || 1)
  };
}

function toRuntimeRegistryRow(row: SqlRow): JsonRecord {
  return {
    store_id: String(row.store_id || WB_DEFAULT_STORE_ID),
    storeId: String(row.store_id || WB_DEFAULT_STORE_ID),
    store_alias: String(row.store_alias || WB_DEFAULT_STORE_ALIAS),
    storeAlias: String(row.store_alias || WB_DEFAULT_STORE_ALIAS),
    registry_key: String(row.registry_key || ''),
    registryKey: String(row.registry_key || ''),
    product_code: String(row.product_code || ''),
    productCode: String(row.product_code || ''),
    category_key: String(row.category_key || ''),
    variant_code: String(row.variant_code || ''),
    vendor_code: String(row.vendor_code || ''),
    vendorCode: String(row.vendor_code || ''),
    tech_size: String(row.tech_size || ''),
    barcode: String(row.barcode || ''),
    nm_id: String(row.nm_id || ''),
    nmID: row.nm_id ? Number(row.nm_id) || row.nm_id : undefined,
    imt_id: String(row.imt_id || ''),
    chrt_id: String(row.chrt_id || ''),
    size_id: String(row.size_id || ''),
    subject_id: String(row.subject_id || ''),
    last_applied_revision: Number(row.last_applied_revision || 0),
    desired_signature: String(row.desired_signature || ''),
    media_signature: String(row.media_signature || ''),
    status: String(row.status || ''),
    last_verified_at: isoOrUndefined(row.last_verified_at),
    created_at: isoOrUndefined(row.created_at),
    updated_at: isoOrUndefined(row.updated_at)
  };
}

async function insertRuntimeEvent(
  client: PoolClient,
  taskId: string,
  eventType: string,
  fromState: string | undefined,
  toState: string | undefined,
  message: string,
  details: JsonRecord = {}
): Promise<void> {
  await client.query(`INSERT INTO wb_publish_events(id,task_id,event_type,from_state,to_state,message,details,store_id,publication_id)
    SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,j.store_id,j.publication_id FROM wb_publish_jobs j WHERE j.task_id=$2`, [
    randomUUID(), taskId, eventType, fromState || null, toState || null, message, JSON.stringify(details)
  ]);
}

async function upsertRuntimeRegistryRow(
  client: PoolClient,
  taskId: string,
  storeId: string,
  expectedProductCode: string,
  row: JsonRecord
): Promise<JsonRecord | undefined> {
  const registryKey = stringOr(row.registry_key, row.registryKey);
  if (!registryKey) return undefined;
  const productCode = stringOr(row.product_code, row.productCode);
  if (expectedProductCode && productCode !== expectedProductCode) {
    throw new AppError('CONFIG_INVALID', 'registryRows.product_code 与 runtime job 不一致', {
      taskId, registryKey, expectedProductCode, productCode
    }, 409);
  }
  await client.query(`INSERT INTO wb_product_registry(
      store_id,store_alias,registry_key,product_code,category_key,variant_code,vendor_code,tech_size,barcode,nm_id,imt_id,chrt_id,size_id,subject_id,
      last_applied_revision,desired_signature,media_signature,status,last_verified_at)
    SELECT $1,s.store_alias,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
    FROM wb_stores s WHERE s.id=$1
    ON CONFLICT(store_id,registry_key) DO UPDATE SET
      product_code=EXCLUDED.product_code,category_key=EXCLUDED.category_key,variant_code=EXCLUDED.variant_code,
      vendor_code=EXCLUDED.vendor_code,tech_size=EXCLUDED.tech_size,barcode=EXCLUDED.barcode,nm_id=EXCLUDED.nm_id,
      imt_id=EXCLUDED.imt_id,chrt_id=EXCLUDED.chrt_id,size_id=EXCLUDED.size_id,subject_id=EXCLUDED.subject_id,
      last_applied_revision=EXCLUDED.last_applied_revision,desired_signature=EXCLUDED.desired_signature,
      media_signature=EXCLUDED.media_signature,status=EXCLUDED.status,last_verified_at=EXCLUDED.last_verified_at,updated_at=NOW()`, [
    storeId, registryKey, productCode, stringOr(row.category_key), stringOr(row.variant_code), stringOr(row.vendor_code),
    stringOr(row.tech_size), stringOr(row.barcode), stringOr(row.nm_id), stringOr(row.imt_id), stringOr(row.chrt_id),
    stringOr(row.size_id), stringOr(row.subject_id), numberOr(row.last_applied_revision, 0), stringOr(row.desired_signature),
    stringOr(row.media_signature), stringOr(row.status), dateOr(row.last_verified_at)
  ]);
  return { ...row, store_id: storeId, storeId, registry_key: registryKey, product_code: productCode };
}

function parseJsonRecord(value: unknown): JsonRecord {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try { return asObject(JSON.parse(trimmed)); }
    catch { return {}; }
  }
  return asObject(value);
}

type RuntimeNetworkGateUpdate =
  | { kind: 'NONE' }
  | { kind: 'CLEAR' }
  | { kind: 'SET'; attempt: number; nextAttemptAt: string; errorCode: string; errorMessage: string };

function runtimeNetworkGateUpdate(input: JsonRecord, inputJob: JsonRecord, runtime: JsonRecord): RuntimeNetworkGateUpdate {
  const explicitSources = [inputJob, input];
  const explicit = explicitSources.find((source) => [
    'network_attempt', 'network_next_attempt_at', 'network_last_error_code', 'network_last_error_message'
  ].some((key) => hasOwn(source, key)));
  if (explicit) {
    const attempt = Math.max(0, Math.trunc(numberOr(explicit.network_attempt, 0)));
    const nextAttemptAt = dateOr(explicit.network_next_attempt_at);
    if (attempt < 1 || !nextAttemptAt) return { kind: 'CLEAR' };
    return {
      kind: 'SET',
      attempt,
      nextAttemptAt,
      errorCode: stringOr(explicit.network_last_error_code) || 'NETWORK_UNAVAILABLE',
      errorMessage: stringOr(explicit.network_last_error_message)
    };
  }
  const recoveryKey = hasOwn(runtime, 'networkRecovery') ? 'networkRecovery'
    : hasOwn(runtime, 'network_recovery') ? 'network_recovery' : undefined;
  if (!recoveryKey) return { kind: 'NONE' };
  const rawRecovery = runtime[recoveryKey];
  const recovery = asObject(rawRecovery);
  const attempt = Math.max(0, Math.trunc(numberOr(recovery.attempt, recovery.network_attempt, 0)));
  const nextAttemptAt = dateOr(recovery.nextAttemptAt, recovery.next_attempt_at, recovery.network_next_attempt_at);
  if (rawRecovery === null || recovery.active === false || attempt < 1 || !nextAttemptAt) return { kind: 'CLEAR' };
  return {
    kind: 'SET',
    attempt,
    nextAttemptAt,
    errorCode: stringOr(recovery.lastErrorCode, recovery.last_error_code, recovery.errorCode) || 'NETWORK_UNAVAILABLE',
    errorMessage: stringOr(recovery.lastErrorMessage, recovery.last_error_message, recovery.errorMessage)
  };
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stringOr(...values: unknown[]): string {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function numberOr(...values: unknown[]): number {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function booleanOr(...values: unknown[]): boolean {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
      if (['false', '0', 'no', 'n'].includes(normalized)) return false;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
  }
  return false;
}

function dateOr(...values: unknown[]): string | null {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return null;
}

function isoOrUndefined(value: unknown): string | undefined {
  const date = dateOr(value);
  return date || undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function assertUniqueNonEmptyStrings(values: string[], label: string, taskId: string): void {
  if (!values.length || values.some((value) => !value) || new Set(values).size !== values.length) {
    throw new AppError('COMPATIBLE_RECOVERY_UNSAFE', `${label} 为空或存在重复项`, { taskId }, 409);
  }
}

function normalizeRuntimeCardMatches(matches: WbRuntimeCardMatch[]): WbRuntimeCardMatch[] {
  const output: WbRuntimeCardMatch[] = [];
  const byIdentity = new Set<string>();
  for (const candidate of Array.isArray(matches) ? matches : []) {
    const vendorCode = String(candidate?.vendorCode || '').trim();
    const location = String(candidate?.location || '').toUpperCase();
    const nmId = positiveInteger(candidate?.nmId);
    const imtId = positiveInteger(candidate?.imtId);
    const subjectId = positiveInteger(candidate?.subjectId);
    if (!vendorCode || !['ACTIVE', 'TRASH'].includes(location)) continue;
    const normalized: WbRuntimeCardMatch = {
      vendorCode,
      location: location as WbRuntimeCardMatch['location'],
      ...(nmId ? { nmId } : {}),
      ...(imtId ? { imtId } : {}),
      ...(subjectId ? { subjectId } : {})
    };
    const key = stableJson(normalized);
    if (byIdentity.has(key)) continue;
    byIdentity.add(key);
    output.push(normalized);
  }
  return output;
}

function assertExactActiveMatches(
  expectedVendorCodes: string[],
  matches: WbRuntimeCardMatch[],
  taskId: string,
  expectedSubjectId?: number
): void {
  const expected = new Set(expectedVendorCodes);
  const byVendor = new Map<string, WbRuntimeCardMatch>();
  for (const match of matches) {
    if (!expected.has(match.vendorCode) || !match.nmId || !match.imtId
      || (expectedSubjectId !== undefined && match.subjectId !== expectedSubjectId)) {
      throw new AppError('COMPATIBLE_RECOVERY_UNSAFE', 'WB ACTIVE 查询包含未知或身份不完整的商品卡', {
        taskId, expectedSubjectId, match
      }, 409);
    }
    const prior = byVendor.get(match.vendorCode);
    if (prior && (prior.nmId !== match.nmId || prior.imtId !== match.imtId)) {
      throw new AppError('COMPATIBLE_RECOVERY_UNSAFE', '同一卖家商品编码匹配到多个 WB 商品身份', {
        taskId, vendorCode: match.vendorCode
      }, 409);
    }
    byVendor.set(match.vendorCode, match);
  }
  if (byVendor.size !== expected.size || expectedVendorCodes.some((vendorCode) => !byVendor.has(vendorCode))) {
    throw new AppError('COMPATIBLE_RECOVERY_UNSAFE', 'WB ACTIVE 商品卡未完整覆盖待恢复任务', {
      taskId, expectedVendorCodes, actualVendorCodes: [...byVendor.keys()]
    }, 409);
  }
}

function compatibleOriginMatches(row: SqlRow, expectedVendorCodes: string[], automationRunId: string): boolean {
  const runtime = parseJsonRecord(row.result_json);
  const intent = asObject(runtime.cardCreateIntent);
  const vendorCodes = Array.isArray(intent.vendorCodes) ? intent.vendorCodes.map(stringOr).filter(Boolean) : [];
  return String(runtime.automationRunId || '') === automationRunId
    && String(runtime.submissionMode || '').toUpperCase() === 'COMPATIBLE_UPSERT'
    && String(intent.taskId || '') === String(row.task_id || '')
    && String(intent.submissionMode || '').toUpperCase() === 'COMPATIBLE_UPSERT'
    && stableJson([...new Set(vendorCodes)].sort()) === stableJson([...expectedVendorCodes].sort());
}

function validatedOriginCards(runtime: JsonRecord, expectedVendorCodes: string[], taskId: string): JsonRecord[] {
  const cards = Array.isArray(runtime.cards) ? runtime.cards.map(asObject) : [];
  const byVendor = new Map<string, JsonRecord>();
  for (const card of cards) {
    const vendorCode = stringOr(card.vendorCode);
    const nmId = positiveInteger(card.nmID ?? card.nmId);
    const imtId = positiveInteger(card.imtID ?? card.imtId);
    const subjectId = positiveInteger(card.subjectID ?? card.subjectId);
    const sizes = Array.isArray(card.sizes) ? card.sizes.map(asObject) : [];
    const validSizes = sizes.length > 0 && sizes.every((size) => positiveInteger(size.chrtID ?? size.chrtId) && stringOr(size.barcode));
    if (!vendorCode || !nmId || !imtId || !subjectId || !validSizes || byVendor.has(vendorCode)) {
      throw new AppError('COMPATIBLE_RECOVERY_UNSAFE', '原始建卡任务缺少可复用的 nmID/imtID/subjectID/barcode/chrtID 身份', {
        taskId, vendorCode
      }, 409);
    }
    byVendor.set(vendorCode, card);
  }
  if (byVendor.size !== expectedVendorCodes.length || expectedVendorCodes.some((vendorCode) => !byVendor.has(vendorCode))) {
    throw new AppError('COMPATIBLE_RECOVERY_UNSAFE', '原始建卡任务未覆盖当前全部商品变体', {
      taskId, expectedVendorCodes, originVendorCodes: [...byVendor.keys()]
    }, 409);
  }
  return expectedVendorCodes.map((vendorCode) => byVendor.get(vendorCode)!);
}

const WB_HISTORICAL_TRANSPORT_CODES = new Set([
  'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'ECONNREFUSED',
  'ENOTFOUND', 'EAI_AGAIN', 'TLS_EOF', 'HTTP_408', 'HTTP_429'
]);

function historicalTransportEvidence(row: SqlRow): { errorCode: string; errorMessage: string; httpStatus?: number } | undefined {
  const result = parseJsonRecord(row.result_json);
  const errorCode = stringOr(row.last_error_code, result.errorCode, result.lastErrorCode).toUpperCase();
  const errorMessage = stringOr(row.error_message, row.last_error_message, result.errorMessage, result.lastErrorMessage);
  const explicitStatus = positiveInteger(result.httpStatus ?? result.statusCode ?? result.http_status ?? result.status_code);
  const codeStatusMatch = errorCode.match(/(?:^|_)HTTP_(408|429|5\d{2})$/);
  const httpStatus = explicitStatus || (codeStatusMatch ? Number(codeStatusMatch[1]) : undefined);
  const statusIsTransport = httpStatus === 408 || httpStatus === 429 || (httpStatus !== undefined && httpStatus >= 500 && httpStatus <= 599);
  const messageIsTransport = /ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNABORTED|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|SOCKET\s+HANG\s+UP|TLS.*EOF|(?:HTTP|STATUS)[^0-9]*(?:408|429|5\d{2})|断网|网络(?:中断|不可用|连接失败|超时)/i.test(errorMessage);
  if (!WB_HISTORICAL_TRANSPORT_CODES.has(errorCode) && !/(?:^|_)HTTP_5\d{2}$/.test(errorCode)
    && !statusIsTransport && !messageIsTransport) return undefined;
  return {
    errorCode: errorCode || (httpStatus ? `HTTP_${httpStatus}` : 'NETWORK_TRANSPORT'),
    errorMessage,
    ...(httpStatus ? { httpStatus } : {})
  };
}

const WB_HISTORICAL_NETWORK_DELAYS_MS = [30_000, 60_000, 300_000, 900_000] as const;

function historicalListingProposedRecovery(
  row: SqlRow,
  transport: { errorCode: string; errorMessage: string; httpStatus?: number }
): WbNetworkRecovery {
  const parsedPrevious = wbNetworkRecoverySchema.safeParse(parseJsonRecord(row.network_recovery));
  const previous = parsedPrevious.success ? parsedPrevious.data : undefined;
  const attempt = Math.max(1, Math.trunc(numberOr(previous?.attempt, 1)));
  const failureAt = dateOr(row.updated_at) || '1970-01-01T00:00:00.000Z';
  const baseDelayMs = WB_HISTORICAL_NETWORK_DELAYS_MS[Math.min(attempt - 1, WB_HISTORICAL_NETWORK_DELAYS_MS.length - 1)]!;
  const failureAtMs = Date.parse(failureAt);
  const previousNextAttemptAtMs = Date.parse(previous?.nextAttemptAt || '');
  const retryAfterMs = previous?.retryAfterMs;
  const nextAttemptAt = new Date(Math.max(
    failureAtMs + baseDelayMs,
    Number.isFinite(previousNextAttemptAtMs) ? previousNextAttemptAtMs : 0,
    failureAtMs + (retryAfterMs ?? 0)
  )).toISOString();
  const deliveryState = historicalDeliveryState(transport);
  return {
    phase: 'SUBMIT_READBACK',
    resumeState: 'SUBMITTING',
    deliveryState,
    attempt,
    firstFailureAt: dateOr(previous?.firstFailureAt) || failureAt,
    lastFailureAt: dateOr(previous?.lastFailureAt) || failureAt,
    nextAttemptAt,
    lastErrorCode: transport.errorCode,
    lastErrorMessage: transport.errorMessage,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    checkpoint: `taskId:${String(row.n8n_task_id || '')}`,
    ...(previous?.readableAmbiguityElapsedMs !== undefined
      ? { readableAmbiguityElapsedMs: previous.readableAmbiguityElapsedMs }
      : {}),
    ...(previous?.readableAmbiguityLastObservedAt
      ? { readableAmbiguityLastObservedAt: previous.readableAmbiguityLastObservedAt }
      : {})
  };
}

function historicalDeliveryState(
  transport: { errorCode: string; httpStatus?: number }
): WbNetworkRecovery['deliveryState'] {
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(transport.errorCode)) return 'NOT_SENT';
  if (transport.httpStatus === 429 || transport.errorCode.endsWith('HTTP_429')) return 'RESPONDED';
  return 'UNKNOWN';
}

type HistoricalRuntimeRecoveryPlan = {
  recoverable: boolean;
  phase: string;
  checkpoint: string;
  deliveryState: 'NOT_SENT' | 'UNKNOWN' | 'RESPONDED';
  safeResumeState?: string;
  safeReadback: boolean;
  attempt: number;
  nextAttemptAt: string;
  reason: string;
};

const WB_RUNTIME_READBACK_RESUME_STATES = new Set([
  'COMPLIANCE_RECONCILING', 'CARD_CREATE_GUARD', 'CARD_RECONCILING', 'CARD_WAITING', 'CARD_SUBMITTING',
  'CARD_ERROR_RECONCILING', 'MEDIA_RECONCILING', 'MEDIA_VERIFYING', 'MEDIA_SUBMITTING',
  'VIDEO_RECONCILING', 'VIDEO_VERIFYING', 'VIDEO_SUBMITTING', 'MEDIA_TRIM_SUBMITTING',
  'PRICE_RECONCILING', 'PRICE_VERIFYING', 'PRICE_SUBMITTING', 'PRICE_TASK_RECONCILING',
  'PRICE_QUARANTINE_RECONCILING', 'STOCK_RECONCILING', 'STOCK_VERIFYING', 'STOCK_SUBMITTING',
  'FINAL_VERIFYING'
]);

const WB_RUNTIME_SAFE_REPLAY_STATES = new Set([
  'QUEUED', 'VALIDATING', 'COMPLIANCE_RECONCILING', 'BARCODE_ALLOCATING', 'CARD_CREATE_GUARD',
  'CARD_CREATE_READY', 'CARD_UPDATE_READY', 'CARD_ADD_READY', 'CARD_RECONCILING', 'CARD_WAITING',
  'CARD_SUBMITTING', 'CARD_ERROR_RECONCILING', 'MEDIA_RECONCILING', 'MEDIA_VERIFYING',
  'MEDIA_UPLOAD_READY', 'MEDIA_SUBMITTING', 'VIDEO_RECONCILING', 'VIDEO_VERIFYING', 'VIDEO_UPLOAD_READY',
  'VIDEO_SUBMITTING', 'MEDIA_TRIM_READY', 'MEDIA_TRIM_SUBMITTING', 'PRICE_RECONCILING',
  'PRICE_VERIFYING', 'PRICE_SUBMIT_READY', 'PRICE_SUBMITTING', 'PRICE_TASK_RECONCILING',
  'PRICE_QUARANTINE_RECONCILING', 'STOCK_RECONCILING', 'STOCK_VERIFYING', 'STOCK_SUBMIT_READY',
  'STOCK_SUBMITTING', 'FINAL_VERIFYING', 'FINALIZING'
]);

function historicalRuntimeRecoveryPlan(
  row: SqlRow,
  transport: { errorCode: string; errorMessage: string; httpStatus?: number }
): HistoricalRuntimeRecoveryPlan {
  const runtime = parseJsonRecord(row.result_json);
  const recovery = asObject(runtime.networkRecovery);
  const audit = Array.isArray(runtime.audit) ? runtime.audit.map(asObject) : [];
  const lastNetworkAudit = [...audit].reverse().find((entry) => entry.event === 'NETWORK_WAIT_SCHEDULED'
    || entry.event === 'WORKER_ERROR' || entry.phase || entry.resumeState);
  const phase = stringOr(recovery.phase, lastNetworkAudit?.phase, asObject(runtime.lastRequest).stage,
    asObject(runtime.requestIntent).stage, inferredRuntimePhase(runtime, row));
  const persistedDelivery = stringOr(recovery.deliveryState, lastNetworkAudit?.deliveryState).toUpperCase();
  const deliveryState: HistoricalRuntimeRecoveryPlan['deliveryState'] = ['NOT_SENT', 'UNKNOWN', 'RESPONDED'].includes(persistedDelivery)
    ? persistedDelivery as HistoricalRuntimeRecoveryPlan['deliveryState']
    : ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(transport.errorCode) ? 'NOT_SENT'
      : transport.httpStatus === 429 || transport.errorCode.endsWith('HTTP_429') ? 'RESPONDED' : 'UNKNOWN';
  const phaseResumeState = runtimeResumeStateForPhase(phase, runtime);
  const requestedResumeState = stringOr(recovery.resumeState, row.resume_state, lastNetworkAudit?.resumeState,
    phaseResumeState, recovery.lastCheckpoint, runtime.lastCheckpoint, inferredRuntimeResumeState(runtime));
  const checkpoint = stringOr(recovery.lastCheckpoint, recovery.checkpoint, lastNetworkAudit?.checkpoint,
    runtime.lastCheckpoint, row.resume_state, requestedResumeState, phase);
  const readbackResumeState = unknownWriteReadbackResumeState(phase, requestedResumeState, runtime);
  let safeResumeState: string | undefined;
  let safeReadback = false;
  let reason = '';
  if (deliveryState === 'UNKNOWN') {
    safeResumeState = readbackResumeState;
    safeReadback = Boolean(safeResumeState);
    reason = safeResumeState
      ? `写入结果未知；${safeResumeState} 会先执行平台回读，再决定是否补写`
      : '写入结果未知且没有可证明先回读的检查点';
  } else if (WB_RUNTIME_SAFE_REPLAY_STATES.has(requestedResumeState)) {
    safeResumeState = requestedResumeState;
    safeReadback = WB_RUNTIME_READBACK_RESUME_STATES.has(requestedResumeState);
    reason = deliveryState === 'NOT_SENT'
      ? '请求明确未送达，可在原检查点安全续跑'
      : '平台已明确响应且原检查点可安全续跑';
  } else {
    reason = '持久化记录没有受支持的原任务检查点';
  }
  const attempt = Math.max(1, Math.trunc(numberOr(recovery.attempt, row.stage_attempt, 1)));
  const minimumNextAttemptAt = Date.now() + 30_000;
  const persistedNextAttemptAt = Date.parse(stringOr(recovery.nextAttemptAt, row.next_run_at));
  const nextAttemptAt = new Date(Math.max(minimumNextAttemptAt,
    Number.isFinite(persistedNextAttemptAt) ? persistedNextAttemptAt : 0)).toISOString();
  return {
    recoverable: Boolean(safeResumeState),
    phase: phase || 'UNKNOWN',
    checkpoint: checkpoint || 'UNKNOWN',
    deliveryState,
    ...(safeResumeState ? { safeResumeState } : {}),
    safeReadback,
    attempt,
    nextAttemptAt,
    reason
  };
}

function runtimeResumeStateForPhase(phaseInput: string, runtime: JsonRecord): string {
  const phase = phaseInput.toUpperCase();
  const direct: Record<string, string> = {
    TNVED_LIST: 'COMPLIANCE_RECONCILING',
    BARCODE_ALLOCATE: 'BARCODE_ALLOCATING',
    CARD_WRITE: 'CARD_SUBMITTING',
    CARDS_LIST: 'CARD_RECONCILING',
    CREATE_ONLY_CHECK: 'CARD_CREATE_GUARD',
    CARDS_ERROR_LIST: 'CARD_ERROR_RECONCILING',
    MEDIA_TRIM: 'MEDIA_TRIM_SUBMITTING',
    PRICE_UPLOAD: 'PRICE_SUBMITTING',
    PRICE_LIST: 'PRICE_RECONCILING',
    PRICE_TASK: 'PRICE_TASK_RECONCILING',
    PRICE_QUARANTINE: 'PRICE_QUARANTINE_RECONCILING',
    STOCK_WRITE: 'STOCK_SUBMITTING',
    STOCK_LIST: 'STOCK_RECONCILING'
  };
  if (phase === 'MEDIA_UPLOAD') {
    return asObject(runtime.mediaIntent).kind === 'video' ? 'VIDEO_SUBMITTING' : 'MEDIA_SUBMITTING';
  }
  return direct[phase] || '';
}

function unknownWriteReadbackResumeState(phaseInput: string, requestedResumeState: string, runtime: JsonRecord): string | undefined {
  const phase = phaseInput.toUpperCase();
  if (phase === 'BARCODE_ALLOCATE' || requestedResumeState === 'BARCODE_ALLOCATING') return undefined;
  const forced = runtimeResumeStateForPhase(phase, runtime);
  if (forced && WB_RUNTIME_READBACK_RESUME_STATES.has(forced)) return forced;
  if (WB_RUNTIME_READBACK_RESUME_STATES.has(requestedResumeState)) return requestedResumeState;
  if (asObject(runtime.mediaTrimIntent).vendorCode) return 'MEDIA_TRIM_SUBMITTING';
  if (Array.isArray(asObject(runtime.mediaIntent).items)) {
    return asObject(runtime.mediaIntent).kind === 'video' ? 'VIDEO_SUBMITTING' : 'MEDIA_SUBMITTING';
  }
  if (runtime.priceIntentAt) return 'PRICE_SUBMITTING';
  if (asObject(runtime.cardCreateIntent).taskId || runtime.cardSubmittedAt) return 'CARD_SUBMITTING';
  return undefined;
}

function inferredRuntimePhase(runtime: JsonRecord, row: SqlRow): string {
  if (asObject(runtime.mediaTrimIntent).vendorCode) return 'MEDIA_TRIM';
  if (Array.isArray(asObject(runtime.mediaIntent).items)) return 'MEDIA_UPLOAD';
  if (runtime.priceIntentAt) return 'PRICE_UPLOAD';
  if (asObject(runtime.cardCreateIntent).taskId || runtime.cardSubmittedAt) return 'CARD_WRITE';
  const resume = stringOr(row.resume_state);
  if (resume.startsWith('STOCK_')) return resume === 'STOCK_SUBMITTING' ? 'STOCK_WRITE' : 'STOCK_LIST';
  return '';
}

function inferredRuntimeResumeState(runtime: JsonRecord): string {
  if (asObject(runtime.mediaTrimIntent).vendorCode) return 'MEDIA_TRIM_SUBMITTING';
  if (Array.isArray(asObject(runtime.mediaIntent).items)) {
    return asObject(runtime.mediaIntent).kind === 'video' ? 'VIDEO_SUBMITTING' : 'MEDIA_SUBMITTING';
  }
  if (runtime.priceIntentAt) return 'PRICE_SUBMITTING';
  if (asObject(runtime.cardCreateIntent).taskId || runtime.cardSubmittedAt) return 'CARD_SUBMITTING';
  return '';
}

function runtimeHistoricalIdentity(row: SqlRow): WbHistoricalRuntimeNetworkFailureCandidate['identity'] {
  return {
    taskId: String(row.task_id || ''),
    idempotencyKey: String(row.idempotency_key || ''),
    productCode: String(row.product_code || ''),
    revision: Number(row.revision || 0),
    payloadSignature: String(row.payload_signature || ''),
    workRelpath: String(row.work_relpath || '')
  };
}

function sameRuntimeHistoricalIdentity(
  actual: WbHistoricalRuntimeNetworkFailureCandidate['identity'],
  expected: WbHistoricalRuntimeNetworkFailureCandidate['identity']
): boolean {
  return actual.taskId === expected.taskId
    && actual.idempotencyKey === expected.idempotencyKey
    && actual.productCode === expected.productCode
    && actual.revision === expected.revision
    && actual.payloadSignature === expected.payloadSignature
    && actual.workRelpath === expected.workRelpath;
}

function runtimeHistoricalEvidence(
  row: SqlRow,
  transport: { errorCode: string; errorMessage: string; httpStatus?: number },
  plan: HistoricalRuntimeRecoveryPlan
): WbHistoricalRuntimeNetworkFailureCandidate['evidence'] {
  return {
    state: 'FAILED',
    transport: true,
    errorCode: transport.errorCode,
    errorMessage: transport.errorMessage,
    ...(transport.httpStatus ? { httpStatus: transport.httpStatus } : {}),
    activeLease: false,
    phase: plan.phase,
    checkpoint: plan.checkpoint,
    deliveryState: plan.deliveryState,
    ...(plan.safeResumeState ? { safeResumeState: plan.safeResumeState } : {}),
    safeReadback: plan.safeReadback,
    recoverable: plan.recoverable,
    reason: plan.reason,
    ...(isoOrUndefined(row.updated_at) ? { updatedAt: isoOrUndefined(row.updated_at) } : {})
  };
}

function validationError(issues: Array<{ path: PropertyKey[]; message: string }>) {
  return new AppError('CONFIG_INVALID', issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；'), { issues });
}

function asObject(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as JsonRecord).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
