import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { AppError, WB_RETRY_STAGE_LABELS, type WbPublishRetryRecord, type WbPublishRetryRequest } from '@n8n-media-review/shared';

type Row = Record<string, any>;
type Database = {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
  transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T>;
  syncPublication(client: PoolClient, row: Row): Promise<void>;
};
export type WbRetrySnapshot = { auto: Row; runtime?: Row; publication?: Row };
export type WbRetryClaim = Row & { id: string; lease_token: string; store_id: string; sku: string; run_id: string };
export const ACTIVE_RETRY = ['CHECKING', 'RUNNING'];
const eligible = new Set(['WAITING_MEDIA', 'WAITING_STABLE', 'NEEDS_ATTENTION', 'PAUSED', 'FAILED', 'BLOCKED_EXISTING_CARD']);

export function retryStateToken(snapshot: WbRetrySnapshot): string {
  const { auto: a, runtime: r, publication: p } = snapshot;
  return createHash('sha256').update(JSON.stringify([
    a.id, a.store_id, a.sku, a.run_id, a.state, a.n8n_task_id || null, a.publication_id || null,
    a.preset_binding, a.updated_at, r?.row_version, r?.payload_signature,
    p?.generated_version_id, p?.status, p?.task_id
  ])).digest('hex');
}

export function retryRecord(row: Row): WbPublishRetryRecord {
  return {
    id: row.id, requestId: row.request_id, retryNo: Number(row.retry_no), status: row.status, stage: row.stage,
    message: row.message, errorCode: row.error_code,
    previousErrorCode: row.previous_error_code, previousErrorMessage: row.previous_error_message,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    ...(row.finished_at ? { finishedAt: new Date(row.finished_at).toISOString() } : {})
  };
}

