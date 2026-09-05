import { randomUUID } from 'node:crypto';
import pLimit from 'p-limit';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import {
  AppError,
  WB_DEFAULT_STORE_ID,
  WB_AUTO_PUBLISH_STATES,
  wbNetworkRecoverySchema,
  type WbAutoPublishMode,
  type WbAutoPublishState,
  type WbNetworkRecovery
} from '@n8n-media-review/shared';
import { ensureWbAutoPublishStoreColumns } from './wb-stores.js';

type SqlRow = Record<string, any>;
type JsonRecord = Record<string, unknown>;

export type WbAutoPublishProductLink = {
  nmId: string | number;
  url: string;
  variantCode?: string;
};

export type WbAutoPublishJob = {
  id: string;
  storeId: string;
  sku: string;
  runId: string;
  runNo: number;
  operationMode: WbAutoPublishMode;
  triggerType: 'MEDIA_DELIVERY' | 'MANUAL';
  baseRevision: number;
  targetRevision: number;
  mediaTargetVariantIds: string[];
  mediaTargetVendorCodes: string[];
  warnings: JsonRecord[];
  variantSummary: { created: number; updated: number; preserved: number };
  state: WbAutoPublishState;
  presetId?: string;
  presetName?: string;
  presetRowVersion?: number;
  presetSnapshot?: JsonRecord;
  presetBinding?: JsonRecord;
  presetBoundAt?: string;
  presetActivationStartedAt?: string;
  presetDefinitionHash?: string;
  materialPresetDefinitionHash?: string;
  sourcePresetExists: boolean;
  mediaSignature?: string;
  expectedVendorCodes: string[];
  attemptCount: number;
  retryCounters: Record<string, number>;
  networkRecovery?: WbNetworkRecovery;
  nextAttemptAt?: string;
  n8nTaskId?: string;
  publicationId?: string;
  nmIds: Array<string | number>;
  productUrls: string[];
  productLinks?: WbAutoPublishProductLink[];
  lastErrorCode?: string;
  lastErrorMessage?: string;
  lastDeliveryAt?: string;
  createdAt: string;
  updatedAt: string;
  canRecheck: boolean;
  canCancel: boolean;
  hasListing: boolean;
};

export type WbHistoricalNetworkFailureCandidate = {
  kind: 'AUTO';
  identity: {
    storeId: string;
    sku: string;
    runId: string;
    runNo: number;
    taskId: string | null;
  };
  rowVersion: string;
  proposedRecovery: WbNetworkRecovery;
  evidence: {
    state: 'FAILED';
    transport: true;
    errorCode: string;
    errorMessage: string;
    httpStatus?: number;
    activeLease: false;
    updatedAt: string;
  };
  job: WbAutoPublishJob;
};

export type WbHistoricalNetworkFailureRecoveryResult = {
  job: WbAutoPublishJob;
  rowVersion: string;
  evidence: WbHistoricalNetworkFailureCandidate['evidence'];
};

export type WbAutoPublishEvent = {
  id: string;
  eventType: string;
  fromState?: WbAutoPublishState;
  toState?: WbAutoPublishState;
  message?: string;
  details?: JsonRecord;
  createdAt: string;
};

export type WbAutoPublishNotificationAction = 'EMIT_FAILURE' | 'RESOLVE_FAILURE';
export type WbAutoPublishPendingNotification = {
  action: WbAutoPublishNotificationAction;
  payload: JsonRecord;
  job: WbAutoPublishJob;
};

export type WbAutoGenerationLeaseClaim = {
  acquired: boolean;
  sku: string;
  ownerJobId: string;
  ownerRunId: string;
  ownerStoreId: string;
  phase: string;
  sourceVersionId?: string;
  leaseUntil: string;
  rowVersion: number;
};

export type WbAutoGenerationOwner = {
  id: string;
  runId: string;
  storeId: string;
  state: WbAutoPublishState;
  publicationId?: string;
};

const TERMINAL = new Set<WbAutoPublishState>(['SUCCEEDED', 'BLOCKED_EXISTING_CARD', 'CANCELLED']);
const CANCELLABLE = new Set<WbAutoPublishState>(['WAITING_MEDIA', 'WAITING_STABLE', 'WAITING_GENERATION_TURN', 'CHECKING', 'INITIALIZING', 'GENERATING', 'NEEDS_ATTENTION', 'PAUSED', 'FAILED']);
const RECHECKABLE = new Set<WbAutoPublishState>(['WAITING_MEDIA', 'WAITING_STABLE', 'NEEDS_ATTENTION', 'PAUSED', 'FAILED']);

export class WbAutoPublishRepository {
  private pool?: Pool;
  // A SKU lock holds one client while its callback uses this same four-client
  // pool. Reserve two clients for callback queries, even during store fan-out.
  private readonly skuLockSlots = pLimit(2);

  constructor(private readonly connectionString?: string) {}
  get configured(): boolean { return Boolean(this.pool); }

  async initialize(): Promise<void> {
    if (!this.connectionString) return;
    this.pool = new Pool({ connectionString: this.connectionString, max: 4, idleTimeoutMillis: 30_000 });
    try { await this.pool.query('SELECT 1'); await this.migrate(); await ensureWbAutoPublishStoreColumns(this.pool); }
    catch (error) { await this.pool.end().catch(() => undefined); this.pool = undefined; throw error; }
  }

  async close(): Promise<void> { await this.pool?.end(); }

  async enqueueDelivery(input: {
    storeId?: string;
    sku: string;
    stageId: 'E004' | 'E005';
    submissionId: string;
    variantId?: string;
    deliveredAt: string;
    preset: { id: string; name: string; rowVersion: number; snapshot: JsonRecord };
    binding: JsonRecord;
    materialPresetDefinitionHash: string;
    debounceUntil: string;
    operationMode: WbAutoPublishMode;
  }): Promise<WbAutoPublishJob | undefined> {
    return this.transaction(async (client) => {
      const storeId = input.storeId || WB_DEFAULT_STORE_ID;
      const existingListing = await client.query<SqlRow>('SELECT sku,draft_version FROM wb_listing_drafts WHERE sku=$1', [input.sku]);
      const current = await client.query<SqlRow>('SELECT * FROM wb_auto_publish_jobs WHERE store_id=$1 AND sku=$2 FOR UPDATE', [storeId, input.sku]);
      if (current.rows[0]) {
        const duplicate = await client.query(`SELECT id FROM wb_auto_publish_events
          WHERE job_id=$1 AND event_type='MEDIA_DELIVERED' AND details->>'submissionId'=$2 LIMIT 1`, [current.rows[0].id, input.submissionId]);
        if (duplicate.rows[0]) return toJob(current.rows[0], Boolean(existingListing.rows[0]));
      }
      if (existingListing.rows[0] && input.operationMode === 'CREATE_ONLY') {
        return current.rows[0] ? toJob(current.rows[0], true) : undefined;
      }
      const nextRunId = randomUUID();
      const nextRunNo = Number(current.rows[0]?.run_no || 0) + 1;
      const baseRevision = Number(existingListing.rows[0]?.draft_version || 0);
      const targetVariantIds = input.variantId ? [input.variantId] : [];
      if (current.rows[0] && TERMINAL.has(current.rows[0].state)) {
        await archiveRun(client, current.rows[0]);
        await client.query(`UPDATE wb_auto_publish_jobs SET
          run_id=$2,run_no=$3,operation_mode=$4,trigger_type='MEDIA_DELIVERY',base_revision=$5,target_revision=$6,
          media_target_variant_ids=$7::jsonb,media_target_vendor_codes='[]'::jsonb,warnings='[]'::jsonb,variant_summary='{}'::jsonb,
          state='WAITING_STABLE',preset_id=$8,preset_name=$9,preset_row_version=$10,preset_snapshot=$11::jsonb,preset_binding=$12::jsonb,
          preset_bound_at=$13,preset_activation_started_at=$14,preset_definition_hash=$15,material_preset_definition_hash=$16,
          media_signature=NULL,expected_vendor_codes='[]'::jsonb,attempt_count=0,retry_counters='{}'::jsonb,network_recovery='{}'::jsonb,next_attempt_at=$17,n8n_task_id=NULL,publication_id=NULL,
          last_error_code=NULL,last_error_message=NULL,last_delivery_at=$18,worker_id=NULL,lease_until=NULL,
          notification_action=NULL,notification_payload='{}'::jsonb,created_at=NOW(),updated_at=NOW()
          WHERE id=$1`, [current.rows[0].id, nextRunId, nextRunNo, input.operationMode, baseRevision, baseRevision + 1,
          JSON.stringify(targetVariantIds), input.preset.id, input.preset.name, input.preset.rowVersion,
          JSON.stringify(input.preset.snapshot), JSON.stringify(input.binding), String(input.binding.boundAt || input.deliveredAt),
          String(input.binding.activationStartedAt || input.deliveredAt), String(input.binding.definitionHash || ''), input.materialPresetDefinitionHash,
          input.debounceUntil, input.deliveredAt]);
      } else {
        await client.query(`INSERT INTO wb_auto_publish_jobs(
          id,store_id,sku,run_id,run_no,operation_mode,trigger_type,base_revision,target_revision,media_target_variant_ids,
          state,preset_id,preset_name,preset_row_version,preset_snapshot,preset_binding,preset_bound_at,preset_activation_started_at,preset_definition_hash,material_preset_definition_hash,next_attempt_at,last_delivery_at)
          VALUES($1,$2,$3,$4,$5,$6,'MEDIA_DELIVERY',$7,$8,$9::jsonb,'WAITING_STABLE',$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19,$20)
          ON CONFLICT(store_id,sku) DO UPDATE SET
            state=CASE WHEN wb_auto_publish_jobs.state IN ('QUEUED','RUNNING') THEN wb_auto_publish_jobs.state ELSE 'WAITING_STABLE' END,
            media_target_variant_ids=(SELECT COALESCE(jsonb_agg(DISTINCT value),'[]'::jsonb) FROM jsonb_array_elements(wb_auto_publish_jobs.media_target_variant_ids || EXCLUDED.media_target_variant_ids)),
            next_attempt_at=CASE WHEN wb_auto_publish_jobs.state IN ('QUEUED','RUNNING') THEN wb_auto_publish_jobs.next_attempt_at ELSE GREATEST(wb_auto_publish_jobs.next_attempt_at,EXCLUDED.next_attempt_at) END,
            last_delivery_at=GREATEST(wb_auto_publish_jobs.last_delivery_at,EXCLUDED.last_delivery_at),updated_at=NOW()`, [
          randomUUID(), storeId, input.sku, nextRunId, nextRunNo, input.operationMode, baseRevision, baseRevision + 1, JSON.stringify(targetVariantIds),
          input.preset.id, input.preset.name, input.preset.rowVersion, JSON.stringify(input.preset.snapshot), JSON.stringify(input.binding),
          String(input.binding.boundAt || input.deliveredAt), String(input.binding.activationStartedAt || input.deliveredAt),
          String(input.binding.definitionHash || ''), input.materialPresetDefinitionHash, input.debounceUntil, input.deliveredAt
        ]);
      }
      const row = await client.query<SqlRow>('SELECT * FROM wb_auto_publish_jobs WHERE store_id=$1 AND sku=$2', [storeId, input.sku]);
      await client.query(`INSERT INTO wb_auto_publish_events(id,job_id,store_id,sku,event_type,to_state,message,details)
        VALUES($1,$2,$3,$4,'MEDIA_DELIVERED','WAITING_STABLE',$5,$6::jsonb)
        ON CONFLICT(job_id,event_type,(details->>'submissionId')) WHERE event_type='MEDIA_DELIVERED' DO NOTHING`, [
        randomUUID(), row.rows[0]!.id, storeId, input.sku, `${input.stageId} 媒体投递完成`, JSON.stringify({ runId: current.rows[0] && !TERMINAL.has(current.rows[0].state) ? current.rows[0].run_id : nextRunId, submissionId: input.submissionId, stageId: input.stageId, variantId: input.variantId, deliveredAt: input.deliveredAt })
      ]);
      await markListingOperationSource(client, input.sku, input.deliveredAt, `automation:${String(row.rows[0]!.run_id)}`);
      return toJob(row.rows[0]!, Boolean(existingListing.rows[0]));
    });
  }

