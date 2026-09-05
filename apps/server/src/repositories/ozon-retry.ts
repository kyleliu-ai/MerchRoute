import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResult } from 'pg';
import { AppError, type OzonPublishRetryPlan, type OzonPublishRetryRecord, type OzonPublishRetryRequest } from '@n8n-media-review/shared';
import { ozonPreparationGatewayBoundaryLockKey } from '../ozon-preparation-gateway-boundary.js';

export type RetryRow = Record<string, any>;
type Database = {
  query(sql: string, values?: unknown[]): Promise<QueryResult<RetryRow>>;
  transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T>;
};
export type OzonRetrySnapshot = {
  job: RetryRow; publication?: RetryRow; store: RetryRow; preset?: RetryRow;
  version?: RetryRow; listing?: RetryRow; settings: RetryRow; gateways: RetryRow[]; credentials: RetryRow[];
};
export const retryObject = (value: any): RetryRow => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
export const retryHash = (value: unknown): string => {
  const stable = (v: any): string => v instanceof Date ? JSON.stringify(v.toISOString()) : Array.isArray(v) ? '[' + v.map(stable).join(',') + ']'
    : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v ?? null);
  return 'sha256:' + createHash('sha256').update(stable(value)).digest('hex');
};
export function retryCredentialReady(s: OzonRetrySnapshot, id: string): boolean {
  return s.credentials.some(c => c.id === id && c.store_id === s.store.id && ['ACTIVE', 'RETIRED'].includes(c.status)
    && new Date(c.validated_at).getTime() > Date.now() - 86_400_000);
}
/** Match the existing runtime claim contract before promising that a job can resume. */
export function retryRuntimeContractReady(s: OzonRetrySnapshot): boolean {
  const j = s.job, p = s.publication, payload = retryObject(j.payload);
  return Boolean(p && j.task_kind === 'STORE_PUBLICATION' && j.credential_binding_mode === 'VAULT'
    && j.credential_version_id === p.credential_version_id && j.task_id === p.task_id
    && j.store_config_version === p.store_config_version && j.materialization_hash === p.materialization_hash
    && j.offer_contract_hash === p.offer_contract_hash
    && payload.contentPolicyVersion === p.content_policy_version && payload.materialHash === p.material_hash
    && /^sha256:[0-9a-f]{64}$/.test(payload.materialHash || '')
    && payload.materialHashVersion === 'ozon-shared-material-v1' && p.material_hash_version === payload.materialHashVersion
    && /^sha256:[0-9a-f]{64}$/.test(payload.planHash || '') && payload.planHash === p.plan_hash
    && Number.isInteger(Number(p.preset_row_version)) && Number(p.preset_row_version) > 0
    && String(payload.presetRowVersion) === String(p.preset_row_version)
    && ['CREATE_ONLY', 'COMPATIBLE_UPSERT'].includes(payload.publicationMode) && payload.publicationMode === p.publication_mode);
}
const conflict = (message: string): never => { throw new AppError('VERSION_CONFLICT', message, undefined, 409); };
export const ozonRetryRecord = (r: RetryRow): OzonPublishRetryRecord => ({
  id: r.id, requestId: r.request_id, sourceJobId: r.source_job_id,
  ...(r.effective_job_id ? { effectiveJobId: r.effective_job_id } : {}),
  storeId: r.store_id, sku: r.sku, status: r.status, mode: r.mode, stage: r.stage,
  message: r.message, previousError: r.previous_error, errorCode: r.error_code,
  createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString()
});