export async function migrateWbAutoRetry(client: PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS wb_manual_retry_protocol(
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),enabled BOOLEAN NOT NULL DEFAULT false,
    contract_version INTEGER NOT NULL DEFAULT 1,workflow_version_id TEXT NOT NULL DEFAULT '',
    verified_at TIMESTAMPTZ);
    INSERT INTO wb_manual_retry_protocol(singleton) VALUES(true) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS wb_auto_publish_retries(
      id UUID PRIMARY KEY,request_id UUID NOT NULL UNIQUE,job_id UUID NOT NULL,retry_no INTEGER NOT NULL,
      store_id UUID NOT NULL,sku TEXT NOT NULL,run_id UUID NOT NULL,
      task_id TEXT,publication_id UUID,expected_token TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('CHECKING','RUNNING','SUCCEEDED','FAILED','BLOCKED')),
      stage TEXT NOT NULL DEFAULT 'CHECKING',message TEXT NOT NULL DEFAULT '正在检查重试条件',
      previous_error_code TEXT NOT NULL DEFAULT '',previous_error_message TEXT NOT NULL DEFAULT '',
      error_code TEXT NOT NULL DEFAULT '',snapshot JSONB NOT NULL,evidence JSONB NOT NULL DEFAULT '{}',
      authorized_attempt INTEGER,request_ref TEXT,request_hash TEXT,consumed_at TIMESTAMPTZ,
      runtime_version INTEGER,lease_token TEXT,lease_until TIMESTAMPTZ,
      next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),row_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),finished_at TIMESTAMPTZ);
    CREATE UNIQUE INDEX IF NOT EXISTS wb_auto_publish_retries_active
      ON wb_auto_publish_retries(store_id,sku,run_id) WHERE status IN ('CHECKING','RUNNING');
    CREATE INDEX IF NOT EXISTS wb_auto_publish_retries_due
      ON wb_auto_publish_retries(next_check_at) WHERE status IN ('CHECKING','RUNNING');
    ALTER TABLE wb_gateway_requests DROP CONSTRAINT IF EXISTS wb_gateway_requests_card_attempt_pair;
    ALTER TABLE wb_gateway_requests ADD CONSTRAINT wb_gateway_requests_card_attempt_pair CHECK(
      (logical_intent_id IS NULL AND attempt_no IS NULL) OR
      (logical_intent_id IS NOT NULL AND attempt_no>=1));`);
}

export class WbAutoRetryRepository {
  constructor(private readonly db: Database) {}

  async protocol() {
    const row = (await this.db.query('SELECT * FROM wb_manual_retry_protocol WHERE singleton=true')).rows[0];
    return { contractVersion: 1, enabled: await this.enabled(), workflowVersionId: String(row?.workflow_version_id || '') };
  }

  async configureProtocol(input: { enabled: boolean; contractVersion: number; workflowVersionId?: string }) {
    if (typeof input.enabled !== 'boolean' || input.contractVersion !== 1
      || (input.enabled && !/^[a-f0-9-]{36}$/i.test(String(input.workflowVersionId || '')))) {
      throw new AppError('CONFIG_INVALID', '重试协议或已核验的工作流版本无效', undefined, 400);
    }
    await this.db.query(`UPDATE wb_manual_retry_protocol SET enabled=$1,contract_version=1,
      workflow_version_id=CASE WHEN $1 THEN $2 ELSE workflow_version_id END,
      verified_at=CASE WHEN $1 THEN NOW() ELSE verified_at END WHERE singleton=true`,
    [input.enabled, input.workflowVersionId || '']);
    return this.protocol();
  }

  async enabled(): Promise<boolean> {
    const rows = await this.db.query(`SELECT enabled AND contract_version=1 AND workflow_version_id<>'' AND verified_at IS NOT NULL enabled
      FROM wb_manual_retry_protocol WHERE singleton=true`);
    return rows.rows[0]?.enabled === true;
  }

  async snapshot(storeId: string, sku: string, client?: PoolClient): Promise<WbRetrySnapshot> {
    const db: Pick<Database, 'query'> = client || this.db;
    const a = await db.query(`SELECT * FROM wb_auto_publish_jobs WHERE store_id=$1 AND sku=$2${client ? ' FOR UPDATE' : ''}`, [storeId, sku]);
    if (!a.rows[0]) throw new AppError('NOT_FOUND', '自动上品任务不存在', { storeId, sku }, 404);
    const auto = a.rows[0];
    let p = auto.publication_id ? await db.query('SELECT * FROM wb_store_publications WHERE id=$1', [auto.publication_id]) : undefined;
    const taskId = auto.n8n_task_id || p?.rows[0]?.task_id;
    const r = taskId ? await db.query(`SELECT * FROM wb_publish_jobs WHERE task_id=$1${client ? ' FOR UPDATE' : ''}`, [taskId]) : undefined;
    if (client && p) p = await db.query('SELECT * FROM wb_store_publications WHERE id=$1 FOR UPDATE', [auto.publication_id]);
    return { auto, runtime: r?.rows[0], publication: p?.rows[0] };
  }

  async latest(storeId: string, sku: string, runId: string): Promise<Row | undefined> {
    return (await this.db.query(`SELECT * FROM wb_auto_publish_retries
      WHERE store_id=$1 AND sku=$2 AND run_id=$3 ORDER BY created_at DESC LIMIT 1`, [storeId, sku, runId])).rows[0];
  }

  async request(sku: string, input: WbPublishRetryRequest): Promise<{ row: Row; existing: boolean }> {
    return this.db.transaction(async client => {
      // Serialize acceptance per store/SKU, including distinct requestIds from two tabs.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`wb-retry:${input.storeId}:${sku}`]);
      const repeated = (await client.query('SELECT * FROM wb_auto_publish_retries WHERE request_id=$1', [input.requestId])).rows[0];
      if (repeated) {
        if (repeated.store_id !== input.storeId || repeated.sku !== sku || repeated.run_id !== input.runId) {
          throw new AppError('VERSION_CONFLICT', '重试请求编号已属于另一个任务', undefined, 409);
        }
        return { row: repeated, existing: true };
      }
      const snapshot = await this.snapshot(input.storeId, sku, client);
      const a = snapshot.auto;
      const active = (await client.query(`SELECT * FROM wb_auto_publish_retries
        WHERE store_id=$1 AND sku=$2 AND run_id=$3 AND status IN ('CHECKING','RUNNING')`, [input.storeId, sku, input.runId])).rows[0];
      if (active) return { row: active, existing: true };
      if (a.run_id !== input.runId || retryStateToken(snapshot) !== input.expectedStateToken) {
        throw new AppError('VERSION_CONFLICT', '任务已变化，请刷新详情后重试', undefined, 409);
      }
      if (!eligible.has(a.state)) throw new AppError('TASK_LOCKED', '任务已完成、已取消或仍在执行，不能重复启动', { state: a.state }, 409);
      if (a.lease_until && new Date(a.lease_until).getTime() > Date.now()) throw new AppError('TASK_LOCKED', '自动任务正在推进，请稍后重试', undefined, 409);
      if (snapshot.runtime?.lease_owner && new Date(snapshot.runtime.lease_expires_at).getTime() > Date.now()) throw new AppError('TASK_LOCKED', '原上品任务仍在执行', undefined, 409);
      const protocol = await client.query(`SELECT enabled AND contract_version=1 AND workflow_version_id<>'' AND verified_at IS NOT NULL enabled FROM wb_manual_retry_protocol WHERE singleton=true`);
      if (!protocol.rows[0]?.enabled) throw new AppError('WB_RETRY_NOT_DEPLOYED', '重试上品配套工作流尚未核验启用', undefined, 409);
      if (!a.n8n_task_id && snapshot.runtime) {
        if (snapshot.runtime.store_id !== a.store_id || snapshot.runtime.publication_id !== a.publication_id
          || snapshot.runtime.result_json?.automationRunId !== a.run_id) throw new AppError('VERSION_CONFLICT', '独立发布记录身份不一致', undefined, 409);
        a.n8n_task_id = snapshot.runtime.task_id;
        await client.query('UPDATE wb_auto_publish_jobs SET n8n_task_id=$2 WHERE id=$1', [a.id, a.n8n_task_id]);
      }
      const id = randomUUID();
      const retryNo = Number((await client.query(`SELECT COALESCE(MAX(retry_no),0)+1 next FROM wb_auto_publish_retries
        WHERE job_id=$1 AND run_id=$2`, [a.id, a.run_id])).rows[0].next);
      // Persist only identity/version evidence, never credentials or mutable product contents.
      const identity = { autoId: a.id, runId: a.run_id, taskId: a.n8n_task_id, publicationId: a.publication_id,
        runtimeVersion: snapshot.runtime?.row_version, payloadSignature: snapshot.runtime?.payload_signature,
        generatedVersionId: snapshot.publication?.generated_version_id, previousState: a.state };
      const created = await client.query(`INSERT INTO wb_auto_publish_retries(id,request_id,job_id,store_id,sku,run_id,
        task_id,publication_id,expected_token,status,previous_error_code,previous_error_message,snapshot,retry_no)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'CHECKING',$10,$11,$12,$13) RETURNING *`,
      [id, input.requestId, a.id, input.storeId, sku, input.runId, a.n8n_task_id || null, a.publication_id || null,
        input.expectedStateToken, a.last_error_code || '', a.last_error_message || '', JSON.stringify(identity), retryNo]);
      await client.query(`UPDATE wb_auto_publish_jobs SET state='CHECKING',next_attempt_at=NULL,worker_id=NULL,
        lease_until=NULL,updated_at=NOW() WHERE id=$1`, [a.id]);
      await this.event(client, a, 'MANUAL_RETRY_REQUESTED', a.state, 'CHECKING', '正在检查重试条件', { retryId: id });
      return { row: created.rows[0], existing: false };
    });
  }

  async claim(): Promise<WbRetryClaim | undefined> {
    return this.db.transaction(async client => {
      const result = await client.query(`SELECT * FROM wb_auto_publish_retries WHERE status IN ('CHECKING','RUNNING')
        AND next_check_at<=NOW() AND (lease_until IS NULL OR lease_until<=NOW())
        ORDER BY next_check_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if (!result.rows[0]) return undefined;
      const token = randomUUID();
      return (await client.query(`UPDATE wb_auto_publish_retries SET lease_token=$2,lease_until=NOW()+INTERVAL '120 seconds',
        row_version=row_version+1 WHERE id=$1 RETURNING *`, [result.rows[0].id, token])).rows[0] as WbRetryClaim;
    });
  }

  async heartbeat(claim: WbRetryClaim): Promise<void> {
    const result = await this.db.query(`UPDATE wb_auto_publish_retries SET lease_until=NOW()+INTERVAL '120 seconds'
      WHERE id=$1 AND lease_token=$2 AND lease_until>NOW() AND status IN ('CHECKING','RUNNING')`, [claim.id, claim.lease_token]);
    if (!result.rowCount) throw new AppError('TASK_LOCKED', '重试检查租约已变化', undefined, 409);
  }

  async receipts(taskId: string): Promise<Row[]> {
    return (await this.db.query(`SELECT request_ref,operation,status_code,response_json,delivery_state,retry_class,
      request_hash,logical_intent_id,attempt_no,completed_at,created_at FROM wb_gateway_requests
      WHERE task_id=$1 ORDER BY created_at,request_ref`, [taskId])).rows;
  }

  async settle(claim: WbRetryClaim, status: 'BLOCKED' | 'FAILED' | 'SUCCEEDED', message: string, code = ''): Promise<void> {
    await this.db.transaction(async client => {
      const snap = await this.snapshot(claim.store_id, claim.sku, client);
      const held = await this.fence(client, claim);
      const a = snap.auto;
      if (a.id !== held.job_id || a.run_id !== held.run_id) throw new AppError('VERSION_CONFLICT', '自动任务轮次已变化', undefined, 409);
      await client.query(`UPDATE wb_auto_publish_retries SET status=$3,message=$4,error_code=$5,finished_at=NOW(),
        updated_at=NOW(),lease_token=NULL,lease_until=NULL,row_version=row_version+1 WHERE id=$1 AND lease_token=$2`,
      [claim.id, claim.lease_token, status, message.slice(0, 4000), code]);
      const target = a.state === 'CANCELLED' ? 'CANCELLED' : status === 'SUCCEEDED' ? 'SUCCEEDED' : status === 'FAILED' ? 'FAILED' : 'NEEDS_ATTENTION';
      await client.query(`UPDATE wb_auto_publish_jobs SET state=$2,last_error_code=$3,last_error_message=$4,
        next_attempt_at=NULL,worker_id=NULL,lease_until=NULL,updated_at=NOW() WHERE id=$1`,
      [a.id, target, status === 'SUCCEEDED' ? null : code, status === 'SUCCEEDED' ? null : message.slice(0, 4000)]);
      if (snap.publication && snap.runtime && ['SUCCEEDED', 'FAILED', 'NEEDS_ATTENTION', 'PAUSED'].includes(snap.runtime.state)) {
        await this.db.syncPublication(client, ['NEEDS_ATTENTION', 'PAUSED'].includes(snap.runtime.state)
          ? { ...snap.runtime, state: 'BLOCKED_RETRY' } : snap.runtime);
      }
      await client.query(`UPDATE wb_listing_drafts SET auto_publish_locked=EXISTS(
        SELECT 1 FROM wb_auto_publish_jobs WHERE sku=$1 AND state NOT IN
        ('SUCCEEDED','BLOCKED_EXISTING_CARD','CANCELLED','NEEDS_ATTENTION','PAUSED','FAILED')),
        updated_at=NOW() WHERE sku=$1`, [claim.sku]);
      await this.event(client, a, `MANUAL_RETRY_${status}`, a.state, target, message, { retryId: claim.id });
    });
  }

  async defer(claim: WbRetryClaim, message: string, seconds = 10): Promise<void> {
    await this.db.query(`UPDATE wb_auto_publish_retries SET message=$3,next_check_at=NOW()+$4*INTERVAL '1 second',
      lease_token=NULL,lease_until=NULL,updated_at=NOW() WHERE id=$1 AND lease_token=$2`,
    [claim.id, claim.lease_token, message.slice(0, 4000), seconds]);
  }

  async preparation(claim: WbRetryClaim): Promise<void> {
    await this.db.transaction(async client => {
      const { auto: a, publication: p } = await this.snapshot(claim.store_id, claim.sku, client);
      await this.fence(client, claim);
      if (a.run_id !== claim.run_id || a.n8n_task_id || a.state === 'CANCELLED') throw new AppError('VERSION_CONFLICT', '任务已进入提交阶段或已取消', undefined, 409);
      if (p?.status === 'FAILED' || p?.status === 'PAUSED') {
        if (p.config_snapshot?.automationRunId !== a.run_id || p.store_id !== a.store_id) throw new AppError('VERSION_CONFLICT', '原发布合同身份不一致', undefined, 409);
        // Existing dispatch recovery performs readback before any submission and reuses this frozen publication.
        await client.query(`UPDATE wb_store_publications SET status='NEEDS_ATTENTION',error_code='',error_message='',
          row_version=row_version+1,updated_at=NOW() WHERE id=$1`, [p.id]);
      }
      await client.query(`UPDATE wb_auto_publish_retries SET status='RUNNING',stage='CHECKING_PREPARATION',
        message='检查上品资料',next_check_at=NOW()+INTERVAL '10 seconds',lease_token=NULL,lease_until=NULL,updated_at=NOW() WHERE id=$1`, [claim.id]);
      await client.query(`UPDATE wb_auto_publish_jobs SET state='CHECKING',next_attempt_at=NOW(),last_error_code=NULL,
        last_error_message=NULL,retry_counters='{}',worker_id=NULL,lease_until=NULL,updated_at=NOW() WHERE id=$1`, [a.id]);
      await client.query(`UPDATE wb_listing_drafts SET auto_publish_locked=true,latest_operation_source='AUTOMATION',
        latest_operation_ref=$2 WHERE sku=$1`, [claim.sku, `automation:${claim.run_id}`]);
    });
  }

  async refreshUnconsumed(claim: WbRetryClaim): Promise<void> {
    await this.db.transaction(async client => {
      const { runtime: r, auto: a } = await this.snapshot(claim.store_id, claim.sku, client);
      const held = await this.fence(client, claim);
      if (!r || held.consumed_at || !held.authorized_attempt || a.run_id !== held.run_id
        || (r.lease_owner && new Date(r.lease_expires_at).getTime() > Date.now())) throw new AppError('TASK_LOCKED', '原尝试正在推进', undefined, 409);
      const runtime = r.result_json;
      runtime.lastFailureCheckpoint = { stage: held.evidence.failedStage, requestRef: held.evidence.failedRequestRef, state: 'CARD_SUBMITTING' };
      await client.query(`UPDATE wb_publish_jobs SET state='FAILED',next_run_at=NULL,result_json=$2,
        row_version=row_version+1,updated_at=NOW() WHERE task_id=$1`, [r.task_id, JSON.stringify(runtime)]);
      await client.query(`UPDATE wb_auto_publish_retries SET status='CHECKING',message='核验已过期，正在重新检查原尝试',
        lease_token=NULL,lease_until=NULL,next_check_at=NOW(),updated_at=NOW() WHERE id=$1`, [claim.id]);
    });
  }

  async resume(claim: WbRetryClaim, snapshot: WbRetrySnapshot, stage: string, evidence: Row, manualCardAttempt?: number): Promise<void> {
    await this.db.transaction(async client => {
      const current = await this.snapshot(claim.store_id, claim.sku, client);
      await this.fence(client, claim);
      const { auto: a, runtime: r, publication: p } = current;
      if (!r || !p || r.row_version !== snapshot.runtime?.row_version || a.run_id !== claim.run_id
        || r.task_id !== claim.task_id || r.store_id !== claim.store_id || p.task_id !== r.task_id
        || r.publication_id !== p.id || r.payload_signature !== snapshot.runtime?.payload_signature
        || p.generated_version_id !== snapshot.publication?.generated_version_id
        || !['FAILED', 'NEEDS_ATTENTION', 'PAUSED', 'BLOCKED_CONFIG', 'BLOCKED_AUTH', 'BLOCKED_SCHEMA', 'BLOCKED_COMPLIANCE', 'BLOCKED_EXISTING_CARD'].includes(r.state)) {
        throw new AppError('VERSION_CONFLICT', '原任务或发布版本已变化，请重新核对', undefined, 409);
      }
      if (r.lease_owner && new Date(r.lease_expires_at).getTime() > Date.now()) throw new AppError('TASK_LOCKED', '原任务正在执行', undefined, 409);
      const runtime = typeof r.result_json === 'string' ? JSON.parse(r.result_json) : r.result_json;
      const previousError = { code: r.last_error_code, message: r.last_error_message, at: r.finished_at };
      runtime.manualRetry = { contractVersion: 1, retryId: claim.id, stage, previousError, preserveCompletedMedia: true,
        ignoredGenericFailureBatches: evidence.ignoredGenericFailureBatches || [],
        ...(manualCardAttempt ? { cardAttemptNo: manualCardAttempt, cardWriteAuthorized: true } : {}) };
      runtime.audit = [...(runtime.audit || []), { at: new Date().toISOString(), event: 'MANUAL_RETRY_RESUMED',
        retryId: claim.id, previousState: r.state, stage, previousError }];
      if (Array.isArray(evidence.cards) && evidence.cards.length) runtime.cards = evidence.cards;
      await client.query(`UPDATE wb_publish_jobs SET state=$3,resume_state='',stage_attempt=0,poll_count=0,
        next_run_at=NOW(),stage_deadline_at=NULL,finished_at=NULL,last_error_code='',last_error_message='',
        lease_owner='',lease_expires_at=NULL,result_json=$4,row_version=row_version+1,updated_at=NOW()
        WHERE task_id=$1 AND row_version=$2`, [r.task_id, r.row_version, stage, JSON.stringify(runtime)]);
      await client.query(`UPDATE wb_auto_publish_retries SET status='RUNNING',stage=$2,message=$3,evidence=$4,
        authorized_attempt=$5,runtime_version=$6,lease_token=NULL,lease_until=NULL,
        next_check_at=NOW()+INTERVAL '10 seconds',updated_at=NOW(),row_version=row_version+1 WHERE id=$1`,
      [claim.id, stage, `已开始重试：${WB_RETRY_STAGE_LABELS[stage] || '继续原任务'}`, JSON.stringify(evidence), manualCardAttempt || null, r.row_version + 1]);
      await client.query(`UPDATE wb_store_publications SET status='QUEUED',error_code='',error_message='',
        row_version=row_version+1,updated_at=NOW() WHERE id=$1`, [p.id]);
      await client.query(`UPDATE wb_auto_publish_jobs SET state='QUEUED',next_attempt_at=NULL,last_error_code=NULL,
        last_error_message=NULL,worker_id=NULL,lease_until=NULL,updated_at=NOW() WHERE id=$1`, [a.id]);
      await client.query('UPDATE wb_listing_drafts SET auto_publish_locked=true,updated_at=NOW() WHERE sku=$1', [claim.sku]);
      await this.event(client, a, 'MANUAL_RETRY_RESUMED', a.state, 'QUEUED', `已开始重试：${WB_RETRY_STAGE_LABELS[stage] || '继续原任务'}`, { retryId: claim.id, stage });
    });
  }

  private async fence(client: PoolClient, claim: WbRetryClaim): Promise<Row> {
    const r = await client.query(`SELECT * FROM wb_auto_publish_retries WHERE id=$1 AND lease_token=$2
      AND lease_until>NOW() AND status IN ('CHECKING','RUNNING') FOR UPDATE`, [claim.id, claim.lease_token]);
    if (!r.rows[0]) throw new AppError('TASK_LOCKED', '重试租约已失效', undefined, 409);
    return r.rows[0];
  }

  private async event(client: PoolClient, a: Row, type: string, from: string, to: string, message: string, details: Row) {
    await client.query(`INSERT INTO wb_auto_publish_events(id,job_id,store_id,sku,event_type,from_state,to_state,message,details)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(), a.id, a.store_id, a.sku, type, from, to, message.slice(0, 4000), JSON.stringify(details)]);
  }
}