  async recordDelivery(input: { storeId?: string; sku: string; stageId: 'E004' | 'E005'; submissionId: string; variantId?: string; deliveredAt: string; debounceUntil: string }): Promise<WbAutoPublishJob> {
    return this.transaction(async (client) => {
      const storeId = input.storeId || WB_DEFAULT_STORE_ID;
      const current = await client.query<SqlRow>('SELECT * FROM wb_auto_publish_jobs WHERE store_id=$1 AND sku=$2 FOR UPDATE', [storeId, input.sku]);
      if (!current.rows[0]) throw new AppError('NOT_FOUND', '自动上品任务不存在', { sku: input.sku }, 404);
      const duplicate = await client.query(`SELECT id FROM wb_auto_publish_events
        WHERE job_id=$1 AND event_type='MEDIA_DELIVERED' AND details->>'submissionId'=$2 LIMIT 1`, [current.rows[0].id, input.submissionId]);
      if (!duplicate.rows[0] && !TERMINAL.has(current.rows[0].state)) {
        await client.query(`UPDATE wb_auto_publish_jobs SET
          state=CASE WHEN state IN ('QUEUED','RUNNING') THEN state ELSE 'WAITING_STABLE' END,
          next_attempt_at=CASE WHEN state IN ('QUEUED','RUNNING') THEN next_attempt_at ELSE GREATEST(next_attempt_at,$2::timestamptz) END,
          media_target_variant_ids=CASE WHEN $4::text IS NULL THEN media_target_variant_ids ELSE
            (SELECT COALESCE(jsonb_agg(DISTINCT value),'[]'::jsonb) FROM jsonb_array_elements(media_target_variant_ids || jsonb_build_array($4::text))) END,
          last_delivery_at=GREATEST(last_delivery_at,$3::timestamptz),updated_at=NOW() WHERE id=$1`, [current.rows[0].id, input.debounceUntil, input.deliveredAt, input.variantId || null]);
        await client.query(`INSERT INTO wb_auto_publish_events(id,job_id,store_id,sku,event_type,to_state,message,details)
          VALUES($1,$2,$3,$4,'MEDIA_DELIVERED','WAITING_STABLE',$5,$6::jsonb)
          ON CONFLICT(job_id,event_type,(details->>'submissionId')) WHERE event_type='MEDIA_DELIVERED' DO NOTHING`, [
          randomUUID(), current.rows[0].id, storeId, input.sku, `${input.stageId} 媒体投递完成`, JSON.stringify({ runId: current.rows[0].run_id, submissionId: input.submissionId, stageId: input.stageId, variantId: input.variantId, deliveredAt: input.deliveredAt })
        ]);
        await markListingOperationSource(client, input.sku, input.deliveredAt, `automation:${String(current.rows[0].run_id)}`);
      }
      const row = await client.query<SqlRow>(`SELECT j.*,${LISTING_RESULT_PROJECTION}
        FROM wb_auto_publish_jobs j LEFT JOIN wb_listing_drafts d ON d.sku=j.sku WHERE j.store_id=$1 AND j.sku=$2`, [storeId, input.sku]);
      return toJob(row.rows[0]!, Boolean(row.rows[0]!.has_listing));
    });
  }

  async claimDue(workerId: string, limit: number, leaseMs = 60_000): Promise<WbAutoPublishJob[]> {
    const safeLimit = Math.min(10, Math.max(1, Math.trunc(limit)));
    return this.transaction(async (client) => {
      const storesAvailable = Boolean((await client.query<{ available: boolean }>("SELECT to_regclass(current_schema()||'.wb_stores') IS NOT NULL available")).rows[0]?.available);
      const storeJoin = storesAvailable ? `JOIN wb_stores store ON store.id=j.store_id AND store.enabled=true AND store.archived_at IS NULL
          JOIN wb_system_settings settings ON settings.settings_id='default' AND settings.enabled=true
          LEFT JOIN wb_store_publications publication ON publication.id=j.publication_id AND publication.store_id=j.store_id
          LEFT JOIN wb_store_credential_versions task_credential
            ON task_credential.id=publication.credential_version_id AND task_credential.store_id=j.store_id` : '';
      const storeGate = storesAvailable ? `AND (
              (store.id='${WB_DEFAULT_STORE_ID}'::uuid AND store.credential_state='LEGACY_EXTERNAL')
              OR (publication.id IS NOT NULL AND publication.credential_version_id IS NOT NULL
                AND BTRIM(COALESCE(publication.config_snapshot->>'warehouseId',''))<>''
                AND task_credential.status IN ('ACTIVE','RETIRED'))
              OR (store.credential_state='ACTIVE' AND store.active_credential_version_id IS NOT NULL
                AND store.preflight_status='PASSED' AND BTRIM(store.warehouse_id)<>''
                AND UPPER(store.account_currency)='CNY' AND store.default_preset_id IS NOT NULL)
            )` : '';
      const result = await client.query<SqlRow>(`WITH ranked AS (
          SELECT j.id,
            ROW_NUMBER() OVER(PARTITION BY j.store_id ORDER BY COALESCE(j.next_attempt_at,j.created_at),j.created_at,j.id) store_rank
          FROM wb_auto_publish_jobs j
          ${storeJoin}
          WHERE (j.state IN ('CHECKING','INITIALIZING','GENERATING','SUBMITTING')
            OR (j.state IN ('WAITING_STABLE','WAITING_NETWORK','WAITING_GENERATION_TURN','FAILED') AND j.next_attempt_at IS NOT NULL AND j.next_attempt_at<=NOW()))
            AND (j.lease_until IS NULL OR j.lease_until<NOW())
            ${storeGate}
            AND NOT EXISTS(SELECT 1 FROM wb_auto_publish_jobs active
              WHERE active.store_id=j.store_id AND active.id<>j.id AND active.lease_until>NOW())
        ), candidates AS (
          SELECT j.*,EXISTS(SELECT 1 FROM wb_listing_drafts d WHERE d.sku=j.sku) has_listing
          FROM wb_auto_publish_jobs j JOIN ranked r ON r.id=j.id
          WHERE r.store_rank=1
          ORDER BY COALESCE(j.next_attempt_at,j.created_at),j.created_at,j.id
          FOR UPDATE OF j SKIP LOCKED LIMIT $1
        ) SELECT * FROM candidates`, [safeLimit]);
      if (result.rows.length) {
        await client.query(`UPDATE wb_auto_publish_jobs SET worker_id=$2,lease_until=NOW()+($3::text||' milliseconds')::interval,updated_at=NOW()
          WHERE id=ANY($1::uuid[])`, [result.rows.map((row) => row.id), workerId, leaseMs]);
      }
      return result.rows.map((row) => toJob(row, Boolean(row.has_listing)));
    });
  }