export async function migrateOzonRetry(client: PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS ozon_publish_retries(
    id UUID PRIMARY KEY,request_id UUID NOT NULL UNIQUE,source_job_id UUID NOT NULL REFERENCES ozon_publish_jobs(id),
    root_job_id UUID,store_id UUID NOT NULL REFERENCES ozon_stores(id),sku TEXT NOT NULL,
    effective_job_id UUID REFERENCES ozon_publish_jobs(id),plan_hash TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('RESUME','READBACK','REBUILD')),
    status TEXT NOT NULL CHECK(status IN ('CHECKING','RUNNING','SUCCEEDED','FAILED','BLOCKED')),
    stage TEXT NOT NULL DEFAULT 'CHECKING',message TEXT NOT NULL DEFAULT '正在检查重试条件',
    previous_error TEXT NOT NULL DEFAULT '',error_code TEXT NOT NULL DEFAULT '',
    snapshot JSONB NOT NULL,checkpoint JSONB NOT NULL DEFAULT '{}',
    lease_token UUID,lease_until TIMESTAMPTZ,next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE UNIQUE INDEX IF NOT EXISTS ozon_publish_retries_active ON ozon_publish_retries(store_id,sku)
      WHERE status IN ('CHECKING','RUNNING');
    CREATE INDEX IF NOT EXISTS ozon_publish_retries_due ON ozon_publish_retries(next_check_at)
      WHERE status IN ('CHECKING','RUNNING');
    INSERT INTO ozon_schema_migrations(id) VALUES('041_ozon_publish_retry') ON CONFLICT DO NOTHING;`);
}

export function ozonRetryToken(s: OzonRetrySnapshot): string {
  return retryHash([s.job, s.publication, s.store, s.preset, s.version, s.listing, s.settings, s.credentials,
    s.gateways.map(g => [g.request_ref, g.operation, g.delivery_state, g.retry_class, g.updated_at])]);
}

export class OzonRetryRepository {
  constructor(private readonly db: Database) {}

  async snapshot(jobId: string, storeId: string, client?: PoolClient): Promise<OzonRetrySnapshot> {
    const db: Pick<Database, 'query'> = client || this.db;
    let job = (await db.query('SELECT * FROM ozon_publish_jobs WHERE id=$1', [jobId])).rows[0];
    if (!job || job.source !== 'AUTO') throw new AppError('NOT_FOUND', 'OZON 自动上品任务不存在', undefined, 404);
    const publication = job.publication_id ? (await db.query(`SELECT * FROM ozon_store_publications WHERE id=$1${client ? ' FOR UPDATE' : ''}`, [job.publication_id])).rows[0] : undefined;
    if (client) {
      // Match publication materialization/cancellation lock order: publication then job.
      const locked = (await db.query('SELECT * FROM ozon_publish_jobs WHERE id=$1 FOR UPDATE', [jobId])).rows[0];
      if (!locked || locked.publication_id !== job.publication_id) return conflict('任务发布身份已变化');
      job = locked;
    }
    if (job.task_kind === 'SHARED_PREPARATION') {
      const payload = retryObject(job.payload);
      const storeIds = [...(payload.fanoutPlan?.items || []).map((item: RetryRow) => item.storeId),
        ...(payload.prePlanRecovery?.targetStores || []).map((item: RetryRow) => item.id)];
      const children = (await db.query('SELECT * FROM ozon_store_publications WHERE preparation_job_id=$1 AND store_id=$2', [jobId, storeId])).rows;
      if (!storeIds.includes(storeId) && !children.length) throw new AppError('CONFIG_INVALID', '该店铺不属于原共享准备任务', undefined, 409);
      if (children.length) return this.snapshot(children[0]!.planned_job_id, storeId, client);
    } else if (job.store_id !== storeId || publication?.store_id !== storeId || publication?.planned_job_id !== job.id) {
      throw new AppError('CONFIG_INVALID', '任务与当前店铺发布身份不一致', undefined, 409);
    }
    const store = (await db.query('SELECT * FROM ozon_stores WHERE id=$1', [storeId])).rows[0];
    if (!store) throw new AppError('NOT_FOUND', 'OZON 店铺不存在', undefined, 404);
    const preset = store.default_preset_id ? (await db.query('SELECT * FROM ozon_listing_presets WHERE id=$1', [store.default_preset_id])).rows[0] : undefined;
    const versionId = publication?.generated_version_id || retryObject(job.payload).generatedVersionId;
    const version = versionId ? (await db.query('SELECT * FROM ozon_listing_versions WHERE id=$1', [versionId])).rows[0] : undefined;
    const listing = (await db.query('SELECT * FROM ozon_listing_drafts WHERE sku=$1', [job.sku])).rows[0];
    const settings = (await db.query("SELECT enabled,root_directory,row_version FROM ozon_system_settings WHERE id='default'")).rows[0] || {};
    const gateways = publication ? (await db.query('SELECT request_ref,operation,delivery_state,retry_class,updated_at FROM ozon_gateway_requests WHERE publication_id=$1 ORDER BY request_ref', [publication.id])).rows : [];
    // Never put encrypted credentials or authorization headers in retry snapshots.
    const credentials = (await db.query(`SELECT id,store_id,status,validated_at FROM ozon_store_credential_versions
      WHERE store_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`, [storeId, [publication?.credential_version_id, store.active_credential_version_id].filter(Boolean)])).rows;
    return { job, publication, store, preset, version, listing, settings, gateways, credentials };
  }

  async latest(jobId: string, storeId: string): Promise<RetryRow | undefined> {
    return (await this.db.query(`SELECT * FROM ozon_publish_retries
      WHERE store_id=$2 AND (source_job_id=$1 OR effective_job_id=$1 OR root_job_id=$1)
      ORDER BY created_at DESC,id DESC LIMIT 1`, [jobId, storeId])).rows[0];
  }

  async accept(jobId: string, input: OzonPublishRetryRequest, plan: OzonPublishRetryPlan): Promise<RetryRow> {
    return this.db.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('merchroute-ozon-multistore-claim'))");
      const previous = (await client.query('SELECT * FROM ozon_publish_retries WHERE request_id=$1', [input.requestId])).rows[0];
      if (previous) {
        if (previous.source_job_id !== plan.sourceJobId || previous.store_id !== input.storeId || previous.plan_hash !== input.planHash) conflict('重试请求 ID 已绑定其他计划');
        return previous;
      }
      let s = await this.snapshot(jobId, input.storeId);
      const rootId = s.publication?.preparation_job_id || (s.job.task_kind === 'SHARED_PREPARATION' ? s.job.id : null);
      if (rootId) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ozonPreparationGatewayBoundaryLockKey(rootId)]);
      s = await this.snapshot(jobId, input.storeId, client);
      if (ozonRetryToken(s) !== input.planHash) conflict('任务或配置已变化，请重新打开重试计划');
      if (!plan.canRetry || (plan.requiresConfirmation && !input.confirmRebuild)) conflict('重试条件未通过或缺少重建确认');
      const active = (await client.query(`SELECT id FROM ozon_publish_retries WHERE store_id=$1 AND sku=$2 AND status IN ('CHECKING','RUNNING')`, [input.storeId, s.job.sku])).rows[0];
      if (active) throw new AppError('TASK_LOCKED', '同店铺已有重试正在执行', undefined, 409);
      const leased = (await client.query(`SELECT id FROM ozon_publish_jobs WHERE store_id=$1 AND lease_expires_at>NOW()`, [input.storeId])).rows[0];
      if (leased || retryObject(s.job.payload).recoveryHold?.active) throw new AppError('TASK_LOCKED', '店铺任务存在活动租约或恢复操作', undefined, 409);
      const id = randomUUID();
      const inserted = (await client.query(`INSERT INTO ozon_publish_retries(id,request_id,source_job_id,root_job_id,store_id,sku,
        plan_hash,mode,status,snapshot,previous_error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'CHECKING',$9::jsonb,$10) RETURNING *`,
      [id, input.requestId, s.job.id, rootId, input.storeId, s.job.sku, input.planHash, plan.mode, JSON.stringify(s), plan.previousError])).rows[0]!;
      await client.query(`UPDATE ozon_publish_jobs SET state=CASE WHEN state='WAITING_MEDIA' THEN 'NEEDS_ATTENTION' ELSE state END,
        payload=payload || jsonb_build_object('recoveryHold',
        jsonb_build_object('active',true,'kind','OZON_PUBLISH_RETRY','retryId',$2::text)),row_version=row_version+1,updated_at=NOW() WHERE id=$1`, [s.job.id, id]);
      await this.event(client, inserted, 'OZON_RETRY_REQUESTED', '已受理单店重试，尚未完成上品');
      return inserted;
    });
  }

  async byRequest(requestId: string): Promise<RetryRow | undefined> {
    return (await this.db.query('SELECT * FROM ozon_publish_retries WHERE request_id=$1', [requestId])).rows[0];
  }

  async claim(): Promise<RetryRow | undefined> {
    return this.db.transaction(async client => {
      const selected = (await client.query(`SELECT id FROM ozon_publish_retries WHERE status IN ('CHECKING','RUNNING')
        AND next_check_at<=NOW() AND (lease_until IS NULL OR lease_until<=NOW()) ORDER BY next_check_at,id
        FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
      if (!selected) return undefined;
      return (await client.query(`UPDATE ozon_publish_retries SET lease_token=$2,lease_until=NOW()+INTERVAL '5 minutes'
        WHERE id=$1 RETURNING *`, [selected.id, randomUUID()])).rows[0];
    });
  }

  async checkpoint(r: RetryRow, checkpoint: RetryRow, stage: string, message: string): Promise<void> {
    const changed = await this.db.query(`UPDATE ozon_publish_retries SET checkpoint=checkpoint || $3::jsonb,
      stage=$4,message=$5,lease_until=NOW()+INTERVAL '5 minutes',updated_at=NOW()
      WHERE id=$1 AND lease_token=$2 AND lease_until>NOW()`, [r.id, r.lease_token, JSON.stringify(checkpoint), stage, message]);
    if (!changed.rowCount) conflict('重试检查租约已失效');
    Object.assign(r.checkpoint, checkpoint);
  }

  async reserveVersion(r: RetryRow): Promise<{ draftVersion: number; versionId: string }> {
    return this.db.transaction(async client => {
      await this.lockClaim(client, r);
      if (r.mode !== 'REBUILD') conflict('只有已确认的重建操作可以预留新版本');
      if (r.checkpoint.versionId) return { draftVersion: r.checkpoint.draftVersion, versionId: r.checkpoint.versionId };
      const original = r.snapshot as OzonRetrySnapshot;
      const listing = (await client.query('SELECT * FROM ozon_listing_drafts WHERE sku=$1 FOR UPDATE', [r.sku])).rows[0];
      if (!listing || listing.management_source !== 'AUTO' || !original.version
        || retryHash(listing.data) !== retryHash(original.listing?.data)
        || retryHash(listing.data) !== retryHash(original.version.snapshot?.data)) conflict('公共素材已变化，请通过新版本发布处理');
      const revision = Math.max(Number(listing.revision), Number((await client.query('SELECT MAX(revision) AS revision FROM ozon_listing_versions WHERE sku=$1', [r.sku])).rows[0]?.revision || 0)) + 1;
      const versionId = randomUUID();
      const snapshot = { ...original.version!.snapshot, revision, rowVersion: Number(listing.row_version) + 1 };
      await client.query(`INSERT INTO ozon_listing_versions(id,sku,revision,snapshot,content_policy_version,material_hash,
        material_hash_version,source_media_identity_hash,base_preset_id,material_overrides)
        SELECT $2,sku,$3,$4::jsonb,content_policy_version,material_hash,material_hash_version,source_media_identity_hash,
          base_preset_id,material_overrides FROM ozon_listing_versions WHERE id=$1`,
      [original.version!.id, versionId, revision, JSON.stringify(snapshot)]);
      await client.query('UPDATE ozon_listing_drafts SET revision=$2,row_version=row_version+1,updated_at=NOW() WHERE sku=$1', [r.sku, revision]);
      const checkpoint = { versionId, draftVersion: Number(listing.row_version) + 1 };
      await client.query('UPDATE ozon_publish_retries SET checkpoint=checkpoint || $2::jsonb WHERE id=$1', [r.id, JSON.stringify(checkpoint)]);
      Object.assign(r.checkpoint, checkpoint);
      return checkpoint;
    });
  }

  async releaseToRuntime(r: RetryRow, jobId: string, state?: string, payloadPatch: RetryRow = {}): Promise<void> {
    await this.db.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('merchroute-ozon-multistore-claim'))");
      await this.lockClaim(client, r);
      const current = await this.snapshot(jobId, r.store_id, client);
      const job = current.job;
      if (!job || job.store_id !== r.store_id || job.sku !== r.sku || job.lease_expires_at && new Date(job.lease_expires_at).getTime()>Date.now()) conflict('重试任务身份或运行租约已变化');
      if (job.source !== 'AUTO' || !['NEEDS_ATTENTION','FAILED','READY'].includes(job.state)) conflict('任务已停止、取消或由其他执行器接管');
      if (retryObject(job.payload).recoveryHold?.retryId !== r.id || retryObject(job.payload).replanReplacement) conflict('任务重试保护已变化');
      const currentStore = (await client.query('SELECT config_version FROM ozon_stores WHERE id=$1 FOR SHARE', [r.store_id])).rows[0];
      if (Number(currentStore?.config_version) !== Number(job.store_config_version)) conflict('店铺配置已变化，原冻结任务不能写入平台');
      if (!retryCredentialReady(current, job.credential_version_id) || !retryRuntimeContractReady(current)) conflict('原冻结凭据已过期或执行合同不完整，任务不能进入调度');
      const competing = (await client.query(`SELECT id FROM ozon_publish_jobs WHERE store_id=$1 AND sku=$2 AND id<>$3
        AND state NOT IN ('NEEDS_ATTENTION','FAILED','CANCELLED','SUCCEEDED') LIMIT 1`, [r.store_id, r.sku, jobId])).rows[0];
      if (competing) conflict('同店铺同 SKU 已有其他活动任务，请先核对');
      if (!current.settings.enabled || !current.store.enabled || current.store.archived_at
        || current.store.preflight_status !== 'PASSED' || !(new Date(current.store.preflight_expires_at).getTime() > Date.now())
        || retryHash(current.settings) !== retryHash(r.snapshot.settings)
        || retryHash(current.preset) !== retryHash(r.snapshot.preset)) conflict('系统、店铺预检或预设已变化，请重新确认重试');
      if (jobId === r.source_job_id) {
        for (const key of ['task_id','offer_ids','import_task_id','ozon_product_id','credential_version_id','store_config_version','offer_contract_hash','materialization_hash']) {
          if (retryHash(job[key]) !== retryHash(r.snapshot.job[key])) conflict('原任务冻结身份或平台检查点已变化');
        }
        for (const key of ['importIntent','priceStockWriteProgress','imageRecovery']) {
          if (retryHash(job.payload?.[key]) !== retryHash(r.snapshot.job.payload?.[key])) conflict('原任务平台恢复检查点已变化');
        }
        for (const key of ['generated_version_id','materialized_product_snapshot','plan_hash','offer_contract_hash','materialization_hash','credential_version_id']) {
          if (retryHash(current.publication?.[key]) !== retryHash(r.snapshot.publication?.[key])) conflict('原发布快照或冻结合同已变化');
        }
        if (retryHash(current.gateways) !== retryHash(r.snapshot.gateways)) conflict('重试期间出现新的平台证据，请重新核对');
      }
      if (state) {
        await client.query(`UPDATE ozon_publish_jobs SET state=$2,payload=(payload-'recoveryHold') || $3::jsonb,
          next_attempt_at=NOW(),finished_at=NULL,last_error_code=NULL,last_error_message=NULL,
          retry_count=retry_count+1,row_version=row_version+1,updated_at=NOW() WHERE id=$1`, [jobId, state, JSON.stringify(payloadPatch)]);
        await client.query("UPDATE ozon_store_publications SET status='QUEUED',error_code='',error_message='',completed_at=NULL,row_version=row_version+1,updated_at=NOW() WHERE id=$1", [job.publication_id]);
      } else await client.query("UPDATE ozon_publish_jobs SET payload=payload-'recoveryHold',row_version=row_version+1,updated_at=NOW() WHERE id=$1 AND payload#>>'{recoveryHold,retryId}'=$2", [jobId, r.id]);
      if (jobId !== r.source_job_id) {
        const source = await this.snapshot(r.source_job_id, r.store_id, client);
        if (!['NEEDS_ATTENTION','FAILED'].includes(source.job.state) || source.job.payload?.recoveryHold?.retryId !== r.id
          || source.job.import_task_id || source.job.ozon_product_id || retryHash(source.gateways) !== retryHash(r.snapshot.gateways)) conflict('原失败任务已变化或出现平台证据，不能释放接续任务');
        const marker = { retryId: r.id, replacementJobId: jobId, replacementPublicationId: job.publication_id, storeId: r.store_id };
        await client.query(`UPDATE ozon_publish_jobs SET payload=(payload-'recoveryHold') || jsonb_build_object('replanReplacement',$2::jsonb),
          row_version=row_version+1,updated_at=NOW() WHERE id=$1 AND task_kind<>'SHARED_PREPARATION'`, [r.source_job_id, JSON.stringify(marker)]);
        const oldPublication = r.snapshot.publication?.id;
        if (oldPublication) await client.query(`UPDATE ozon_store_publications SET result_json=result_json || jsonb_build_object('replanReplacement',$2::jsonb),row_version=row_version+1,updated_at=NOW() WHERE id=$1`, [oldPublication, JSON.stringify(marker)]);
        if (r.root_job_id) await client.query(`UPDATE ozon_publish_jobs SET payload=jsonb_set(
          CASE WHEN payload#>>'{recoveryHold,retryId}'=$4 THEN payload-'recoveryHold' ELSE payload END,
          '{retryReplacements}',COALESCE(payload->'retryReplacements','{}'::jsonb) || jsonb_build_object($2::text,$3::jsonb)),
          row_version=row_version+1,updated_at=NOW() WHERE id=$1`, [r.root_job_id, r.store_id, JSON.stringify(marker), r.id]);
      }
      await client.query(`UPDATE ozon_publish_retries SET effective_job_id=$2,status='RUNNING',stage=$3,
        message='重试已进入调度，等待执行与平台核验',lease_token=NULL,lease_until=NULL,
        next_check_at=NOW()+INTERVAL '5 seconds',updated_at=NOW() WHERE id=$1`, [r.id, jobId, state || job.state]);
      await this.event(client, r, 'OZON_RETRY_ENQUEUED', '已从失败步骤继续执行，尚未完成上品');
    });
  }

  async settle(r: RetryRow, status: 'BLOCKED' | 'FAILED' | 'SUCCEEDED', message: string, code = ''): Promise<void> {
    await this.db.transaction(async client => {
      await this.lockClaim(client, r);
      await client.query(`UPDATE ozon_publish_retries SET status=$3,message=$4,error_code=$5,lease_token=NULL,
        lease_until=NULL,updated_at=NOW() WHERE id=$1 AND lease_token=$2`, [r.id, r.lease_token, status, message, code]);
      const stopped = await client.query(`UPDATE ozon_publish_jobs SET payload=payload-'recoveryHold',
        state=CASE WHEN state IN ('READY','WAITING_MEDIA') THEN 'NEEDS_ATTENTION' ELSE state END,
        row_version=row_version+1,updated_at=NOW() WHERE payload#>>'{recoveryHold,retryId}'=$1 RETURNING publication_id`, [r.id]);
      for (const job of stopped.rows) if (job.publication_id) await client.query(`UPDATE ozon_store_publications
        SET status='NEEDS_ATTENTION',error_code=$2,error_message=$3,row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 AND status IN ('QUEUED','MATERIALIZED','PLANNED')`, [job.publication_id, code, message]);
      await this.event(client, r, 'OZON_RETRY_' + status, message);
    });
  }

  async defer(r: RetryRow, stage: string, message: string): Promise<void> {
    await this.db.query(`UPDATE ozon_publish_retries SET stage=$3,message=$4,lease_token=NULL,lease_until=NULL,
      next_check_at=NOW()+INTERVAL '10 seconds',updated_at=NOW() WHERE id=$1 AND lease_token=$2`, [r.id, r.lease_token, stage, message]);
  }

  async effectiveJob(r: RetryRow): Promise<RetryRow | undefined> {
    return (await this.db.query('SELECT * FROM ozon_publish_jobs WHERE id=$1', [r.effective_job_id])).rows[0];
  }

  async assertChecking(id: string, leaseToken: string, storeId: string, sku: string, client?: PoolClient): Promise<void> {
    const db: Pick<Database, 'query'> = client || this.db;
    const row = (await db.query(`SELECT id FROM ozon_publish_retries
      WHERE id=$1 AND lease_token=$2 AND lease_until>NOW() AND status='CHECKING' AND store_id=$3 AND sku=$4`,
    [id, leaseToken, storeId, sku])).rows[0];
    if (!row) conflict('单店重试身份或执行租约已失效');
  }

  async assertLegacyRecoveryAllowed(jobId: string): Promise<void> {
    const row = (await this.db.query(`SELECT id FROM ozon_publish_retries WHERE
      (source_job_id=$1 OR root_job_id=$1 OR effective_job_id=$1)
      AND (status IN ('CHECKING','RUNNING') OR effective_job_id IS NOT NULL) LIMIT 1`, [jobId])).rows[0];
    if (row) conflict('任务已使用单店重试，请打开接续任务，不可再恢复原整批计划');
  }

  private async lockClaim(client: PoolClient, r: RetryRow): Promise<void> {
    const row = (await client.query('SELECT id FROM ozon_publish_retries WHERE id=$1 AND lease_token=$2 AND lease_until>NOW() FOR UPDATE', [r.id, r.lease_token])).rows[0];
    if (!row) conflict('重试执行租约已失效');
  }

  private async event(client: PoolClient, r: RetryRow, type: string, message: string): Promise<void> {
    await client.query(`INSERT INTO ozon_publish_events(id,job_id,event_type,message,payload,store_id,publication_id)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`, [randomUUID(), r.source_job_id, type, message,
      JSON.stringify({ retryId: r.id, storeId: r.store_id, previousError: r.previous_error }), r.store_id, r.snapshot.publication?.id || null]);
  }
}