  async transition(sku: string, toState: WbAutoPublishState, input: {
    eventType?: string; message?: string; details?: JsonRecord; nextAttemptAt?: string | null; incrementAttempt?: boolean;
    incrementRetryKey?: string; resetRetryCounters?: boolean;
    networkRecovery?: WbNetworkRecovery | null;
    mediaSignature?: string; expectedVendorCodes?: string[]; n8nTaskId?: string; errorCode?: string | null; errorMessage?: string | null;
    clearLease?: boolean; mediaTargetVendorCodes?: string[]; warnings?: JsonRecord[];
    variantSummary?: { created: number; updated: number; preserved: number };
  } = {}, storeId: string = WB_DEFAULT_STORE_ID): Promise<WbAutoPublishJob> {
    if (!(WB_AUTO_PUBLISH_STATES as readonly string[]).includes(toState)) throw new AppError('CONFIG_INVALID', '无效的自动上品任务状态', { toState });
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>('SELECT * FROM wb_auto_publish_jobs WHERE store_id=$1 AND sku=$2 FOR UPDATE', [storeId, sku]);
      if (!current.rows[0]) throw new AppError('NOT_FOUND', '自动上品任务不存在', { sku }, 404);
      // Serialize with retry acceptance on the same job row. A prior read-only
      // scheduler check cannot protect against a retry accepted just afterwards.
      const retryTable = await client.query("SELECT to_regclass(current_schema() || '.wb_auto_publish_retries') IS NOT NULL present");
      if (retryTable.rows[0]?.present) {
        const retry = await client.query(`SELECT id FROM wb_auto_publish_retries WHERE job_id=$1 AND run_id=$2
          AND status IN ('CHECKING','RUNNING') AND stage<>'CHECKING_PREPARATION' LIMIT 1`,
        [current.rows[0].id, current.rows[0].run_id]);
        if (retry.rows.length) throw new AppError('TASK_LOCKED', '人工重试正在核对或恢复，旧调度结果不能覆盖原任务', { sku }, 409);
      }
      const fromState = current.rows[0].state as WbAutoPublishState;
      if (TERMINAL.has(fromState) && fromState !== toState) {
        throw new AppError('TASK_LOCKED', '自动上品任务已进入不可逆终态，不能继续推进', { sku, state: fromState, requestedState: toState }, 409);
      }
      const requestedNotification = notificationActionFor(toState, input, current.rows[0]);
      const notificationAction = requestedNotification?.action ?? current.rows[0].notification_action ?? null;
      const notificationPayload = requestedNotification?.payload ?? current.rows[0].notification_payload ?? {};
      const retryCounters = input.resetRetryCounters ? {} : asJsonRecord(current.rows[0].retry_counters);
      if (input.incrementRetryKey) {
        retryCounters[input.incrementRetryKey] = Math.max(0, Number(retryCounters[input.incrementRetryKey] || 0)) + 1;
      }
      const networkRecovery = input.networkRecovery === undefined
        ? toState === 'WAITING_NETWORK' ? asJsonRecord(current.rows[0].network_recovery) : {}
        : input.networkRecovery || {};
      await client.query(`UPDATE wb_auto_publish_jobs SET state=$3,
        next_attempt_at=$4,attempt_count=attempt_count+$5,
        media_signature=COALESCE($6,media_signature),expected_vendor_codes=COALESCE($7::jsonb,expected_vendor_codes),
        n8n_task_id=COALESCE($8,n8n_task_id),last_error_code=$9,last_error_message=$10,
        worker_id=CASE WHEN $11 THEN NULL ELSE worker_id END,lease_until=CASE WHEN $11 THEN NULL ELSE lease_until END,
        notification_action=$12,notification_payload=$13::jsonb,
        media_target_vendor_codes=COALESCE($14::jsonb,media_target_vendor_codes),warnings=COALESCE($15::jsonb,warnings),
        variant_summary=COALESCE($16::jsonb,variant_summary),
        retry_counters=$17::jsonb,network_recovery=$18::jsonb,
        notification_action_updated_at=CASE WHEN notification_action IS DISTINCT FROM $12 OR notification_payload IS DISTINCT FROM $13::jsonb THEN NOW() ELSE notification_action_updated_at END,
        updated_at=NOW()
        WHERE store_id=$1 AND sku=$2`, [storeId, sku, toState, input.nextAttemptAt === undefined ? current.rows[0].next_attempt_at : input.nextAttemptAt,
        input.incrementAttempt ? 1 : 0, input.mediaSignature || null, input.expectedVendorCodes ? JSON.stringify(input.expectedVendorCodes) : null,
        input.n8nTaskId || null, input.errorCode === undefined ? current.rows[0].last_error_code : input.errorCode,
        input.errorMessage === undefined ? current.rows[0].last_error_message : input.errorMessage, input.clearLease !== false,
        notificationAction, JSON.stringify(notificationPayload), input.mediaTargetVendorCodes ? JSON.stringify(input.mediaTargetVendorCodes) : null,
        input.warnings ? JSON.stringify(input.warnings) : null,
        input.variantSummary ? JSON.stringify(input.variantSummary) : null,
        JSON.stringify(retryCounters), JSON.stringify(networkRecovery)]);
      await client.query(`INSERT INTO wb_auto_publish_events(id,job_id,store_id,publication_id,sku,event_type,from_state,to_state,message,details)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [randomUUID(), current.rows[0].id, storeId,
        current.rows[0].publication_id || null, sku, input.eventType || 'STATE_CHANGED', fromState, toState,
        input.message || null, JSON.stringify(input.details || {})]);
      const row = await client.query<SqlRow>(`SELECT j.*,EXISTS(SELECT 1 FROM wb_listing_drafts d WHERE d.sku=j.sku) has_listing
        FROM wb_auto_publish_jobs j WHERE j.store_id=$1 AND j.sku=$2`, [storeId, sku]);
      return toJob(row.rows[0]!, Boolean(row.rows[0]!.has_listing));
    });
  }

  async releaseLease(sku: string, storeId: string = WB_DEFAULT_STORE_ID): Promise<void> {
    await this.query('UPDATE wb_auto_publish_jobs SET worker_id=NULL,lease_until=NULL,updated_at=NOW() WHERE store_id=$1 AND sku=$2', [storeId, sku]);
  }

  async claimGenerationLease(
    job: Pick<WbAutoPublishJob, 'id' | 'sku' | 'runId' | 'storeId'>,
    phase = 'GENERATING_SHARED_LISTING',
    leaseMs = 120_000
  ): Promise<WbAutoGenerationLeaseClaim> {
    const safeLeaseMs = Math.min(10 * 60_000, Math.max(30_000, Math.trunc(leaseMs)));
    return this.transaction(async (client) => {
      let current = await client.query<SqlRow>('SELECT * FROM wb_auto_generation_leases WHERE sku=$1 FOR UPDATE', [job.sku]);
      let row = current.rows[0];
      if (!row) {
        const created = await client.query<SqlRow>(`INSERT INTO wb_auto_generation_leases(
          sku,owner_job_id,owner_run_id,owner_store_id,phase,lease_until)
          VALUES($1,$2,$3,$4,$5,NOW()+($6::text||' milliseconds')::interval)
          ON CONFLICT(sku) DO NOTHING RETURNING *`, [
          job.sku, job.id, job.runId, job.storeId, phase, safeLeaseMs
        ]);
        if (created.rows[0]) return toGenerationLeaseClaim(created.rows[0], true);
        // PostgreSQL does not gap-lock a missing primary-key row. A concurrent
        // store may have inserted the SKU lease after our first SELECT, so lock
        // and classify that durable owner instead of surfacing a unique error.
        current = await client.query<SqlRow>('SELECT * FROM wb_auto_generation_leases WHERE sku=$1 FOR UPDATE', [job.sku]);
        row = current.rows[0];
        if (!row) {
          throw new AppError('DATABASE_UNAVAILABLE', '自动生成租约并发建账后无法回读', {
            sku: job.sku, jobId: job.id, runId: job.runId
          }, 503);
        }
      }
      const sameOwner = String(row.owner_job_id) === job.id && String(row.owner_run_id) === job.runId;
      const owner = await client.query<SqlRow>('SELECT state,publication_id,run_id,store_id FROM wb_auto_publish_jobs WHERE id=$1', [row.owner_job_id]);
      let ownerMaterializationFrozen = false;
      if (owner.rows[0]) {
        const publicationIdentityAvailable = Boolean((await client.query<{ available: boolean }>(`SELECT
          to_regclass(current_schema()||'.wb_store_publications') IS NOT NULL
          AND to_regclass(current_schema()||'.wb_listing_versions') IS NOT NULL
          AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
            AND table_name='wb_store_publications' AND column_name='request_key') available`)).rows[0]?.available);
        if (publicationIdentityAvailable) {
          ownerMaterializationFrozen = Boolean((await client.query<{ frozen: boolean }>(`SELECT EXISTS(
            SELECT 1
            FROM wb_store_publications publication
            JOIN wb_listing_versions publication_version ON publication_version.id=publication.generated_version_id
            JOIN wb_listing_versions source_version
              ON source_version.id::text=publication.config_snapshot->>'sourceGeneratedVersionId'
            WHERE publication.request_key='automation:'||$1::text||':'||$2::text
              AND publication.source='AUTOMATION'
              AND publication.sku=$3
              AND publication.store_id=$2::uuid
              AND publication.config_snapshot->>'automationRunId'=$1::text
              AND publication_version.sku=publication.sku
              AND publication_version.generation_scope='STORE_PUBLICATION'
              AND publication_version.status='GENERATED'
              AND publication.materialization_hash~'^sha256:[0-9a-f]{64}$'
              AND publication_version.materialization_hash=publication.materialization_hash
              AND source_version.sku=publication.sku
              AND source_version.generation_scope='LISTING'
              AND source_version.status='GENERATED'
              AND ($4::uuid IS NULL OR source_version.id=$4::uuid)
              AND ($5::uuid IS NULL OR publication.id=$5::uuid)
          ) frozen`, [
            owner.rows[0].run_id,
            owner.rows[0].store_id,
            job.sku,
            row.source_version_id || null,
            owner.rows[0].publication_id || null
          ])).rows[0]?.frozen);
        }
      }
      const expired = Date.parse(String(row.lease_until)) <= Date.now();
      // Job state is not a fencing signal: bulk pause/cancel can change it while
      // an old worker is still running. A different store may take the short
      // generation turn only after strict immutable materialization evidence or
      // after the lease actually expires.
      if (!sameOwner && !expired && !ownerMaterializationFrozen) return toGenerationLeaseClaim(row, false);
      const claimed = await client.query<SqlRow>(`UPDATE wb_auto_generation_leases SET
        owner_job_id=$2,owner_run_id=$3,owner_store_id=$4,phase=$5,source_version_id=NULL,
        lease_until=NOW()+($6::text||' milliseconds')::interval,row_version=row_version+1,updated_at=NOW()
        WHERE sku=$1 AND row_version=$7 RETURNING *`, [
        job.sku, job.id, job.runId, job.storeId, phase, safeLeaseMs, Number(row.row_version)
      ]);
      if (!claimed.rows[0]) {
        throw new AppError('AUTOMATION_GENERATION_LEASE_LOST', '自动生成租约在接管时发生并发变化', {
          sku: job.sku, jobId: job.id, runId: job.runId, expectedRowVersion: Number(row.row_version)
        }, 409);
      }
      return toGenerationLeaseClaim(claimed.rows[0]!, true);
    });
  }

  async heartbeatGenerationLease(
    job: Pick<WbAutoPublishJob, 'id' | 'sku' | 'runId'>,
    input: { phase: string; sourceVersionId?: string; expectedRowVersion: number },
    leaseMs = 120_000
  ): Promise<WbAutoGenerationLeaseClaim> {
    const safeLeaseMs = Math.min(10 * 60_000, Math.max(30_000, Math.trunc(leaseMs)));
    const result = await this.query<SqlRow>(`UPDATE wb_auto_generation_leases SET
      phase=$4,source_version_id=COALESCE($5,source_version_id),
      lease_until=NOW()+($6::text||' milliseconds')::interval,updated_at=NOW()
      WHERE sku=$1 AND owner_job_id=$2 AND owner_run_id=$3 AND row_version=$7 AND lease_until>NOW() RETURNING *`, [
      job.sku, job.id, job.runId, input.phase, input.sourceVersionId || null, safeLeaseMs,
      input.expectedRowVersion
    ]);
    if (!result.rows[0]) {
      throw new AppError('AUTOMATION_GENERATION_LEASE_LOST', '同一 SKU 的自动生成租约已失效，已停止继续物化', {
        sku: job.sku, jobId: job.id, runId: job.runId,
        expectedRowVersion: input.expectedRowVersion
      }, 409);
    }
    return toGenerationLeaseClaim(result.rows[0], true);
  }

  async releaseGenerationLease(
    job: Pick<WbAutoPublishJob, 'id' | 'sku' | 'runId'>,
    expectedRowVersion: number
  ): Promise<boolean> {
    const result = await this.query(`DELETE FROM wb_auto_generation_leases
      WHERE sku=$1 AND owner_job_id=$2 AND owner_run_id=$3 AND row_version=$4`, [
      job.sku, job.id, job.runId, expectedRowVersion
    ]);
    return (result.rowCount || 0) === 1;
  }

  async findGenerationOwner(sku: string, runId: string): Promise<WbAutoGenerationOwner | undefined> {
    const result = await this.query<SqlRow>(`SELECT id,run_id,store_id,state,publication_id
      FROM wb_auto_publish_jobs WHERE sku=$1 AND run_id=$2::uuid LIMIT 1`, [sku, runId]);
    const row = result.rows[0];
    return row ? {
      id: String(row.id),
      runId: String(row.run_id),
      storeId: String(row.store_id),
      state: row.state as WbAutoPublishState,
      ...(row.publication_id ? { publicationId: String(row.publication_id) } : {})
    } : undefined;
  }

  async listPendingNotificationActions(limit = 100): Promise<WbAutoPublishPendingNotification[]> {
    const safeLimit = Math.min(500, Math.max(1, Math.trunc(limit) || 100));
    const result = await this.query<SqlRow>(`SELECT j.*,EXISTS(SELECT 1 FROM wb_listing_drafts d WHERE d.sku=j.sku) has_listing
      FROM wb_auto_publish_jobs j
      WHERE j.notification_action IN ('EMIT_FAILURE','RESOLVE_FAILURE')
      ORDER BY j.notification_action_updated_at ASC NULLS FIRST,j.updated_at ASC
      LIMIT $1`, [safeLimit]);
    return result.rows.map((row) => ({
      action: row.notification_action as WbAutoPublishNotificationAction,
      payload: asJsonRecord(row.notification_payload),
      job: toJob(row, Boolean(row.has_listing))
    }));
  }

  async completeNotificationAction(sku: string, action: WbAutoPublishNotificationAction, expectedPayload: JsonRecord, storeId: string = WB_DEFAULT_STORE_ID): Promise<boolean> {
    const result = await this.query(`UPDATE wb_auto_publish_jobs SET
      notification_action=NULL,
      notification_payload=CASE WHEN $3='RESOLVE_FAILURE' THEN '{}'::jsonb ELSE notification_payload END,
      notification_action_completed_at=NOW(),updated_at=NOW()
      WHERE store_id=$1 AND sku=$2 AND notification_action=$3 AND notification_payload=$4::jsonb`, [storeId, sku, action, JSON.stringify(expectedPayload)]);
    return (result.rowCount || 0) > 0;
  }

  async withSkuLock<T>(sku: string, operation: () => Promise<T>, storeId: string = WB_DEFAULT_STORE_ID): Promise<{ acquired: boolean; value?: T }> {
    return this.skuLockSlots(async () => {
      const client = await this.requirePool().connect();
      let acquired = false;
      try {
        acquired = Boolean((await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtextextended('merchroute_wb_auto:'||$1||':'||$2,0)) acquired", [storeId, sku])).rows[0]?.acquired);
        if (!acquired) return { acquired: false };
        return { acquired: true, value: await operation() };
      } finally {
        if (acquired) await client.query("SELECT pg_advisory_unlock(hashtextextended('merchroute_wb_auto:'||$1||':'||$2,0))", [storeId, sku]).catch(() => undefined);
        client.release();
      }
    });
  }

  async linkPublication(sku: string, storeId: string, runId: string, publicationId: string): Promise<void> {
    await this.transaction(async (client) => {
      const result = await client.query<SqlRow>(`UPDATE wb_auto_publish_jobs SET publication_id=$3,updated_at=NOW()
        WHERE store_id=$1 AND sku=$2 AND run_id=$4::uuid
          AND (publication_id IS NULL OR publication_id=$3) RETURNING id,created_at`, [storeId, sku, publicationId, runId]);
      if ((result.rowCount || 0) !== 1) {
        throw new AppError('VERSION_CONFLICT', '自动上品任务已绑定到另一条店铺发布记录或 run 已变化', {
          sku, storeId, runId, publicationId
        }, 409);
      }
      await client.query(`UPDATE wb_auto_publish_events SET publication_id=$2
        WHERE job_id=$1 AND publication_id IS NULL AND created_at>=$3::timestamptz`, [
        result.rows[0]!.id, publicationId, result.rows[0]!.created_at
      ]);
    });
  }

  async setListingLock(sku: string, locked: boolean): Promise<void> {
    if (locked) {
      await this.query('UPDATE wb_listing_drafts SET auto_publish_locked=true,updated_at=NOW() WHERE sku=$1', [sku]);
      return;
    }
    await this.query(`UPDATE wb_listing_drafts SET auto_publish_locked=EXISTS(
      SELECT 1 FROM wb_auto_publish_jobs job WHERE job.sku=$1
        AND job.state NOT IN ('SUCCEEDED','BLOCKED_EXISTING_CARD','CANCELLED','NEEDS_ATTENTION','PAUSED','FAILED')
    ),updated_at=NOW() WHERE sku=$1`, [sku]);
  }

  async list(input: { page?: number; pageSize?: number; state?: string; query?: string; updatedFrom?: string; updatedTo?: string; storeId?: string } = {}) {
    const page = Math.max(1, Number(input.page) || 1);
    const pageSize = Math.min(100, Math.max(10, Number(input.pageSize) || 30));
    const values: unknown[] = [];
    const where: string[] = [];
    if (input.storeId) { values.push(input.storeId); where.push(`j.store_id=$${values.length}::uuid`); }
    if (input.state && (WB_AUTO_PUBLISH_STATES as readonly string[]).includes(input.state)) { values.push(input.state); where.push(`j.state=$${values.length}`); }
    if (input.query?.trim()) { values.push(`%${input.query.trim()}%`); where.push(`(j.sku ILIKE $${values.length} OR j.preset_name ILIKE $${values.length})`); }
    if (input.updatedFrom) { values.push(input.updatedFrom); where.push(`j.updated_at >= $${values.length}::timestamptz`); }
    if (input.updatedTo) { values.push(input.updatedTo); where.push(`j.updated_at < $${values.length}::timestamptz`); }
    where.push("(d.sku IS NULL OR d.latest_operation_source='AUTOMATION')");
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await this.query<{ count: string }>(`SELECT COUNT(*)::text count FROM wb_auto_publish_jobs j
      LEFT JOIN wb_listing_drafts d ON d.sku=j.sku ${filter}`, values);
    values.push(pageSize, (page - 1) * pageSize);
    const rows = await this.query<SqlRow>(`SELECT j.*,${LISTING_RESULT_PROJECTION}
      FROM wb_auto_publish_jobs j LEFT JOIN wb_listing_drafts d ON d.sku=j.sku
      ${filter} ORDER BY j.updated_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return { items: rows.rows.map((row) => toJob(row, Boolean(row.has_listing))), total: Number(count.rows[0]?.count || 0), page, pageSize };
  }

  async get(sku: string, storeId: string = WB_DEFAULT_STORE_ID): Promise<WbAutoPublishJob & { events: WbAutoPublishEvent[] }> {
    const row = await this.query<SqlRow>(`SELECT j.*,${LISTING_RESULT_PROJECTION}
      FROM wb_auto_publish_jobs j LEFT JOIN wb_listing_drafts d ON d.sku=j.sku WHERE j.store_id=$1 AND j.sku=$2`, [storeId, sku]);
    if (!row.rows[0]) throw new AppError('NOT_FOUND', '自动上品任务不存在', { sku }, 404);
    const events = await this.query<SqlRow>('SELECT * FROM wb_auto_publish_events WHERE job_id=$1 ORDER BY created_at DESC,id DESC LIMIT 500', [row.rows[0].id]);
    return { ...toJob(row.rows[0], Boolean(row.rows[0].has_listing)), events: events.rows.map(toEvent) };
  }

  async listRuns(sku: string, storeId: string = WB_DEFAULT_STORE_ID): Promise<WbAutoPublishJob[]> {
    const current = await this.find(sku, storeId);
    const archived = await this.query<SqlRow>('SELECT snapshot FROM wb_auto_publish_job_runs WHERE store_id=$1 AND sku=$2 ORDER BY run_no DESC', [storeId, sku]);
    const history = archived.rows.map((row) => toJob(asJsonRecord(row.snapshot), Boolean(asJsonRecord(row.snapshot).has_listing)));
    return current ? [current, ...history] : history;
  }

  async startCompatible(input: {
    storeId?: string;
    sku: string;
    preset: { id: string; name: string; rowVersion: number; snapshot: JsonRecord };
    binding: JsonRecord;
    materialPresetDefinitionHash: string;
    variantIds: string[];
    baseRevision: number;
  }): Promise<WbAutoPublishJob> {
    return this.transaction(async (client) => {
      const storeId = input.storeId || WB_DEFAULT_STORE_ID;
      const current = await client.query<SqlRow>('SELECT * FROM wb_auto_publish_jobs WHERE store_id=$1 AND sku=$2 FOR UPDATE', [storeId, input.sku]);
      if (current.rows[0] && !TERMINAL.has(current.rows[0].state) && current.rows[0].state !== 'FAILED') {
        throw new AppError('TASK_LOCKED', '该 SKU 已有一轮自动上品正在执行', { sku: input.sku, state: current.rows[0].state }, 409);
      }
      if (current.rows[0]) await archiveRun(client, current.rows[0]);
      const runId = randomUUID();
      const runNo = Number(current.rows[0]?.run_no || 0) + 1;
      await client.query(`INSERT INTO wb_auto_publish_jobs(
        id,store_id,sku,run_id,run_no,operation_mode,trigger_type,base_revision,target_revision,media_target_variant_ids,
        state,preset_id,preset_name,preset_row_version,preset_snapshot,preset_binding,preset_bound_at,preset_activation_started_at,preset_definition_hash,material_preset_definition_hash,next_attempt_at,last_delivery_at)
        VALUES($1,$2,$3,$4,$5,'COMPATIBLE_UPSERT','MANUAL',$6,$7,$8::jsonb,'CHECKING',$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17,NOW(),NOW())
        ON CONFLICT(store_id,sku) DO UPDATE SET run_id=EXCLUDED.run_id,run_no=EXCLUDED.run_no,operation_mode=EXCLUDED.operation_mode,
          trigger_type=EXCLUDED.trigger_type,base_revision=EXCLUDED.base_revision,target_revision=EXCLUDED.target_revision,
          media_target_variant_ids=EXCLUDED.media_target_variant_ids,media_target_vendor_codes='[]'::jsonb,warnings='[]'::jsonb,variant_summary='{}'::jsonb,
          state='CHECKING',preset_id=EXCLUDED.preset_id,preset_name=EXCLUDED.preset_name,preset_row_version=EXCLUDED.preset_row_version,
          preset_snapshot=EXCLUDED.preset_snapshot,preset_binding=EXCLUDED.preset_binding,preset_bound_at=EXCLUDED.preset_bound_at,
          preset_activation_started_at=EXCLUDED.preset_activation_started_at,preset_definition_hash=EXCLUDED.preset_definition_hash,
          material_preset_definition_hash=EXCLUDED.material_preset_definition_hash,
          media_signature=NULL,expected_vendor_codes='[]'::jsonb,attempt_count=0,next_attempt_at=NOW(),n8n_task_id=NULL,publication_id=NULL,
          retry_counters='{}'::jsonb,network_recovery='{}'::jsonb,
          last_error_code=NULL,last_error_message=NULL,last_delivery_at=NOW(),worker_id=NULL,lease_until=NULL,
          notification_action=NULL,notification_payload='{}'::jsonb,created_at=NOW(),updated_at=NOW()`, [
        randomUUID(), storeId, input.sku, runId, runNo, input.baseRevision, input.baseRevision + 1, JSON.stringify([...new Set(input.variantIds)]),
        input.preset.id, input.preset.name, input.preset.rowVersion, JSON.stringify(input.preset.snapshot), JSON.stringify(input.binding),
        String(input.binding.boundAt || new Date().toISOString()), String(input.binding.activationStartedAt || new Date(0).toISOString()),
        String(input.binding.definitionHash || ''), input.materialPresetDefinitionHash
      ]);
      const job = await client.query<SqlRow>('SELECT * FROM wb_auto_publish_jobs WHERE store_id=$1 AND sku=$2', [storeId, input.sku]);
      await client.query(`INSERT INTO wb_auto_publish_events(id,job_id,store_id,sku,event_type,to_state,message,details)
        VALUES($1,$2,$3,$4,'MANUAL_COMPATIBLE_STARTED','CHECKING','用户确认启动兼容重新上品',$5::jsonb)`, [
        randomUUID(), job.rows[0]!.id, storeId, input.sku, JSON.stringify({ runId, runNo })
      ]);
      await markListingOperationSource(client, input.sku, new Date().toISOString(), `automation:${runId}`);
      const row = await client.query<SqlRow>(`SELECT j.*,${LISTING_RESULT_PROJECTION}
        FROM wb_auto_publish_jobs j LEFT JOIN wb_listing_drafts d ON d.sku=j.sku WHERE j.store_id=$1 AND j.sku=$2`, [storeId, input.sku]);
      return toJob(row.rows[0]!, true);
    });
  }

  async find(sku: string, storeId: string = WB_DEFAULT_STORE_ID): Promise<WbAutoPublishJob | undefined> {
    const row = await this.query<SqlRow>(`SELECT j.*,${LISTING_RESULT_PROJECTION}
      FROM wb_auto_publish_jobs j LEFT JOIN wb_listing_drafts d ON d.sku=j.sku WHERE j.store_id=$1 AND j.sku=$2`, [storeId, sku]);
    return row.rows[0] ? toJob(row.rows[0], Boolean(row.rows[0].has_listing)) : undefined;
  }

  async counts(): Promise<Record<string, number>> {
    const result = await this.query<{ state: string; count: string }>(`SELECT j.state,COUNT(*)::text count
      FROM wb_auto_publish_jobs j LEFT JOIN wb_listing_drafts d ON d.sku=j.sku
      WHERE d.sku IS NULL OR d.latest_operation_source='AUTOMATION'
      GROUP BY j.state`);
    return Object.fromEntries(result.rows.map((row) => [row.state, Number(row.count)]));
  }

  async boundCountsByPreset(): Promise<Record<string, number>> {
    const result = await this.query<{ preset_id: string; count: string }>(`SELECT COALESCE(j.preset_id::text,j.preset_binding->>'presetId') preset_id,COUNT(*)::text count
      FROM wb_auto_publish_jobs j LEFT JOIN wb_listing_drafts d ON d.sku=j.sku
      WHERE j.state NOT IN ('SUCCEEDED','BLOCKED_EXISTING_CARD','CANCELLED')
        AND (d.sku IS NULL OR d.latest_operation_source='AUTOMATION')
        AND COALESCE(j.preset_id::text,j.preset_binding->>'presetId') IS NOT NULL
      GROUP BY COALESCE(j.preset_id::text,j.preset_binding->>'presetId')`);
    return Object.fromEntries(result.rows.map((row) => [row.preset_id, Number(row.count)]));
  }

  async earliestOpenBindingAt(): Promise<string | undefined> {
    const result = await this.query<{ earliest: Date | string | null }>(`SELECT MIN(COALESCE(preset_bound_at,created_at)) earliest
      FROM wb_auto_publish_jobs WHERE state NOT IN ('SUCCEEDED','BLOCKED_EXISTING_CARD','CANCELLED')`);
    return result.rows[0]?.earliest ? new Date(result.rows[0].earliest).toISOString() : undefined;
  }

  async recheck(sku: string, storeId: string = WB_DEFAULT_STORE_ID): Promise<WbAutoPublishJob> {
    const current = await this.get(sku, storeId);
    if (!current.canRecheck) throw new AppError('TASK_LOCKED', '当前自动上品任务不能重新检查', { sku, state: current.state }, 409);
    await this.setListingLock(sku, true);
    await this.markAutomaticOperation(sku, current.runId);
    if (current.state === 'BLOCKED_EXISTING_CARD') {
      return this.reopenBlockedExistingCard(sku, storeId);
    }
    return this.transition(sku, 'CHECKING', {
      eventType: 'MANUAL_RECHECK',
      message: '用户要求按原绑定模板重新检查自动上品条件',
      nextAttemptAt: new Date().toISOString(),
      errorCode: null,
      errorMessage: null,
      resetRetryCounters: true
    }, storeId);
  }

  private async reopenBlockedExistingCard(sku: string, storeId: string): Promise<WbAutoPublishJob> {
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>('SELECT * FROM wb_auto_publish_jobs WHERE store_id=$1 AND sku=$2 FOR UPDATE', [storeId, sku]);
      const row = current.rows[0];
      if (!row) throw new AppError('NOT_FOUND', '自动上品任务不存在', { sku }, 404);
      if (row.state !== 'BLOCKED_EXISTING_CARD' || row.last_error_code !== 'WB_CARD_ALREADY_EXISTS' || !row.n8n_task_id) {
        throw new AppError('TASK_LOCKED', '当前阻断任务不满足 partial-create 恢复条件', {
          sku, state: row.state, lastErrorCode: row.last_error_code
        }, 409);
      }
      await client.query(`UPDATE wb_auto_publish_jobs SET
        state='CHECKING',next_attempt_at=NOW(),last_error_code=NULL,last_error_message=NULL,
        retry_counters='{}'::jsonb,network_recovery='{}'::jsonb,worker_id=NULL,lease_until=NULL,updated_at=NOW()
        WHERE store_id=$1 AND sku=$2`, [storeId, sku]);
      await client.query(`INSERT INTO wb_auto_publish_events(id,job_id,store_id,sku,event_type,from_state,to_state,message,details)
        VALUES($1,$2,$3,$4,'MANUAL_RECHECK','BLOCKED_EXISTING_CARD','CHECKING','用户要求重新检查 CREATE_ONLY partial-create 商品卡归属',$5::jsonb)`, [
        randomUUID(), row.id, storeId, sku, JSON.stringify({ n8nTaskId: row.n8n_task_id })
      ]);
      const refreshed = await client.query<SqlRow>(`SELECT j.*,${LISTING_RESULT_PROJECTION}
        FROM wb_auto_publish_jobs j LEFT JOIN wb_listing_drafts d ON d.sku=j.sku WHERE j.store_id=$1 AND j.sku=$2`, [storeId, sku]);
      return toJob(refreshed.rows[0]!, Boolean(refreshed.rows[0]!.has_listing));
    });
  }

  async persistBinding(
    sku: string,
    binding: JsonRecord,
    storeId: string = WB_DEFAULT_STORE_ID,
    materialPresetDefinitionHash?: string
  ): Promise<void> {
    await this.query(`UPDATE wb_auto_publish_jobs SET preset_binding=$2::jsonb,preset_bound_at=$3,preset_activation_started_at=$4,
      preset_definition_hash=$5,material_preset_definition_hash=COALESCE($6,material_preset_definition_hash),updated_at=NOW()
      WHERE store_id=$7 AND sku=$1`, [sku, JSON.stringify(binding), String(binding.boundAt || ''),
      String(binding.activationStartedAt || ''), String(binding.definitionHash || ''), materialPresetDefinitionHash || null, storeId]);
  }

  async markAutomaticOperation(sku: string, runId: string, occurredAt = new Date().toISOString()): Promise<void> {
    await this.transaction((client) => markListingOperationSource(client, sku, occurredAt, `automation:${runId}`));
  }

  async cancel(sku: string, storeId: string = WB_DEFAULT_STORE_ID): Promise<WbAutoPublishJob> {
    const current = await this.get(sku, storeId);
    if (!current.canCancel) throw new AppError('TASK_LOCKED', '任务已提交 WB，不能取消', { sku, state: current.state }, 409);
    const cancelled = await this.transition(sku, 'CANCELLED', { eventType: 'MANUAL_CANCELLED', message: '用户已取消自动上品任务', nextAttemptAt: null, errorCode: null, errorMessage: null }, storeId);
    await this.setListingLock(sku, false);
    return cancelled;
  }

  async pauseUnsubmitted(reason: string): Promise<number> {
    const rows = await this.query<{ id: string; store_id: string; sku: string }>(`UPDATE wb_auto_publish_jobs SET state='PAUSED',next_attempt_at=NULL,worker_id=NULL,lease_until=NULL,
      last_error_code='PRESET_DISABLED',last_error_message=$1,updated_at=NOW()
      WHERE state NOT IN ('QUEUED','RUNNING','SUCCEEDED','BLOCKED_EXISTING_CARD','CANCELLED') RETURNING id,store_id,sku`, [reason]);
    if (rows.rows.length) {
      for (const sku of new Set(rows.rows.map((row) => row.sku))) await this.setListingLock(sku, false);
      for (const row of rows.rows) {
        await this.query(`INSERT INTO wb_auto_publish_events(id,job_id,store_id,sku,event_type,to_state,message)
          VALUES($1,$2,$3,$4,'PRESET_DISABLED','PAUSED',$5)`, [randomUUID(), row.id, row.store_id, row.sku, reason]);
      }
    }
    return rows.rows.length;
  }

  async pauseMismatchedPreset(presetId: string, rowVersion: number): Promise<number> {
    const rows = await this.query<{ id: string; store_id: string; sku: string }>(`UPDATE wb_auto_publish_jobs SET state='PAUSED',next_attempt_at=NULL,worker_id=NULL,lease_until=NULL,
      last_error_code='PRESET_CHANGED',last_error_message='自动上品预设或依赖版本已变化，请人工确认后重新检查',updated_at=NOW()
      WHERE state NOT IN ('QUEUED','RUNNING','SUCCEEDED','BLOCKED_EXISTING_CARD','CANCELLED')
        AND (preset_id<>$1 OR preset_row_version<>$2) RETURNING id,store_id,sku`, [presetId, rowVersion]);
    if (rows.rows.length) {
      for (const sku of new Set(rows.rows.map((row) => row.sku))) await this.setListingLock(sku, false);
      for (const row of rows.rows) {
        await this.query(`INSERT INTO wb_auto_publish_events(id,job_id,store_id,sku,event_type,to_state,message,details)
          VALUES($1,$2,$3,$4,'PRESET_CHANGED','PAUSED','自动上品预设或依赖版本已变化，请人工确认后重新检查',$5::jsonb)`, [
          randomUUID(), row.id, row.store_id, row.sku, JSON.stringify({ currentPresetId: presetId, currentRowVersion: rowVersion })
        ]);
      }
    }
    return rows.rows.length;
  }

  async listSubmitted(limit = 100): Promise<WbAutoPublishJob[]> {
    const result = await this.query<SqlRow>(`SELECT j.*,${LISTING_RESULT_PROJECTION}
      FROM wb_auto_publish_jobs j LEFT JOIN wb_listing_drafts d ON d.sku=j.sku
      WHERE j.n8n_task_id IS NOT NULL AND (
        j.state IN ('QUEUED','RUNNING')
        OR (j.state='WAITING_NETWORK' AND j.next_attempt_at IS NOT NULL AND j.next_attempt_at<=NOW())
        OR (j.state='FAILED' AND j.updated_at>=NOW()-INTERVAL '24 hours')
      )
      ORDER BY j.updated_at LIMIT $1`, [Math.min(500, Math.max(1, limit))]);
    return result.rows.map((row) => toJob(row, Boolean(row.has_listing)));
  }

  async listHistoricalNetworkFailureCandidates(limit = 100): Promise<WbHistoricalNetworkFailureCandidate[]> {
    const safeLimit = Math.min(500, Math.max(1, Math.trunc(limit) || 100));
    const result = await this.query<SqlRow>(`SELECT j.*,j.xmin::text recovery_row_version,${LISTING_RESULT_PROJECTION}
      FROM wb_auto_publish_jobs j LEFT JOIN wb_listing_drafts d ON d.sku=j.sku
      WHERE j.state='FAILED'
        AND (j.worker_id IS NULL OR BTRIM(j.worker_id)='' OR j.lease_until IS NULL OR j.lease_until<=NOW())
        AND (
          UPPER(COALESCE(j.last_error_code,'')) IN ('ETIMEDOUT','ESOCKETTIMEDOUT','ECONNRESET','ECONNABORTED','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','TLS_EOF','HTTP_408','HTTP_429')
          OR UPPER(COALESCE(j.last_error_code,'')) ~ '(^|_)HTTP_(408|429|5[0-9]{2})$'
          OR UPPER(COALESCE(j.last_error_message,'')) ~ '(ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNABORTED|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|SOCKET HANG UP|TLS.*EOF|HTTP[^0-9]*(408|429|5[0-9]{2})|断网|网络(中断|不可用|连接失败|超时))'
        )
      ORDER BY j.updated_at ASC LIMIT $1`, [safeLimit]);
    return result.rows.flatMap((row) => {
      const transport = historicalTransportEvidence(row);
      if (!transport) return [];
      const job = toJob(row, Boolean(row.has_listing));
      const proposedRecovery = historicalAutoProposedRecovery(row, transport);
      return [{
        kind: 'AUTO' as const,
        identity: {
          storeId: job.storeId,
          sku: job.sku,
          runId: job.runId,
          runNo: job.runNo,
          taskId: job.n8nTaskId || null
        },
        rowVersion: String(row.recovery_row_version),
        proposedRecovery,
        evidence: {
          state: 'FAILED' as const,
          transport: true as const,
          errorCode: transport.errorCode,
          errorMessage: transport.errorMessage,
          ...(transport.httpStatus ? { httpStatus: transport.httpStatus } : {}),
          activeLease: false as const,
          updatedAt: job.updatedAt
        },
        job
      }];
    });
  }

  async recoverHistoricalNetworkFailure(
    skuInput: string,
    expected: { storeId?: string; runId: string; runNo: number; taskId: string | null; rowVersion: string },
    recoveryInput: WbNetworkRecovery
  ): Promise<WbHistoricalNetworkFailureRecoveryResult> {
    const sku = String(skuInput || '').trim();
    const storeId = String(expected?.storeId || WB_DEFAULT_STORE_ID).trim();
    const expectedRunId = String(expected?.runId || '').trim();
    const expectedRunNo = Number(expected?.runNo);
    const expectedTaskId = expected?.taskId === null ? null : String(expected?.taskId || '').trim();
    const expectedRowVersion = String(expected?.rowVersion || '').trim();
    if (!/^\d{7}$/.test(sku) || !expectedRunId || !Number.isInteger(expectedRunNo) || expectedRunNo < 1 || !expectedRowVersion
      || (expected?.taskId !== null && !expectedTaskId)) {
      throw new AppError('CONFIG_INVALID', 'sku、runId、runNo、taskId 与 rowVersion 必须提供完整的历史任务身份');
    }
    const parsedRecovery = wbNetworkRecoverySchema.safeParse(recoveryInput);
    const resumableStates = new Set<WbAutoPublishState>([
      'WAITING_MEDIA', 'WAITING_STABLE', 'CHECKING', 'INITIALIZING', 'GENERATING', 'SUBMITTING', 'QUEUED', 'RUNNING'
    ]);
    if (!parsedRecovery.success || !resumableStates.has(parsedRecovery.data.resumeState as WbAutoPublishState)) {
      throw new AppError('CONFIG_INVALID', '自动 WB 历史任务缺少安全的非终态 resumeState', {
        issues: parsedRecovery.success ? undefined : parsedRecovery.error.issues,
        resumeState: parsedRecovery.success ? parsedRecovery.data.resumeState : undefined
      });
    }
    const recovery = parsedRecovery.data;
    if (recovery.checkpoint && expectedTaskId && recovery.checkpoint !== `taskId:${expectedTaskId}`) {
      throw new AppError('CONFIG_INVALID', '网络恢复检查点与 expected taskId 不一致', {
        expectedTaskId, checkpoint: recovery.checkpoint
      });
    }
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>(`SELECT j.*,j.xmin::text recovery_row_version,
          (j.worker_id IS NOT NULL AND BTRIM(j.worker_id)<>'' AND j.lease_until>NOW()) active_auto_lease,
          ${LISTING_RESULT_PROJECTION}
        FROM wb_auto_publish_jobs j LEFT JOIN wb_listing_drafts d ON d.sku=j.sku
        WHERE j.store_id=$1 AND j.sku=$2
        FOR UPDATE OF j`, [storeId, sku]);
      const row = current.rows[0];
      const conflict = (message: string, details: JsonRecord = {}) => new AppError('VERSION_CONFLICT', message, {
        storeId, sku,
        expectedRunId,
        expectedRunNo,
        expectedTaskId,
        expectedRowVersion,
        actualRunId: row?.run_id ? String(row.run_id) : undefined,
        actualRunNo: row?.run_no ? Number(row.run_no) : undefined,
        actualTaskId: row?.n8n_task_id ? String(row.n8n_task_id) : null,
        actualRowVersion: row?.recovery_row_version ? String(row.recovery_row_version) : undefined,
        actualState: row?.state ? String(row.state) : undefined,
        ...details
      }, 409);
      if (!row) throw conflict('WB 自动上品历史任务不存在或已被清理');
      if (String(row.recovery_row_version) !== expectedRowVersion) throw conflict('WB 自动上品任务已变化，拒绝使用过期 rowVersion 恢复');
      if (String(row.run_id) !== expectedRunId || Number(row.run_no) !== expectedRunNo
        || (row.n8n_task_id ? String(row.n8n_task_id) : null) !== expectedTaskId) {
        throw conflict('WB 自动上品 run/task 身份已变化，拒绝覆盖新任务');
      }
      if (String(row.state) !== 'FAILED') throw conflict('WB 自动上品任务不再是可恢复的 FAILED 状态');
      const transport = historicalTransportEvidence(row);
      if (!transport) throw conflict('FAILED 记录缺少严格的网络或 HTTP 408/429/5xx 证据');
      const proposedRecovery = historicalAutoProposedRecovery(row, transport);
      if (JSON.stringify(proposedRecovery) !== JSON.stringify(recovery)) {
        throw conflict('客户端提交的 proposedRecovery 与当前 FAILED 证据不一致', {
          proposedRecovery
        });
      }
      if (row.active_auto_lease) {
        throw new AppError('TASK_LOCKED', 'WB 自动上品任务仍持有有效租约，拒绝并发恢复', {
          sku, workerId: String(row.worker_id), leaseUntil: new Date(row.lease_until).toISOString()
        }, 409);
      }
      if (expectedTaskId) {
        const runtime = await runtimeRecoveryGuard(client, expectedTaskId);
        if (runtime.activeLease) {
          throw new AppError('TASK_LOCKED', '原 WB runtime task 仍持有有效租约，拒绝并发恢复', {
            sku, expectedTaskId, runtimeRowVersion: runtime.rowVersion
          }, 409);
        }
        if (runtime.state === 'FAILED') {
          throw new AppError('RUNTIME_RECOVERY_REQUIRED', '原 WB runtime task 仍为 FAILED，必须先按其 rowVersion 原地恢复', {
            sku, expectedTaskId, runtimeRowVersion: runtime.rowVersion
          }, 409);
        }
      }
      const requestedNotification = notificationActionFor('WAITING_NETWORK', {}, row);
      const notificationAction = requestedNotification?.action ?? row.notification_action ?? null;
      const notificationPayload = requestedNotification?.payload ?? row.notification_payload ?? {};
      const changed = await client.query<SqlRow>(`UPDATE wb_auto_publish_jobs SET
          state='WAITING_NETWORK',network_recovery=$4::jsonb,next_attempt_at=$5,
          last_error_code=$6,last_error_message=$7,worker_id=NULL,lease_until=NULL,
          notification_action=$8,notification_payload=$9::jsonb,
          notification_action_updated_at=CASE
            WHEN notification_action IS DISTINCT FROM $8 OR notification_payload IS DISTINCT FROM $9::jsonb THEN NOW()
            ELSE notification_action_updated_at END,
          updated_at=NOW()
        WHERE store_id=$1 AND sku=$2 AND xmin::text=$3 AND state='FAILED'
        RETURNING xmin::text recovery_row_version`, [storeId, sku, expectedRowVersion, JSON.stringify(recovery), recovery.nextAttemptAt,
        recovery.lastErrorCode, recovery.lastErrorMessage, notificationAction, JSON.stringify(notificationPayload)]);
      if (!changed.rows[0]) throw conflict('WB 自动上品历史任务 CAS 恢复冲突');
      await client.query(`INSERT INTO wb_auto_publish_events(id,job_id,store_id,sku,event_type,from_state,to_state,message,details)
        VALUES($1,$2,$3,$4,'HISTORICAL_NETWORK_FAILURE_RECOVERED','FAILED','WAITING_NETWORK',$5,$6::jsonb)`, [
        randomUUID(), row.id, storeId, sku, '历史网络失败已按原 run/task 身份恢复，等待网络重试窗口', JSON.stringify({
          runId: expectedRunId, runNo: expectedRunNo, taskId: expectedTaskId,
          previousRowVersion: expectedRowVersion, networkRecovery: recovery,
          transport: { errorCode: transport.errorCode, errorMessage: transport.errorMessage, httpStatus: transport.httpStatus }
        })
      ]);
      const recovered = await client.query<SqlRow>(`SELECT j.*,j.xmin::text recovery_row_version,${LISTING_RESULT_PROJECTION}
        FROM wb_auto_publish_jobs j LEFT JOIN wb_listing_drafts d ON d.sku=j.sku WHERE j.store_id=$1 AND j.sku=$2`, [storeId, sku]);
      const job = toJob(recovered.rows[0]!, Boolean(recovered.rows[0]!.has_listing));
      return {
        job,
        rowVersion: String(recovered.rows[0]!.recovery_row_version),
        evidence: {
          state: 'FAILED', transport: true,
          errorCode: transport.errorCode, errorMessage: transport.errorMessage,
          ...(transport.httpStatus ? { httpStatus: transport.httpStatus } : {}),
          activeLease: false, updatedAt: new Date(row.updated_at).toISOString()
        }
      };
    });
  }

  private async migrate(): Promise<void> {
    await this.query('CREATE TABLE IF NOT EXISTS wb_schema_migrations(id TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const lock = await this.requirePool().connect();
    try {
      await lock.query("SELECT pg_advisory_lock(hashtext('pixroute_wb_schema_migrations'))");
      const applied = await lock.query("SELECT id FROM wb_schema_migrations WHERE id='011_wb_auto_publish_jobs'");
      if (!applied.rows[0]) {
        await lock.query('BEGIN');
        await lock.query("ALTER TABLE wb_listing_drafts ADD COLUMN IF NOT EXISTS auto_publish_locked BOOLEAN NOT NULL DEFAULT false");
        await lock.query(`CREATE TABLE wb_auto_publish_jobs(
          sku CHAR(7) PRIMARY KEY REFERENCES products(sku) ON DELETE CASCADE,
          state TEXT NOT NULL CHECK(state IN (${WB_AUTO_PUBLISH_STATES.map((state) => `'${state}'`).join(',')})),
          preset_id UUID REFERENCES wb_listing_presets(id) ON DELETE SET NULL,preset_name TEXT,preset_row_version INTEGER,preset_snapshot JSONB,
          media_signature TEXT,expected_vendor_codes JSONB NOT NULL DEFAULT '[]'::jsonb,attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TIMESTAMPTZ,n8n_task_id TEXT,last_error_code TEXT,last_error_message TEXT,last_delivery_at TIMESTAMPTZ,
          worker_id TEXT,lease_until TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await lock.query('CREATE INDEX wb_auto_publish_jobs_due ON wb_auto_publish_jobs(next_attempt_at,state)');
        await lock.query(`CREATE TABLE wb_auto_publish_events(
          id UUID PRIMARY KEY,sku CHAR(7) NOT NULL REFERENCES wb_auto_publish_jobs(sku) ON DELETE CASCADE,event_type TEXT NOT NULL,
          from_state TEXT,to_state TEXT,message TEXT,details JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await lock.query('CREATE INDEX wb_auto_publish_events_sku_time ON wb_auto_publish_events(sku,created_at DESC)');
        await lock.query("CREATE UNIQUE INDEX wb_auto_publish_events_delivery_unique ON wb_auto_publish_events(sku,event_type,(details->>'submissionId')) WHERE event_type='MEDIA_DELIVERED'");
        await lock.query("INSERT INTO wb_schema_migrations(id) VALUES('011_wb_auto_publish_jobs')");
        await lock.query('COMMIT');
      }
      const notificationOutbox = await lock.query("SELECT id FROM wb_schema_migrations WHERE id='013_wb_auto_publish_notification_outbox'");
      if (!notificationOutbox.rows[0]) {
        await lock.query('BEGIN');
        // NULL is intentional for every existing job, including historical
        // failures and successes: deployment must not create notification flood.
        await lock.query("ALTER TABLE wb_auto_publish_jobs ADD COLUMN IF NOT EXISTS notification_action TEXT CHECK(notification_action IN ('EMIT_FAILURE','RESOLVE_FAILURE'))");
        await lock.query("ALTER TABLE wb_auto_publish_jobs ADD COLUMN IF NOT EXISTS notification_payload JSONB NOT NULL DEFAULT '{}'::jsonb");
        await lock.query('ALTER TABLE wb_auto_publish_jobs ADD COLUMN IF NOT EXISTS notification_action_updated_at TIMESTAMPTZ');
        await lock.query('ALTER TABLE wb_auto_publish_jobs ADD COLUMN IF NOT EXISTS notification_action_completed_at TIMESTAMPTZ');
        await lock.query(`CREATE INDEX IF NOT EXISTS wb_auto_publish_notification_pending
          ON wb_auto_publish_jobs(notification_action_updated_at,updated_at) WHERE notification_action IS NOT NULL`);
        await lock.query("INSERT INTO wb_schema_migrations(id) VALUES('013_wb_auto_publish_notification_outbox')");
        await lock.query('COMMIT');
      }
      const immutableBindings = await lock.query("SELECT id FROM wb_schema_migrations WHERE id='014_wb_auto_publish_immutable_bindings'");
      if (!immutableBindings.rows[0]) {
        await lock.query('BEGIN');
        await lock.query('ALTER TABLE wb_auto_publish_jobs ADD COLUMN IF NOT EXISTS preset_binding JSONB');
        await lock.query('ALTER TABLE wb_auto_publish_jobs ADD COLUMN IF NOT EXISTS preset_bound_at TIMESTAMPTZ');
        await lock.query('ALTER TABLE wb_auto_publish_jobs ADD COLUMN IF NOT EXISTS preset_activation_started_at TIMESTAMPTZ');
        await lock.query('ALTER TABLE wb_auto_publish_jobs ADD COLUMN IF NOT EXISTS preset_definition_hash TEXT');
        await lock.query(`CREATE INDEX IF NOT EXISTS wb_auto_publish_jobs_bound_preset
          ON wb_auto_publish_jobs(preset_id,state)`);
        await lock.query("INSERT INTO wb_schema_migrations(id) VALUES('014_wb_auto_publish_immutable_bindings')");
        await lock.query('COMMIT');
      }
      const materialPresetIdentity = await lock.query("SELECT id FROM wb_schema_migrations WHERE id='033_wb_auto_material_preset_identity'");
      if (!materialPresetIdentity.rows[0]) {
        await lock.query('BEGIN');
        await lock.query('ALTER TABLE wb_auto_publish_jobs ADD COLUMN IF NOT EXISTS material_preset_definition_hash TEXT');
        await lock.query('CREATE INDEX IF NOT EXISTS wb_auto_publish_material_preset ON wb_auto_publish_jobs(sku,material_preset_definition_hash) WHERE material_preset_definition_hash IS NOT NULL');
        await lock.query("INSERT INTO wb_schema_migrations(id) VALUES('033_wb_auto_material_preset_identity')");
        await lock.query('COMMIT');
      }
      const compatibleRuns = await lock.query("SELECT id FROM wb_schema_migrations WHERE id='016_wb_auto_publish_compatible_runs'");
      if (!compatibleRuns.rows[0]) {
        await lock.query('BEGIN');
        await lock.query('ALTER TABLE wb_auto_publish_jobs ADD COLUMN IF NOT EXISTS run_id UUID');
        await lock.query('ALTER TABLE wb_auto_publish_jobs ADD COLUMN IF NOT EXISTS run_no INTEGER NOT NULL DEFAULT 1');
        await lock.query("ALTER TABLE wb_auto_publish_jobs ADD COLUMN IF NOT EXISTS operation_mode TEXT NOT NULL DEFAULT 'CREATE_ONLY' CHECK(operation_mode IN ('CREATE_ONLY','COMPATIBLE_UPSERT'))");
        await lock.query("ALTER TABLE wb_auto_publish_jobs ADD COLUMN IF NOT EXISTS trigger_type TEXT NOT NULL DEFAULT 'MEDIA_DELIVERY' CHECK(trigger_type IN ('MEDIA_DELIVERY','MANUAL'))");
        await lock.query('ALTER TABLE wb_auto_publish_jobs ADD COLUMN IF NOT EXISTS base_revision INTEGER NOT NULL DEFAULT 0');
        await lock.query('ALTER TABLE wb_auto_publish_jobs ADD COLUMN IF NOT EXISTS target_revision INTEGER NOT NULL DEFAULT 1');
        await lock.query("ALTER TABLE wb_auto_publish_jobs ADD COLUMN IF NOT EXISTS media_target_variant_ids JSONB NOT NULL DEFAULT '[]'::jsonb");
        await lock.query("ALTER TABLE wb_auto_publish_jobs ADD COLUMN IF NOT EXISTS media_target_vendor_codes JSONB NOT NULL DEFAULT '[]'::jsonb");
        await lock.query("ALTER TABLE wb_auto_publish_jobs ADD COLUMN IF NOT EXISTS warnings JSONB NOT NULL DEFAULT '[]'::jsonb");
        await lock.query("ALTER TABLE wb_auto_publish_jobs ADD COLUMN IF NOT EXISTS variant_summary JSONB NOT NULL DEFAULT '{}'::jsonb");
        await lock.query('UPDATE wb_auto_publish_jobs SET run_id=gen_random_uuid() WHERE run_id IS NULL');
        await lock.query('ALTER TABLE wb_auto_publish_jobs ALTER COLUMN run_id SET NOT NULL');
        await lock.query(`CREATE TABLE IF NOT EXISTS wb_auto_publish_job_runs(
          run_id UUID PRIMARY KEY,sku CHAR(7) NOT NULL,run_no INTEGER NOT NULL,snapshot JSONB NOT NULL,
          archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(sku,run_no))`);
        await lock.query('CREATE INDEX IF NOT EXISTS wb_auto_publish_job_runs_sku ON wb_auto_publish_job_runs(sku,run_no DESC)');
        await lock.query("INSERT INTO wb_schema_migrations(id) VALUES('016_wb_auto_publish_compatible_runs')");
        await lock.query('COMMIT');
      }
      const compatibleRunSummary = await lock.query("SELECT id FROM wb_schema_migrations WHERE id='018_wb_auto_publish_variant_summary'");
      if (!compatibleRunSummary.rows[0]) {
        await lock.query('BEGIN');
        // Keep this as a separate migration as well: development installations may
        // already have recorded migration 016 before variant_summary was added.
        await lock.query("ALTER TABLE wb_auto_publish_jobs ADD COLUMN IF NOT EXISTS variant_summary JSONB NOT NULL DEFAULT '{}'::jsonb");
        await lock.query("INSERT INTO wb_schema_migrations(id) VALUES('018_wb_auto_publish_variant_summary')");
        await lock.query('COMMIT');
      }
      const retryCounters = await lock.query("SELECT id FROM wb_schema_migrations WHERE id='019_wb_auto_publish_retry_counters'");
      if (!retryCounters.rows[0]) {
        await lock.query('BEGIN');
        await lock.query("ALTER TABLE wb_auto_publish_jobs ADD COLUMN IF NOT EXISTS retry_counters JSONB NOT NULL DEFAULT '{}'::jsonb");
        await lock.query("INSERT INTO wb_schema_migrations(id) VALUES('019_wb_auto_publish_retry_counters')");
        await lock.query('COMMIT');
      }
      const networkRecovery = await lock.query("SELECT id FROM wb_schema_migrations WHERE id='027_wb_auto_publish_network_recovery'");
      if (!networkRecovery.rows[0]) {
        await lock.query('BEGIN');
        await lock.query("ALTER TABLE wb_auto_publish_jobs ADD COLUMN IF NOT EXISTS network_recovery JSONB NOT NULL DEFAULT '{}'::jsonb");
        await lock.query('ALTER TABLE wb_auto_publish_jobs DROP CONSTRAINT IF EXISTS wb_auto_publish_jobs_state_check');
        await lock.query(`ALTER TABLE wb_auto_publish_jobs ADD CONSTRAINT wb_auto_publish_jobs_state_check
          CHECK(state IN (${WB_AUTO_PUBLISH_STATES.map((state) => `'${state}'`).join(',')}))`);
        await lock.query("INSERT INTO wb_schema_migrations(id) VALUES('027_wb_auto_publish_network_recovery')");
        await lock.query('COMMIT');
      }
      const listingOperationSource = await lock.query("SELECT id FROM wb_schema_migrations WHERE id='021_wb_listing_operation_source_backfill'");
      if (!listingOperationSource.rows[0]) {
        await lock.query('BEGIN');
        await lock.query("ALTER TABLE wb_listing_drafts ADD COLUMN IF NOT EXISTS latest_operation_source TEXT NOT NULL DEFAULT 'MANUAL'");
        await lock.query('ALTER TABLE wb_listing_drafts ADD COLUMN IF NOT EXISTS latest_operation_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
        await lock.query('ALTER TABLE wb_listing_drafts ADD COLUMN IF NOT EXISTS latest_operation_ref TEXT');
        const versions = await lock.query<{ relation: string | null }>("SELECT to_regclass('wb_listing_versions')::text relation");
        if (versions.rows[0]?.relation) {
          await lock.query(`WITH latest_manual AS (
              SELECT sku,MAX(updated_at) operation_at
              FROM wb_listing_versions
              WHERE COALESCE(automation_context->>'runId','')=''
              GROUP BY sku
            ), ownership AS (
              SELECT j.sku,j.run_id,j.updated_at automation_at,m.operation_at manual_at
              FROM wb_auto_publish_jobs j LEFT JOIN latest_manual m ON m.sku=j.sku
            )
            UPDATE wb_listing_drafts d SET
              latest_operation_source=CASE WHEN o.manual_at>=o.automation_at THEN 'MANUAL' ELSE 'AUTOMATION' END,
              latest_operation_at=CASE WHEN o.manual_at>=o.automation_at THEN o.manual_at ELSE o.automation_at END,
              latest_operation_ref=CASE WHEN o.manual_at>=o.automation_at THEN 'migration:manual-version' ELSE 'automation:'||o.run_id::text END
            FROM ownership o WHERE d.sku=o.sku`);
        } else {
          await lock.query(`UPDATE wb_listing_drafts d SET
            latest_operation_source='AUTOMATION',latest_operation_at=j.updated_at,
            latest_operation_ref='automation:'||j.run_id::text
            FROM wb_auto_publish_jobs j WHERE d.sku=j.sku`);
        }
        await lock.query("INSERT INTO wb_schema_migrations(id) VALUES('021_wb_listing_operation_source_backfill')");
        await lock.query('COMMIT');
      }
      const generationLeases = await lock.query("SELECT id FROM wb_schema_migrations WHERE id='036_wb_auto_generation_leases'");
      if (!generationLeases.rows[0]) {
        await lock.query('BEGIN');
        await lock.query(`CREATE TABLE IF NOT EXISTS wb_auto_generation_leases(
          sku CHAR(7) PRIMARY KEY REFERENCES products(sku) ON DELETE CASCADE,
          owner_job_id UUID NOT NULL,owner_run_id UUID NOT NULL,owner_store_id UUID NOT NULL,
          phase TEXT NOT NULL,source_version_id UUID,lease_until TIMESTAMPTZ NOT NULL,
          row_version INTEGER NOT NULL DEFAULT 1,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        await lock.query('CREATE INDEX IF NOT EXISTS wb_auto_generation_leases_due ON wb_auto_generation_leases(lease_until)');
        await lock.query('ALTER TABLE wb_auto_publish_jobs DROP CONSTRAINT IF EXISTS wb_auto_publish_jobs_state_check');
        await lock.query(`ALTER TABLE wb_auto_publish_jobs ADD CONSTRAINT wb_auto_publish_jobs_state_check
          CHECK(state IN (${WB_AUTO_PUBLISH_STATES.map((state) => `'${state}'`).join(',')}))`);
        await lock.query("INSERT INTO wb_schema_migrations(id) VALUES('036_wb_auto_generation_leases')");
        await lock.query('COMMIT');
      }
      await lock.query('CREATE INDEX IF NOT EXISTS wb_auto_publish_jobs_updated ON wb_auto_publish_jobs(updated_at DESC)');
    } catch (error) { await lock.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { await lock.query("SELECT pg_advisory_unlock(hashtext('pixroute_wb_schema_migrations'))").catch(() => undefined); lock.release(); }
  }

  private query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) { return this.requirePool().query<T>(text, values); }
  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.requirePool().connect();
    try { await client.query('BEGIN'); const result = await operation(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
  private requirePool(): Pool {
    if (!this.pool) throw new AppError('DATABASE_UNAVAILABLE', 'WB 自动上品队列尚未配置 PostgreSQL DATABASE_URL', undefined, 503);
    return this.pool;
  }
}

function toGenerationLeaseClaim(row: SqlRow, acquired: boolean): WbAutoGenerationLeaseClaim {
  return {
    acquired,
    sku: String(row.sku),
    ownerJobId: String(row.owner_job_id),
    ownerRunId: String(row.owner_run_id),
    ownerStoreId: String(row.owner_store_id),
    phase: String(row.phase),
    ...(row.source_version_id ? { sourceVersionId: String(row.source_version_id) } : {}),
    leaseUntil: new Date(row.lease_until).toISOString(),
    rowVersion: Number(row.row_version || 1)
  };
}

async function markListingOperationSource(client: PoolClient, sku: string, occurredAt: string, operationRef: string): Promise<void> {
  await client.query(`UPDATE wb_listing_drafts SET
    latest_operation_source='AUTOMATION',latest_operation_at=$2::timestamptz,latest_operation_ref=$3,
    updated_at=GREATEST(updated_at,$2::timestamptz)
    WHERE sku=$1 AND latest_operation_at<$2::timestamptz`, [sku, occurredAt, operationRef]);
}

function toJob(row: SqlRow, hasListing: boolean): WbAutoPublishJob {
  const state = row.state as WbAutoPublishState;
  const nmIds = normalizeNmIds(row.listing_nm_ids);
  const productUrls = normalizeProductUrls(row.listing_product_urls, nmIds);
  const binding = asJsonRecord(row.preset_binding);
  const presetId = row.preset_id || binding.presetId;
  const presetName = row.preset_name || binding.presetName;
  const presetRowVersion = row.preset_row_version || binding.presetRowVersion;
  return {
    id: String(row.id || row.job_id || row.run_id), storeId: String(row.store_id || WB_DEFAULT_STORE_ID),
    sku: String(row.sku), state, runId: String(row.run_id), runNo: Number(row.run_no || 1),
    operationMode: row.operation_mode === 'COMPATIBLE_UPSERT' ? 'COMPATIBLE_UPSERT' : 'CREATE_ONLY',
    triggerType: row.trigger_type === 'MANUAL' ? 'MANUAL' : 'MEDIA_DELIVERY',
    baseRevision: Number(row.base_revision || 0), targetRevision: Number(row.target_revision || 1),
    mediaTargetVariantIds: Array.isArray(row.media_target_variant_ids) ? row.media_target_variant_ids.map(String) : [],
    mediaTargetVendorCodes: Array.isArray(row.media_target_vendor_codes) ? row.media_target_vendor_codes.map(String) : [],
    warnings: Array.isArray(row.warnings) ? row.warnings.map(asJsonRecord) : [],
    variantSummary: {
      created: Number(asJsonRecord(row.variant_summary).created || 0),
      updated: Number(asJsonRecord(row.variant_summary).updated || 0),
      preserved: Number(asJsonRecord(row.variant_summary).preserved || 0)
    },
    ...(presetId ? { presetId: String(presetId) } : {}), ...(presetName ? { presetName: String(presetName) } : {}),
    ...(presetRowVersion ? { presetRowVersion: Number(presetRowVersion) } : {}), ...(row.preset_snapshot ? { presetSnapshot: row.preset_snapshot } : {}),
    ...(row.preset_binding ? { presetBinding: row.preset_binding } : {}),
    ...(row.preset_bound_at ? { presetBoundAt: new Date(row.preset_bound_at).toISOString() } : {}),
    ...(row.preset_activation_started_at ? { presetActivationStartedAt: new Date(row.preset_activation_started_at).toISOString() } : {}),
    ...(row.preset_definition_hash ? { presetDefinitionHash: String(row.preset_definition_hash) } : {}),
    ...(row.material_preset_definition_hash ? { materialPresetDefinitionHash: String(row.material_preset_definition_hash) } : {}),
    sourcePresetExists: Boolean(row.source_preset_exists),
    ...(row.media_signature ? { mediaSignature: String(row.media_signature) } : {}), expectedVendorCodes: Array.isArray(row.expected_vendor_codes) ? row.expected_vendor_codes.map(String) : [],
    attemptCount: Number(row.attempt_count || 0),
    retryCounters: Object.fromEntries(Object.entries(asJsonRecord(row.retry_counters)).map(([key, value]) => [key, Math.max(0, Number(value) || 0)])),
    ...(Object.keys(asJsonRecord(row.network_recovery)).length ? { networkRecovery: asJsonRecord(row.network_recovery) as WbNetworkRecovery } : {}),
    ...(row.next_attempt_at ? { nextAttemptAt: new Date(row.next_attempt_at).toISOString() } : {}),
    ...(row.n8n_task_id ? { n8nTaskId: String(row.n8n_task_id) } : {}),
    ...(row.publication_id ? { publicationId: String(row.publication_id) } : {}), nmIds, productUrls,
    productLinks: normalizeProductLinks(row.listing_product_link_identities, productUrls),
    ...(row.last_error_code ? { lastErrorCode: String(row.last_error_code) } : {}),
    ...(row.last_error_message ? { lastErrorMessage: String(row.last_error_message) } : {}), ...(row.last_delivery_at ? { lastDeliveryAt: new Date(row.last_delivery_at).toISOString() } : {}),
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    canRecheck: RECHECKABLE.has(state) || (state === 'BLOCKED_EXISTING_CARD' && row.last_error_code === 'WB_CARD_ALREADY_EXISTS' && Boolean(row.n8n_task_id)),
    canCancel: CANCELLABLE.has(state), hasListing
  };
}

async function archiveRun(client: PoolClient, row: SqlRow): Promise<void> {
  const snapshot = { ...row, has_listing: Boolean(row.has_listing) };
  await client.query(`INSERT INTO wb_auto_publish_job_runs(run_id,job_id,store_id,sku,run_no,publication_id,snapshot)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(run_id) DO NOTHING`, [
    row.run_id, row.id, row.store_id || WB_DEFAULT_STORE_ID, row.sku, Number(row.run_no || 1), row.publication_id || null, JSON.stringify(snapshot)
  ]);
}

const LISTING_RESULT_PROJECTION = `
  d.sku IS NOT NULL has_listing,
  EXISTS(SELECT 1 FROM wb_listing_presets source_preset WHERE source_preset.id=j.preset_id) source_preset_exists,
  CASE WHEN j.publication_id IS NOT NULL THEN COALESCE((
    SELECT publication.nm_ids FROM wb_store_publications publication
    WHERE publication.id=j.publication_id AND publication.store_id=j.store_id
  ),'[]'::jsonb) ELSE COALESCE(d.nm_ids,'[]'::jsonb) END listing_nm_ids,
  CASE WHEN j.publication_id IS NOT NULL THEN COALESCE((
    SELECT publication.product_urls FROM wb_store_publications publication
    WHERE publication.id=j.publication_id AND publication.store_id=j.store_id
  ),'[]'::jsonb) ELSE COALESCE(d.product_urls,'[]'::jsonb) END listing_product_urls,
  CASE WHEN j.publication_id IS NOT NULL THEN COALESCE((
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'nmId', card.value->>'nmID',
      'variantCode', card.value->>'variantCode'
    ) ORDER BY card.position),'[]'::jsonb)
    FROM wb_store_publications publication
    CROSS JOIN LATERAL jsonb_array_elements(CASE
      WHEN jsonb_typeof(publication.result_json->'cards')='array' THEN publication.result_json->'cards'
      ELSE '[]'::jsonb
    END) WITH ORDINALITY AS card(value,position)
    WHERE publication.id=j.publication_id AND publication.store_id=j.store_id
      AND jsonb_typeof(card.value)='object'
      AND NULLIF(BTRIM(card.value->>'nmID'),'') IS NOT NULL
  ),'[]'::jsonb) ELSE '[]'::jsonb END listing_product_link_identities`;

function normalizeNmIds(value: unknown): Array<string | number> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    const normalized = typeof item === 'number' && Number.isFinite(item) && item > 0
      ? item
      : typeof item === 'string' && item.trim() ? item.trim() : undefined;
    if (normalized === undefined || seen.has(String(normalized))) return [];
    seen.add(String(normalized));
    return [normalized];
  });
}

function normalizeProductUrls(value: unknown, nmIds: Array<string | number>): string[] {
  const persisted = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(isWbProductUrl)
    : [];
  const used = new Set<number>();
  const output: string[] = [];
  for (const nmId of nmIds) {
    const id = String(nmId).trim();
    if (!/^\d+$/.test(id)) continue;
    const match = persisted.findIndex((url, index) => !used.has(index) && url.includes(`/catalog/${id}/`));
    if (match >= 0) {
      used.add(match);
      output.push(persisted[match]!);
    } else {
      output.push(`https://www.wildberries.ru/catalog/${id}/detail.aspx`);
    }
  }
  persisted.forEach((url, index) => { if (!used.has(index)) output.push(url); });
  return [...new Set(output)];
}

function normalizeProductLinks(value: unknown, productUrls: string[]): WbAutoPublishProductLink[] {
  const variantsByNmId = new Map<string, Set<string>>();
  if (Array.isArray(value)) {
    for (const item of value) {
      const identity = asJsonRecord(item);
      const nmId = String(identity.nmId || '').trim();
      const variantCode = String(identity.variantCode || '').trim();
      if (!/^\d+$/.test(nmId) || !variantCode) continue;
      const variants = variantsByNmId.get(nmId) || new Set<string>();
      variants.add(variantCode);
      variantsByNmId.set(nmId, variants);
    }
  }
  return productUrls.flatMap((url) => {
    const nmId = wbNmIdFromProductUrl(url);
    if (!nmId) return [];
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
    const match = new URL(value).pathname.match(/^\/catalog\/(\d+)(?:\/|$)/);
    return match?.[1];
  }
  catch { return undefined; }
}

function isWbProductUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'wildberries.ru' || url.hostname.endsWith('.wildberries.ru'));
  }
  catch { return false; }
}

function toEvent(row: SqlRow): WbAutoPublishEvent {
  return { id: String(row.id), eventType: String(row.event_type), ...(row.from_state ? { fromState: row.from_state } : {}),
    ...(row.to_state ? { toState: row.to_state } : {}), ...(row.message ? { message: String(row.message) } : {}),
    ...(row.details ? { details: row.details } : {}), createdAt: new Date(row.created_at).toISOString() };
}

export function notificationActionFor(
  toState: WbAutoPublishState,
  input: { eventType?: string; errorCode?: string | null; errorMessage?: string | null; n8nTaskId?: string },
  current: SqlRow
): { action: WbAutoPublishNotificationAction; payload: JsonRecord } | undefined {
  const isFailure = toState === 'BLOCKED_EXISTING_CARD' || toState === 'NEEDS_ATTENTION'
    || (toState === 'PAUSED' && input.errorCode === 'WB_AUTH_FAILED');
  if (isFailure) {
    const failure = {
      jobId: String(current.id),
      storeId: String(current.store_id || WB_DEFAULT_STORE_ID),
      sku: String(current.sku),
      state: toState,
      jobCreatedAt: new Date(current.created_at).toISOString(),
      runId: String(current.run_id),
      runNo: Number(current.run_no || 1),
      operationMode: current.operation_mode === 'COMPATIBLE_UPSERT' ? 'COMPATIBLE_UPSERT' : 'CREATE_ONLY',
      errorCode: String(input.errorCode || current.last_error_code || 'AUTO_PUBLISH_FAILED'),
      errorMessage: String(input.errorMessage || current.last_error_message || '自动上品任务执行失败'),
      ...(current.preset_name ? { presetName: String(current.preset_name) } : {}),
      ...(input.n8nTaskId || current.n8n_task_id ? { taskId: String(input.n8nTaskId || current.n8n_task_id) } : {})
    };
    return {
      action: 'EMIT_FAILURE',
      payload: { failure }
    };
  }
  const submittedFailure = toState === 'FAILED'
    && (input.eventType === 'LISTING_STATUS_SYNCED' || input.eventType === 'RESUMED_FROM_LISTING');
  const waitingNetworkResolvesExistingFailure = toState === 'WAITING_NETWORK'
    && Object.keys(asJsonRecord(asJsonRecord(current.notification_payload).failure)).length > 0;
  if (toState === 'QUEUED' || toState === 'RUNNING' || toState === 'SUCCEEDED' || toState === 'CANCELLED'
    || waitingNetworkResolvesExistingFailure || submittedFailure) {
    const existing = asJsonRecord(current.notification_payload);
    const existingFailure = asJsonRecord(existing.failure);
    return {
      action: 'RESOLVE_FAILURE',
      payload: {
        ...existing,
        resolution: {
          ...(existingFailure.jobId ? { jobId: String(existingFailure.jobId) } : {}),
          ...(existingFailure.storeId ? { storeId: String(existingFailure.storeId) } : {}),
          ...(existingFailure.runId ? { runId: String(existingFailure.runId) } : {}),
          sku: String(current.sku),
          state: toState,
          jobCreatedAt: new Date(current.created_at).toISOString()
        }
      }
    };
  }
  return undefined;
}

const WB_HISTORICAL_TRANSPORT_CODES = new Set([
  'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'ECONNREFUSED',
  'ENOTFOUND', 'EAI_AGAIN', 'TLS_EOF', 'HTTP_408', 'HTTP_429'
]);

function historicalTransportEvidence(row: SqlRow): { errorCode: string; errorMessage: string; httpStatus?: number } | undefined {
  const errorCode = String(row.last_error_code || '').trim().toUpperCase();
  const errorMessage = String(row.last_error_message || '').trim();
  const codeStatusMatch = errorCode.match(/(?:^|_)HTTP_(408|429|5\d{2})$/);
  const httpStatus = codeStatusMatch ? Number(codeStatusMatch[1]) : undefined;
  const messageIsTransport = /ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNABORTED|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|SOCKET\s+HANG\s+UP|TLS.*EOF|(?:HTTP|STATUS)[^0-9]*(?:408|429|5\d{2})|断网|网络(?:中断|不可用|连接失败|超时)/i.test(errorMessage);
  if (!WB_HISTORICAL_TRANSPORT_CODES.has(errorCode) && !/(?:^|_)HTTP_5\d{2}$/.test(errorCode) && !messageIsTransport) return undefined;
  return {
    errorCode: errorCode || (httpStatus ? `HTTP_${httpStatus}` : 'NETWORK_TRANSPORT'),
    errorMessage,
    ...(httpStatus ? { httpStatus } : {})
  };
}

const WB_HISTORICAL_NETWORK_DELAYS_MS = [30_000, 60_000, 300_000, 900_000] as const;

function historicalAutoProposedRecovery(
  row: SqlRow,
  transport: { errorCode: string; errorMessage: string; httpStatus?: number }
): WbNetworkRecovery {
  const parsedPrevious = wbNetworkRecoverySchema.safeParse(asJsonRecord(row.network_recovery));
  const previous = parsedPrevious.success ? parsedPrevious.data : undefined;
  const attempt = Math.max(1, Math.trunc(Number(previous?.attempt || row.attempt_count || 1)));
  const failureAt = validIso(row.updated_at) || '1970-01-01T00:00:00.000Z';
  const baseDelayMs = WB_HISTORICAL_NETWORK_DELAYS_MS[Math.min(attempt - 1, WB_HISTORICAL_NETWORK_DELAYS_MS.length - 1)]!;
  const failureAtMs = Date.parse(failureAt);
  const previousNextAttemptAtMs = Date.parse(previous?.nextAttemptAt || '');
  const retryAfterMs = previous?.retryAfterMs;
  const nextAttemptAt = new Date(Math.max(
    failureAtMs + baseDelayMs,
    Number.isFinite(previousNextAttemptAtMs) ? previousNextAttemptAtMs : 0,
    failureAtMs + (retryAfterMs ?? 0)
  )).toISOString();
  const taskId = row.n8n_task_id ? String(row.n8n_task_id) : '';
  return {
    phase: taskId ? 'SUBMIT_READBACK' : 'CHECKING',
    resumeState: taskId ? 'SUBMITTING' : 'CHECKING',
    deliveryState: historicalAutoDeliveryState(transport),
    attempt,
    firstFailureAt: validIso(previous?.firstFailureAt) || failureAt,
    lastFailureAt: validIso(previous?.lastFailureAt) || failureAt,
    nextAttemptAt,
    lastErrorCode: transport.errorCode,
    lastErrorMessage: transport.errorMessage,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    checkpoint: taskId ? `taskId:${taskId}` : `runId:${String(row.run_id || '')}`,
    ...(previous?.readableAmbiguityElapsedMs !== undefined
      ? { readableAmbiguityElapsedMs: previous.readableAmbiguityElapsedMs }
      : {}),
    ...(previous?.readableAmbiguityLastObservedAt
      ? { readableAmbiguityLastObservedAt: previous.readableAmbiguityLastObservedAt }
      : {})
  };
}

function historicalAutoDeliveryState(
  transport: { errorCode: string; httpStatus?: number }
): WbNetworkRecovery['deliveryState'] {
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(transport.errorCode)) return 'NOT_SENT';
  if (transport.httpStatus === 429 || transport.errorCode.endsWith('HTTP_429')) return 'RESPONDED';
  return 'UNKNOWN';
}

function validIso(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

async function runtimeRecoveryGuard(
  client: PoolClient,
  taskId: string
): Promise<{ activeLease: boolean; state?: string; rowVersion?: number }> {
  const table = await client.query<{ available: boolean }>("SELECT to_regclass('wb_publish_jobs') IS NOT NULL available");
  if (!table.rows[0]?.available) return { activeLease: false };
  const result = await client.query<{ active: boolean; state: string; row_version: number }>(`SELECT
      (BTRIM(lease_owner)<>'' AND lease_expires_at>NOW()) active,state,row_version
    FROM wb_publish_jobs WHERE task_id=$1 FOR UPDATE`, [taskId]);
  const row = result.rows[0];
  return {
    activeLease: Boolean(row?.active),
    ...(row?.state ? { state: String(row.state).toUpperCase() } : {}),
    ...(row?.row_version ? { rowVersion: Number(row.row_version) } : {})
  };
}

function asJsonRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
