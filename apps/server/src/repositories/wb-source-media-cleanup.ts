import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { AppError } from '@n8n-media-review/shared';

type SqlRow = Record<string, any>;

export type WbSourceMediaCleanupSource = 'MANUAL' | 'AUTOMATION';
export type WbSourceMediaCleanupStatus = 'CANDIDATE' | 'PENDING' | 'RETRY_WAIT' | 'QUARANTINED' | 'CLEANED' | 'SUPERSEDED';
export type WbSourceMediaState = 'AVAILABLE' | 'CLEANUP_PENDING' | 'CLEANED';

export type WbSourceMediaCleanupBatch = {
  id: string;
  sku: string;
  source: WbSourceMediaCleanupSource;
  batchKey: string;
  expectedStoreIds: string[];
  rootDirectory: string;
  mediaSignature: string;
  mediaBatchId?: string;
  deliveredAt?: string;
  planHash?: string;
  draftVersion?: number;
  status: WbSourceMediaCleanupStatus;
  rowVersion: number;
  attemptCount: number;
  nextAttemptAt: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  quarantineRelPath?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  cleanedAt?: string;
  supersededAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type WbSourceMediaCleanupTarget = {
  cleanupId: string;
  storeId: string;
  publicationId?: string;
  publicationSource?: WbSourceMediaCleanupSource;
  publicationStatus?: string;
  publicationTaskId?: string;
  publicationPlanHash?: string;
  publicationPackageSignature?: string;
  publicationMaterializationHash?: string;
  automationJobId?: string;
  automationRunId?: string;
  automationState?: string;
  runtimeTaskId?: string;
  runtimeState?: string;
  runtimeWorkRelpath?: string;
  runtimePublicationId?: string;
};

export type WbSourceMediaCleanupRegistration = {
  id?: string;
  sku: string;
  source: WbSourceMediaCleanupSource;
  batchKey: string;
  expectedStoreIds: string[];
  rootDirectory: string;
  mediaSignature: string;
  mediaBatchId?: string;
  deliveredAt?: string;
  planHash?: string;
  draftVersion?: number;
  initialStatus?: 'CANDIDATE' | 'PENDING';
};

export type WbSourceMediaCleanupAutomationTargetRegistration = {
  storeId: string;
  jobId: string;
  runId: string;
};

export type WbSourceMediaCleanupOrphanEvidence = {
  batch: WbSourceMediaCleanupBatch;
  targets: WbSourceMediaCleanupTarget[];
  reasons: string[];
};

export type WbHistoricalSourceMediaGroup = {
  sku: string;
  source: WbSourceMediaCleanupSource;
  groupCreatedAt: string;
  completedAt?: string;
  expectedStoreIds: string[];
  planHash?: string;
  draftVersion?: number;
  mediaBatchId?: string;
  deliveredAt?: string;
  targets: Array<{ storeId: string; publicationId?: string; automationJobId?: string; automationRunId?: string }>;
};

export async function ensureWbSourceMediaCleanupSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS wb_source_media_cleanup_batches(
      id UUID PRIMARY KEY,
      sku CHAR(7) NOT NULL REFERENCES products(sku) ON DELETE RESTRICT,
      source TEXT NOT NULL CHECK(source IN ('MANUAL','AUTOMATION')),
      batch_key TEXT NOT NULL UNIQUE,
      expected_store_ids UUID[] NOT NULL CHECK(cardinality(expected_store_ids)>0),
      root_directory TEXT NOT NULL,
      media_signature TEXT NOT NULL CHECK(media_signature ~ '^sha256:[a-f0-9]{64}$'),
      media_batch_id TEXT,
      delivered_at TIMESTAMPTZ,
      plan_hash TEXT,
      draft_version INTEGER CHECK(draft_version IS NULL OR draft_version>0),
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('CANDIDATE','PENDING','RETRY_WAIT','QUARANTINED','CLEANED','SUPERSEDED')),
      row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      lease_owner TEXT,
      lease_token UUID,
      lease_expires_at TIMESTAMPTZ,
      quarantine_rel_path TEXT,
      last_error_code TEXT NOT NULL DEFAULT '',
      last_error_message TEXT NOT NULL DEFAULT '',
      cleaned_at TIMESTAMPTZ,
      superseded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK((source='MANUAL' AND plan_hash IS NOT NULL AND draft_version IS NOT NULL)
        OR (source='AUTOMATION' AND media_batch_id IS NOT NULL AND delivered_at IS NOT NULL))
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS wb_source_media_cleanup_targets(
      cleanup_id UUID NOT NULL REFERENCES wb_source_media_cleanup_batches(id) ON DELETE CASCADE,
      store_id UUID NOT NULL REFERENCES wb_stores(id) ON DELETE RESTRICT,
      publication_id UUID REFERENCES wb_store_publications(id) ON DELETE SET NULL,
      automation_job_id UUID,
      automation_run_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(cleanup_id,store_id)
    )`);
    await client.query('ALTER TABLE wb_source_media_cleanup_batches DROP CONSTRAINT IF EXISTS wb_source_media_cleanup_batches_status_check');
    await client.query(`ALTER TABLE wb_source_media_cleanup_batches ADD CONSTRAINT wb_source_media_cleanup_batches_status_check
      CHECK(status IN ('CANDIDATE','PENDING','RETRY_WAIT','QUARANTINED','CLEANED','SUPERSEDED'))`);
    await client.query(`CREATE INDEX IF NOT EXISTS wb_source_media_cleanup_due
      ON wb_source_media_cleanup_batches(status,next_attempt_at)
      WHERE status IN ('PENDING','RETRY_WAIT','QUARANTINED')`);
    await client.query(`CREATE INDEX IF NOT EXISTS wb_source_media_cleanup_sku_created
      ON wb_source_media_cleanup_batches(sku,created_at DESC)`);
    await client.query(`ALTER TABLE wb_listing_drafts
      ADD COLUMN IF NOT EXISTS source_media_state TEXT NOT NULL DEFAULT 'AVAILABLE',
      ADD COLUMN IF NOT EXISTS source_media_cleaned_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS source_media_cleanup_id UUID`);
    await client.query('ALTER TABLE wb_listing_drafts DROP CONSTRAINT IF EXISTS wb_listing_drafts_source_media_state_check');
    await client.query(`ALTER TABLE wb_listing_drafts ADD CONSTRAINT wb_listing_drafts_source_media_state_check
      CHECK(source_media_state IN ('AVAILABLE','CLEANUP_PENDING','CLEANED'))`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export class WbSourceMediaCleanupRepository {
  private pool?: Pool;

  constructor(private readonly connectionString?: string) {}
  get configured(): boolean { return Boolean(this.pool); }

  async initialize(): Promise<void> {
    if (!this.connectionString) return;
    this.pool = new Pool({ connectionString: this.connectionString, max: 4, idleTimeoutMillis: 30_000 });
    try {
      await this.pool.query('SELECT 1');
      await ensureWbSourceMediaCleanupSchema(this.pool);
    } catch (error) {
      await this.pool.end().catch(() => undefined);
      this.pool = undefined;
      throw error;
    }
  }

  async close(): Promise<void> { await this.pool?.end(); }

  async markSourceAvailable(sku: string): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(`UPDATE wb_source_media_cleanup_batches SET status='SUPERSEDED',superseded_at=NOW(),
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,row_version=row_version+1,updated_at=NOW()
        WHERE sku=$1 AND status IN ('CANDIDATE','PENDING','RETRY_WAIT','CLEANED')`, [sku]);
      await client.query(`UPDATE wb_listing_drafts SET source_media_state='AVAILABLE',source_media_cleaned_at=NULL,
        source_media_cleanup_id=NULL,updated_at=NOW() WHERE sku=$1`, [sku]);
    });
  }

  async registerBatch(input: WbSourceMediaCleanupRegistration): Promise<WbSourceMediaCleanupBatch> {
    assertRegistration(input);
    return this.transaction(async (client) => {
      const existing = await client.query<SqlRow>('SELECT * FROM wb_source_media_cleanup_batches WHERE batch_key=$1 FOR UPDATE', [input.batchKey]);
      if (existing.rows[0]) {
        const current = toBatch(existing.rows[0]);
        assertSameRegistration(current, input);
        return current;
      }
      const supersededStatuses = input.initialStatus === 'CANDIDATE'
        ? ['CANDIDATE']
        : ['CANDIDATE', 'PENDING', 'RETRY_WAIT', 'CLEANED'];
      await client.query(`UPDATE wb_source_media_cleanup_batches SET status='SUPERSEDED',superseded_at=NOW(),
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,row_version=row_version+1,updated_at=NOW()
        WHERE sku=$1 AND status=ANY($2::text[])`, [input.sku, supersededStatuses]);
      const id = input.id || randomUUID();
      const result = await client.query<SqlRow>(`INSERT INTO wb_source_media_cleanup_batches(
        id,sku,source,batch_key,expected_store_ids,root_directory,media_signature,media_batch_id,delivered_at,plan_hash,draft_version,status)
        VALUES($1,$2,$3,$4,$5::uuid[],$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [
        id, input.sku, input.source, input.batchKey, uniqueSorted(input.expectedStoreIds), input.rootDirectory,
        input.mediaSignature, input.mediaBatchId || null, input.deliveredAt || null, input.planHash || null, input.draftVersion || null,
        input.initialStatus || 'PENDING'
      ]);
      for (const storeId of uniqueSorted(input.expectedStoreIds)) {
        await client.query(`INSERT INTO wb_source_media_cleanup_targets(cleanup_id,store_id) VALUES($1,$2)
          ON CONFLICT(cleanup_id,store_id) DO NOTHING`, [id, storeId]);
      }
      if (input.initialStatus !== 'CANDIDATE') {
        await client.query(`UPDATE wb_listing_drafts SET source_media_state='CLEANUP_PENDING',source_media_cleaned_at=NULL,
          source_media_cleanup_id=$2,updated_at=NOW() WHERE sku=$1`, [input.sku, id]);
      }
      return toBatch(result.rows[0]!);
    });
  }

  async registerAutomationBatch(
    input: WbSourceMediaCleanupRegistration,
    targets: WbSourceMediaCleanupAutomationTargetRegistration[]
  ): Promise<WbSourceMediaCleanupBatch> {
    assertRegistration(input);
    if (input.source !== 'AUTOMATION') {
      throw new AppError('CONFIG_INVALID', 'WB 自动媒体清理批次来源必须是 AUTOMATION');
    }
    const normalizedTargets = [...targets].sort((left, right) => left.storeId.localeCompare(right.storeId));
    const expectedStoreIds = uniqueSorted(input.expectedStoreIds);
    if (normalizedTargets.length !== expectedStoreIds.length
      || JSON.stringify(normalizedTargets.map((target) => target.storeId)) !== JSON.stringify(expectedStoreIds)
      || new Set(normalizedTargets.map((target) => target.jobId)).size !== normalizedTargets.length) {
      throw new AppError('CONFIG_INVALID', 'WB 自动媒体清理批次目标任务集合不完整', {
        expectedStoreIds,
        registeredStoreIds: normalizedTargets.map((target) => target.storeId)
      }, 409);
    }
    return this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.batchKey]);
      const jobs = await client.query<SqlRow>(`SELECT id,store_id,run_id FROM wb_auto_publish_jobs
        WHERE id=ANY($1::uuid[]) FOR SHARE`, [normalizedTargets.map((target) => target.jobId)]);
      const jobsById = new Map(jobs.rows.map((row) => [String(row.id), row]));
      for (const target of normalizedTargets) {
        const job = jobsById.get(target.jobId);
        if (!job || String(job.store_id) !== target.storeId || String(job.run_id) !== target.runId) {
          throw new AppError('VERSION_CONFLICT', 'WB 自动媒体清理批次与自动任务身份不一致', target, 409);
        }
      }

      const existing = await client.query<SqlRow>('SELECT * FROM wb_source_media_cleanup_batches WHERE batch_key=$1 FOR UPDATE', [input.batchKey]);
      let batchRow = existing.rows[0];
      if (batchRow) {
        const current = toBatch(batchRow);
        assertSameRegistration(current, input);
        if (current.status === 'SUPERSEDED' || current.status === 'CLEANED') return current;
      } else {
        await client.query(`UPDATE wb_source_media_cleanup_batches SET status='SUPERSEDED',superseded_at=NOW(),
          lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,row_version=row_version+1,updated_at=NOW()
          WHERE sku=$1 AND status IN ('CANDIDATE','PENDING','RETRY_WAIT','CLEANED')`, [input.sku]);
        const id = input.id || randomUUID();
        const inserted = await client.query<SqlRow>(`INSERT INTO wb_source_media_cleanup_batches(
          id,sku,source,batch_key,expected_store_ids,root_directory,media_signature,media_batch_id,delivered_at,plan_hash,draft_version,status)
          VALUES($1,$2,'AUTOMATION',$3,$4::uuid[],$5,$6,$7,$8,NULL,NULL,'PENDING') RETURNING *`, [
          id, input.sku, input.batchKey, expectedStoreIds, input.rootDirectory,
          input.mediaSignature, input.mediaBatchId, input.deliveredAt
        ]);
        batchRow = inserted.rows[0]!;
        for (const storeId of expectedStoreIds) {
          await client.query(`INSERT INTO wb_source_media_cleanup_targets(cleanup_id,store_id) VALUES($1,$2)
            ON CONFLICT(cleanup_id,store_id) DO NOTHING`, [id, storeId]);
        }
      }

      for (const target of normalizedTargets) {
        const linked = await client.query(`UPDATE wb_source_media_cleanup_targets SET
          automation_job_id=$3,automation_run_id=$4,updated_at=NOW()
          WHERE cleanup_id=$1 AND store_id=$2
            AND (automation_job_id IS NULL OR (automation_job_id=$3 AND automation_run_id=$4))`, [
          batchRow.id, target.storeId, target.jobId, target.runId
        ]);
        if (linked.rowCount !== 1) {
          throw new AppError('VERSION_CONFLICT', 'WB 自动媒体清理批次目标关联发生并发冲突', {
            cleanupId: String(batchRow.id), ...target
          }, 409);
        }
      }
      await client.query(`UPDATE wb_listing_drafts SET source_media_state='CLEANUP_PENDING',source_media_cleaned_at=NULL,
        source_media_cleanup_id=$2,updated_at=NOW() WHERE sku=$1`, [input.sku, batchRow.id]);
      return toBatch(batchRow);
    });
  }

  async supersedeIncompleteAutomationBatch(batchKey: string, code: string, message: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>(`SELECT * FROM wb_source_media_cleanup_batches
        WHERE batch_key=$1 FOR UPDATE`, [batchKey]);
      const row = current.rows[0];
      if (!row || row.source !== 'AUTOMATION' || !['CANDIDATE', 'PENDING', 'RETRY_WAIT'].includes(String(row.status))) return false;
      if (row.lease_expires_at && Date.parse(String(row.lease_expires_at)) > Date.now()) return false;
      const complete = Boolean((await client.query<{ complete: boolean }>(`SELECT
        COUNT(*)=cardinality($2::uuid[])
        AND BOOL_AND(target.automation_job_id IS NOT NULL AND target.automation_run_id IS NOT NULL
          AND job.id=target.automation_job_id AND job.run_id=target.automation_run_id AND job.store_id=target.store_id) complete
        FROM wb_source_media_cleanup_targets target
        LEFT JOIN wb_auto_publish_jobs job ON job.id=target.automation_job_id
        WHERE target.cleanup_id=$1`, [row.id, row.expected_store_ids])).rows[0]?.complete);
      if (complete) return false;
      const updated = await client.query(`UPDATE wb_source_media_cleanup_batches SET status='SUPERSEDED',superseded_at=NOW(),
        last_error_code=$2,last_error_message=$3,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
        row_version=row_version+1,updated_at=NOW() WHERE id=$1 AND row_version=$4`, [row.id, code, message, row.row_version]);
      if (updated.rowCount !== 1) throw new AppError('VERSION_CONFLICT', 'WB 自动媒体清理批次废止时发生并发变化', { batchKey }, 409);
      await client.query(`UPDATE wb_listing_drafts SET source_media_state='AVAILABLE',source_media_cleaned_at=NULL,
        source_media_cleanup_id=NULL,updated_at=NOW() WHERE sku=$1 AND source_media_cleanup_id=$2`, [row.sku, row.id]);
      return true;
    });
  }

  async inspectOrphanAutomationBatch(id: string): Promise<WbSourceMediaCleanupOrphanEvidence> {
    const batch = await this.get(id);
    const targets = await this.targets(id);
    const reasons: string[] = [];
    if (batch.source !== 'AUTOMATION') reasons.push('SOURCE_NOT_AUTOMATION');
    if (!['PENDING', 'RETRY_WAIT'].includes(batch.status)) reasons.push(`STATUS_${batch.status}`);
    if (batch.leaseExpiresAt && Date.parse(batch.leaseExpiresAt) > Date.now()) reasons.push('LEASE_ACTIVE');
    if (targets.some((target) => target.automationJobId || target.automationRunId || target.publicationId)) reasons.push('TARGET_IDENTITY_PRESENT');
    const databaseEvidence = await this.query<SqlRow>(`SELECT
      (SELECT COUNT(*) FROM wb_auto_publish_jobs WHERE sku=$1) auto_job_count,
      (SELECT COUNT(*) FROM wb_stores store WHERE store.id=ANY($2::uuid[])) store_count,
      (SELECT COUNT(*) FROM wb_stores store WHERE store.id=ANY($2::uuid[])
        AND store.auto_publish_activated_at IS NOT NULL AND store.auto_publish_activated_at>$3::timestamptz) activated_after_delivery_count`, [
      batch.sku, batch.expectedStoreIds, batch.deliveredAt || null
    ]);
    const row = databaseEvidence.rows[0] || {};
    if (Number(row.auto_job_count || 0) !== 0) reasons.push('AUTOMATION_JOB_PRESENT');
    if (Number(row.store_count || 0) !== batch.expectedStoreIds.length) reasons.push('EXPECTED_STORE_MISSING');
    if (Number(row.activated_after_delivery_count || 0) !== batch.expectedStoreIds.length) reasons.push('DELIVERY_NOT_BEFORE_ALL_ACTIVATIONS');
    return { batch, targets, reasons };
  }

  async supersedeOrphanAutomationBatch(id: string, rowVersion: number, code: string, message: string): Promise<void> {
    const result = await this.query(`UPDATE wb_source_media_cleanup_batches batch SET status='SUPERSEDED',superseded_at=NOW(),
      last_error_code=$3,last_error_message=$4,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
      row_version=row_version+1,updated_at=NOW()
      WHERE batch.id=$1 AND batch.row_version=$2 AND batch.source='AUTOMATION'
        AND batch.status IN ('PENDING','RETRY_WAIT')
        AND (batch.lease_expires_at IS NULL OR batch.lease_expires_at<=NOW())
        AND NOT EXISTS(SELECT 1 FROM wb_source_media_cleanup_targets target WHERE target.cleanup_id=batch.id
          AND (target.automation_job_id IS NOT NULL OR target.automation_run_id IS NOT NULL OR target.publication_id IS NOT NULL))
        AND NOT EXISTS(SELECT 1 FROM wb_auto_publish_jobs job WHERE job.sku=batch.sku)
        AND cardinality(batch.expected_store_ids)=(SELECT COUNT(*) FROM wb_stores store WHERE store.id=ANY(batch.expected_store_ids)
          AND store.auto_publish_activated_at IS NOT NULL AND store.auto_publish_activated_at>batch.delivered_at)`, [
      id, rowVersion, code, message
    ]);
    if (result.rowCount !== 1) {
      throw new AppError('VERSION_CONFLICT', 'WB 孤儿自动清理批次已变化或不再满足安全废止条件', { id, rowVersion }, 409);
    }
    await this.query(`UPDATE wb_listing_drafts SET source_media_state='AVAILABLE',source_media_cleaned_at=NULL,
      source_media_cleanup_id=NULL,updated_at=NOW() WHERE source_media_cleanup_id=$1`, [id]);
  }

  async linkManualPublication(cleanupId: string, storeId: string, publicationId: string): Promise<void> {
    const result = await this.query(`UPDATE wb_source_media_cleanup_targets SET publication_id=$3,updated_at=NOW()
      WHERE cleanup_id=$1 AND store_id=$2 AND (publication_id IS NULL OR publication_id=$3)`, [cleanupId, storeId, publicationId]);
    if (result.rowCount !== 1) throw new AppError('VERSION_CONFLICT', 'WB 媒体清理批次与手动 publication 身份不一致', { cleanupId, storeId, publicationId }, 409);
  }

  async linkAutomationJob(cleanupId: string, storeId: string, automationJobId: string, automationRunId: string): Promise<void> {
    const result = await this.query(`UPDATE wb_source_media_cleanup_targets SET automation_job_id=$3,automation_run_id=$4,updated_at=NOW()
      WHERE cleanup_id=$1 AND store_id=$2 AND (automation_job_id IS NULL OR (automation_job_id=$3 AND automation_run_id=$4))`,
    [cleanupId, storeId, automationJobId, automationRunId]);
    if (result.rowCount !== 1) throw new AppError('VERSION_CONFLICT', 'WB 媒体清理批次与自动任务身份不一致', { cleanupId, storeId, automationJobId, automationRunId }, 409);
  }

  async get(id: string): Promise<WbSourceMediaCleanupBatch> {
    const result = await this.query<SqlRow>('SELECT * FROM wb_source_media_cleanup_batches WHERE id=$1', [id]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'WB 来源媒体清理批次不存在', { id }, 404);
    return toBatch(result.rows[0]);
  }

  async latestForSku(sku: string): Promise<WbSourceMediaCleanupBatch | undefined> {
    const result = await this.query<SqlRow>(`SELECT * FROM wb_source_media_cleanup_batches WHERE sku=$1
      ORDER BY created_at DESC,id DESC LIMIT 1`, [sku]);
    return result.rows[0] ? toBatch(result.rows[0]) : undefined;
  }

  async sourceState(sku: string): Promise<{ state: WbSourceMediaState; cleanedAt?: string }> {
    const result = await this.query<SqlRow>(`SELECT source_media_state,source_media_cleaned_at
      FROM wb_listing_drafts WHERE sku=$1`, [sku]);
    const row = result.rows[0];
    if (!row) return { state: 'AVAILABLE' };
    const state: WbSourceMediaState = row.source_media_state === 'CLEANED' ? 'CLEANED'
      : row.source_media_state === 'CLEANUP_PENDING' ? 'CLEANUP_PENDING' : 'AVAILABLE';
    return {
      state,
      ...(state === 'CLEANED' && row.source_media_cleaned_at
        ? { cleanedAt: new Date(row.source_media_cleaned_at).toISOString() }
        : {})
    };
  }

  async activateCandidate(id: string, rowVersion: number): Promise<WbSourceMediaCleanupBatch> {
    const result = await this.query<SqlRow>(`UPDATE wb_source_media_cleanup_batches SET status='PENDING',next_attempt_at=NOW(),
      row_version=row_version+1,updated_at=NOW() WHERE id=$1 AND row_version=$2 AND status='CANDIDATE'
      AND NOT EXISTS(SELECT 1 FROM wb_source_media_cleanup_batches active
        WHERE active.sku=wb_source_media_cleanup_batches.sku AND active.id<>wb_source_media_cleanup_batches.id
          AND active.status IN ('PENDING','RETRY_WAIT','QUARANTINED')) RETURNING *`, [id, rowVersion]);
    if (!result.rows[0]) throw new AppError('VERSION_CONFLICT', 'WB 历史清理候选已变化或已执行，请重新 dry-run', { id, rowVersion }, 409);
    await this.query(`UPDATE wb_listing_drafts SET source_media_state='CLEANUP_PENDING',source_media_cleaned_at=NULL,
      source_media_cleanup_id=$2,updated_at=NOW() WHERE sku=$1`, [result.rows[0].sku, id]);
    return toBatch(result.rows[0]);
  }

  async discardCandidate(id: string, rowVersion: number, code: string, message: string): Promise<void> {
    const result = await this.query(`UPDATE wb_source_media_cleanup_batches SET status='SUPERSEDED',superseded_at=NOW(),
      last_error_code=$3,last_error_message=$4,row_version=row_version+1,updated_at=NOW()
      WHERE id=$1 AND row_version=$2 AND status='CANDIDATE'`, [id, rowVersion, code, message]);
    if (result.rowCount !== 1) throw new AppError('VERSION_CONFLICT', 'WB 历史清理候选已变化', { id, rowVersion }, 409);
  }

  async supersedeCandidates(sku: string, code: string, message: string): Promise<void> {
    await this.query(`UPDATE wb_source_media_cleanup_batches SET status='SUPERSEDED',superseded_at=NOW(),
      last_error_code=$2,last_error_message=$3,row_version=row_version+1,updated_at=NOW()
      WHERE sku=$1 AND status='CANDIDATE'`, [sku, code, message]);
  }

  async discoverHistoricalGroup(sku: string): Promise<WbHistoricalSourceMediaGroup | undefined> {
    const manual = await this.query<SqlRow>(`SELECT plan_hash,MAX(created_at) group_created_at,MAX(completed_at) completed_at,
      (ARRAY_AGG(config_snapshot ORDER BY created_at DESC))[1] config_snapshot
      FROM wb_store_publications WHERE sku=$1 AND source='MANUAL' AND plan_hash IS NOT NULL
      GROUP BY plan_hash ORDER BY MAX(created_at) DESC LIMIT 1`, [sku]);
    const auto = await this.query<SqlRow>(`SELECT MAX(updated_at) group_created_at,MAX(last_delivery_at) delivered_at,
      ARRAY_AGG(id ORDER BY store_id) job_ids,ARRAY_AGG(store_id ORDER BY store_id) store_ids,
      ARRAY_AGG(run_id ORDER BY store_id) run_ids,ARRAY_AGG(publication_id ORDER BY store_id) publication_ids
      FROM wb_auto_publish_jobs WHERE sku=$1`, [sku]);
    const manualAt = manual.rows[0]?.group_created_at ? Date.parse(manual.rows[0].group_created_at) : 0;
    const autoAt = auto.rows[0]?.group_created_at ? Date.parse(auto.rows[0].group_created_at) : 0;
    if (!manualAt && !autoAt) return undefined;
    if (manualAt >= autoAt) {
      const row = manual.rows[0]!;
      const snapshot = parseObject(row.config_snapshot);
      const publications = await this.query<SqlRow>(`SELECT store_id,id FROM wb_store_publications
        WHERE sku=$1 AND source='MANUAL' AND plan_hash=$2 ORDER BY store_id`, [sku, row.plan_hash]);
      const expectedStoreIds = Array.isArray(snapshot.planStoreIds) && snapshot.planStoreIds.length
        ? snapshot.planStoreIds.map(String).sort()
        : publications.rows.map((publication) => String(publication.store_id)).sort();
      const draftVersion = Number(snapshot.draftVersion || 0) || Number((await this.query<SqlRow>(
        'SELECT draft_version FROM wb_listing_drafts WHERE sku=$1', [sku]
      )).rows[0]?.draft_version || 0);
      return {
        sku,
        source: 'MANUAL',
        groupCreatedAt: new Date(row.group_created_at).toISOString(),
        ...(row.completed_at ? { completedAt: new Date(row.completed_at).toISOString() } : {}),
        expectedStoreIds,
        planHash: String(row.plan_hash),
        draftVersion,
        targets: publications.rows.map((publication) => ({ storeId: String(publication.store_id), publicationId: String(publication.id) }))
      };
    }
    const row = auto.rows[0]!;
    const storeIds = Array.isArray(row.store_ids) ? row.store_ids.map(String) : [];
    const jobIds = Array.isArray(row.job_ids) ? row.job_ids.map(String) : [];
    const runIds = Array.isArray(row.run_ids) ? row.run_ids.map(String) : [];
    const publicationIds = Array.isArray(row.publication_ids) ? row.publication_ids.map((value: unknown) => value ? String(value) : undefined) : [];
    const deliveredAt = row.delivered_at ? new Date(row.delivered_at).toISOString() : new Date(row.group_created_at).toISOString();
    const mediaBatchId = `historical:${sku}:${deliveredAt}`;
    const completed = await this.query<SqlRow>(`SELECT MAX(completed_at) completed_at FROM wb_store_publications
      WHERE sku=$1 AND source='AUTOMATION'`, [sku]);
    return {
      sku,
      source: 'AUTOMATION',
      groupCreatedAt: new Date(row.group_created_at).toISOString(),
      ...(completed.rows[0]?.completed_at ? { completedAt: new Date(completed.rows[0].completed_at).toISOString() } : {}),
      expectedStoreIds: [...storeIds].sort(),
      mediaBatchId,
      deliveredAt,
      targets: storeIds.map((storeId, index) => ({
        storeId,
        automationJobId: jobIds[index],
        automationRunId: runIds[index],
        publicationId: publicationIds[index]
      }))
    };
  }

  async claimDue(owner: string, limit = 10, leaseMs = 60_000): Promise<WbSourceMediaCleanupBatch[]> {
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    return this.transaction(async (client) => {
      const result = await client.query<SqlRow>(`WITH due AS (
        SELECT id FROM wb_source_media_cleanup_batches
        WHERE status IN ('PENDING','RETRY_WAIT','QUARANTINED') AND next_attempt_at<=NOW()
          AND (lease_expires_at IS NULL OR lease_expires_at<=NOW())
        ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT $1
      ) UPDATE wb_source_media_cleanup_batches batch SET lease_owner=$2,lease_token=gen_random_uuid(),
        lease_expires_at=NOW()+($3::text||' milliseconds')::interval,row_version=row_version+1,updated_at=NOW()
        FROM due WHERE batch.id=due.id RETURNING batch.*`, [safeLimit, owner, Math.max(5_000, Math.trunc(leaseMs))]);
      return result.rows.map(toBatch);
    });
  }

  async targets(cleanupId: string): Promise<WbSourceMediaCleanupTarget[]> {
    const result = await this.query<SqlRow>(`SELECT target.cleanup_id,target.store_id,publication.id publication_id,
      publication.source publication_source,publication.status publication_status,publication.task_id publication_task_id,
      publication.plan_hash publication_plan_hash,
      publication.package_signature publication_package_signature,publication.materialization_hash publication_materialization_hash,
      target.automation_job_id,target.automation_run_id,auto.state automation_state,
      runtime.task_id runtime_task_id,runtime.state runtime_state,runtime.work_relpath runtime_work_relpath,
      runtime.publication_id runtime_publication_id
      FROM wb_source_media_cleanup_targets target
      LEFT JOIN wb_auto_publish_jobs auto ON auto.id=target.automation_job_id AND auto.run_id=target.automation_run_id
      LEFT JOIN wb_store_publications publication ON publication.id=COALESCE(target.publication_id,auto.publication_id)
        AND publication.store_id=target.store_id
      LEFT JOIN wb_publish_jobs runtime ON runtime.publication_id=publication.id AND runtime.task_id=publication.task_id
      WHERE target.cleanup_id=$1 ORDER BY target.store_id`, [cleanupId]);
    return result.rows.map(toTarget);
  }

  async hasNewerOrActiveWork(batch: WbSourceMediaCleanupBatch): Promise<{ blocked: boolean; reasons: string[] }> {
    const result = await this.query<SqlRow>(`SELECT
      EXISTS(SELECT 1 FROM wb_source_media_cleanup_batches newer
        WHERE newer.sku=$1 AND newer.id<>$3 AND newer.created_at>$2 AND newer.status<>'SUPERSEDED') newer_batch,
      EXISTS(SELECT 1 FROM wb_source_media_cleanup_batches active_cleanup
        WHERE active_cleanup.sku=$1 AND active_cleanup.id<>$3
          AND active_cleanup.status IN ('PENDING','RETRY_WAIT','QUARANTINED')) active_cleanup,
      EXISTS(SELECT 1 FROM wb_store_publications publication
        WHERE publication.sku=$1 AND publication.created_at>$2
          AND publication.status IN ('PLANNED','DISPATCHING','QUEUED','RUNNING','FAILED','NEEDS_ATTENTION','PAUSED')) active_publication,
      EXISTS(SELECT 1 FROM wb_auto_publish_jobs auto
        WHERE auto.sku=$1 AND auto.updated_at>$2
          AND auto.state NOT IN ('SUCCEEDED','CANCELLED','BLOCKED_EXISTING_CARD')) active_auto,
      (SELECT draft_version FROM wb_listing_drafts WHERE sku=$1) current_draft_version`, [batch.sku, batch.createdAt, batch.id]);
    const row = result.rows[0] || {};
    const reasons: string[] = [];
    if (row.newer_batch) reasons.push('NEWER_MEDIA_BATCH');
    if (row.active_cleanup) reasons.push('ACTIVE_CLEANUP_BATCH');
    if (row.active_publication) reasons.push('NEWER_OR_ACTIVE_PUBLICATION');
    if (row.active_auto) reasons.push('NEWER_OR_ACTIVE_AUTOMATION');
    if (batch.source === 'MANUAL' && Number(row.current_draft_version || 0) !== batch.draftVersion) reasons.push('DRAFT_VERSION_CHANGED');
    return { blocked: reasons.length > 0, reasons };
  }

  async releaseWaiting(batch: WbSourceMediaCleanupBatch, delayMs = 5_000): Promise<void> {
    await this.cas(batch, `UPDATE wb_source_media_cleanup_batches SET next_attempt_at=NOW()+($4::text||' milliseconds')::interval,
      lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,row_version=row_version+1,updated_at=NOW()
      WHERE id=$1 AND row_version=$2 AND lease_token=$3`, [Math.max(1_000, Math.trunc(delayMs))]);
  }

  async markRetry(batch: WbSourceMediaCleanupBatch, code: string, message: string, delayMs: number): Promise<void> {
    await this.cas(batch, `UPDATE wb_source_media_cleanup_batches SET status='RETRY_WAIT',attempt_count=attempt_count+1,
      next_attempt_at=NOW()+($4::text||' milliseconds')::interval,last_error_code=$5,last_error_message=$6,
      lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,row_version=row_version+1,updated_at=NOW()
      WHERE id=$1 AND row_version=$2 AND lease_token=$3`, [Math.max(1_000, Math.trunc(delayMs)), code, message]);
  }

  async markQuarantined(batch: WbSourceMediaCleanupBatch, quarantineRelPath: string): Promise<WbSourceMediaCleanupBatch> {
    const result = await this.query<SqlRow>(`UPDATE wb_source_media_cleanup_batches SET status='QUARANTINED',quarantine_rel_path=$4,
      next_attempt_at=NOW(),last_error_code='',last_error_message='',row_version=row_version+1,updated_at=NOW()
      WHERE id=$1 AND row_version=$2 AND lease_token=$3 RETURNING *`, [batch.id, batch.rowVersion, batch.leaseToken, quarantineRelPath]);
    if (!result.rows[0]) throw new AppError('VERSION_CONFLICT', 'WB 来源媒体清理批次已被其他 worker 更新', { cleanupId: batch.id }, 409);
    return toBatch(result.rows[0]);
  }

  async markCleaned(batch: WbSourceMediaCleanupBatch): Promise<WbSourceMediaCleanupBatch> {
    return this.transaction(async (client) => {
      const result = await client.query<SqlRow>(`UPDATE wb_source_media_cleanup_batches SET status='CLEANED',cleaned_at=NOW(),
        next_attempt_at=NOW(),last_error_code='',last_error_message='',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
        row_version=row_version+1,updated_at=NOW() WHERE id=$1 AND row_version=$2 AND lease_token=$3 RETURNING *`,
      [batch.id, batch.rowVersion, batch.leaseToken]);
      if (!result.rows[0]) throw new AppError('VERSION_CONFLICT', 'WB 来源媒体清理批次已被其他 worker 更新', { cleanupId: batch.id }, 409);
      await client.query(`UPDATE wb_listing_drafts SET source_media_state='CLEANED',source_media_cleaned_at=NOW(),updated_at=NOW()
        WHERE sku=$1 AND source_media_cleanup_id=$2`, [batch.sku, batch.id]);
      return toBatch(result.rows[0]);
    });
  }

  async markSuperseded(batch: WbSourceMediaCleanupBatch, code: string, message: string): Promise<void> {
    await this.cas(batch, `UPDATE wb_source_media_cleanup_batches SET status='SUPERSEDED',superseded_at=NOW(),
      last_error_code=$4,last_error_message=$5,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
      row_version=row_version+1,updated_at=NOW() WHERE id=$1 AND row_version=$2 AND lease_token=$3`, [code, message]);
    await this.query(`UPDATE wb_listing_drafts SET source_media_state='AVAILABLE',source_media_cleaned_at=NULL,
      source_media_cleanup_id=NULL,updated_at=NOW() WHERE sku=$1 AND source_media_cleanup_id=$2`, [batch.sku, batch.id]);
  }

  async list(input: { sku?: string; status?: WbSourceMediaCleanupStatus; limit?: number } = {}): Promise<WbSourceMediaCleanupBatch[]> {
    const values: unknown[] = [];
    const clauses: string[] = [];
    if (input.sku) { values.push(input.sku); clauses.push(`sku=$${values.length}`); }
    if (input.status) { values.push(input.status); clauses.push(`status=$${values.length}`); }
    values.push(Math.max(1, Math.min(500, Math.trunc(input.limit || 100))));
    const result = await this.query<SqlRow>(`SELECT * FROM wb_source_media_cleanup_batches
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${values.length}`, values);
    return result.rows.map(toBatch);
  }

  async legacyRootReferenceCounts(isLegacyPath: (value: string) => boolean): Promise<{ databaseConfigured: boolean; batches: number; actionableBatches: number }> {
    if (!this.configured) return { databaseConfigured: false, batches: 0, actionableBatches: 0 };
    const result = await this.query<SqlRow>('SELECT status,root_directory FROM wb_source_media_cleanup_batches');
    const matches = result.rows.filter((row) => isLegacyPath(String(row.root_directory || '')));
    return {
      databaseConfigured: true,
      batches: matches.length,
      actionableBatches: matches.filter((row) => !['CLEANED', 'SUPERSEDED'].includes(String(row.status))).length
    };
  }

  private async cas(batch: WbSourceMediaCleanupBatch, sql: string, values: unknown[]): Promise<void> {
    const result = await this.query(sql, [batch.id, batch.rowVersion, batch.leaseToken, ...values]);
    if (result.rowCount !== 1) throw new AppError('VERSION_CONFLICT', 'WB 来源媒体清理批次已被其他 worker 更新', { cleanupId: batch.id }, 409);
  }

  private query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) { return this.requirePool().query<T>(text, values); }
  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.requirePool().connect();
    try { await client.query('BEGIN'); const value = await operation(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
  private requirePool(): Pool {
    if (!this.pool) throw new AppError('DATABASE_UNAVAILABLE', 'WB 来源媒体清理队列尚未配置 PostgreSQL DATABASE_URL', undefined, 503);
    return this.pool;
  }
}

function assertRegistration(input: WbSourceMediaCleanupRegistration): void {
  if (!/^\d{7}$/.test(input.sku)) throw new AppError('CONFIG_INVALID', 'WB 来源媒体清理 SKU 必须是 7 位数字', { sku: input.sku });
  if (!input.batchKey.trim() || !input.rootDirectory.trim()) throw new AppError('CONFIG_INVALID', 'WB 来源媒体清理批次身份或根目录为空');
  if (!/^sha256:[a-f0-9]{64}$/.test(input.mediaSignature)) throw new AppError('CONFIG_INVALID', 'WB 来源媒体签名无效');
  if (!input.expectedStoreIds.length || uniqueSorted(input.expectedStoreIds).length !== input.expectedStoreIds.length) {
    throw new AppError('CONFIG_INVALID', 'WB 来源媒体清理批次必须冻结唯一的目标店铺集合');
  }
  if (input.source === 'MANUAL' && (!input.planHash || !Number.isInteger(input.draftVersion) || Number(input.draftVersion) < 1)) {
    throw new AppError('CONFIG_INVALID', 'WB 手动媒体清理批次缺少 planHash 或 draftVersion');
  }
  if (input.source === 'AUTOMATION' && (!input.mediaBatchId || !input.deliveredAt)) {
    throw new AppError('CONFIG_INVALID', 'WB 自动媒体清理批次缺少媒体批次身份');
  }
}

function assertSameRegistration(current: WbSourceMediaCleanupBatch, input: WbSourceMediaCleanupRegistration): void {
  const same = current.sku === input.sku && current.source === input.source
    && current.mediaSignature === input.mediaSignature && current.rootDirectory === input.rootDirectory
    && JSON.stringify(current.expectedStoreIds) === JSON.stringify(uniqueSorted(input.expectedStoreIds))
    && (current.planHash || '') === (input.planHash || '') && (current.draftVersion || 0) === (input.draftVersion || 0)
    && (current.mediaBatchId || '') === (input.mediaBatchId || '') && (current.deliveredAt || '') === (input.deliveredAt || '');
  if (!same) throw new AppError('VERSION_CONFLICT', 'WB 来源媒体清理批次幂等身份已存在但冻结内容不同', { batchKey: input.batchKey }, 409);
}

function uniqueSorted(values: string[]): string[] { return [...new Set(values.map(String))].sort(); }

function parseObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : {};
    } catch { return {}; }
  }
  return {};
}

function toBatch(row: SqlRow): WbSourceMediaCleanupBatch {
  return {
    id: String(row.id), sku: String(row.sku), source: row.source, batchKey: String(row.batch_key),
    expectedStoreIds: Array.isArray(row.expected_store_ids) ? row.expected_store_ids.map(String).sort() : [],
    rootDirectory: String(row.root_directory), mediaSignature: String(row.media_signature),
    ...(row.media_batch_id ? { mediaBatchId: String(row.media_batch_id) } : {}),
    ...(row.delivered_at ? { deliveredAt: new Date(row.delivered_at).toISOString() } : {}),
    ...(row.plan_hash ? { planHash: String(row.plan_hash) } : {}),
    ...(row.draft_version ? { draftVersion: Number(row.draft_version) } : {}),
    status: row.status, rowVersion: Number(row.row_version), attemptCount: Number(row.attempt_count),
    nextAttemptAt: new Date(row.next_attempt_at).toISOString(),
    ...(row.lease_owner ? { leaseOwner: String(row.lease_owner) } : {}),
    ...(row.lease_token ? { leaseToken: String(row.lease_token) } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: new Date(row.lease_expires_at).toISOString() } : {}),
    ...(row.quarantine_rel_path ? { quarantineRelPath: String(row.quarantine_rel_path) } : {}),
    ...(row.last_error_code ? { lastErrorCode: String(row.last_error_code) } : {}),
    ...(row.last_error_message ? { lastErrorMessage: String(row.last_error_message) } : {}),
    ...(row.cleaned_at ? { cleanedAt: new Date(row.cleaned_at).toISOString() } : {}),
    ...(row.superseded_at ? { supersededAt: new Date(row.superseded_at).toISOString() } : {}),
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString()
  };
}

function toTarget(row: SqlRow): WbSourceMediaCleanupTarget {
  return {
    cleanupId: String(row.cleanup_id), storeId: String(row.store_id),
    ...(row.publication_id ? { publicationId: String(row.publication_id) } : {}),
    ...(row.publication_source ? { publicationSource: row.publication_source } : {}),
    ...(row.publication_status ? { publicationStatus: String(row.publication_status) } : {}),
    ...(row.publication_task_id ? { publicationTaskId: String(row.publication_task_id) } : {}),
    ...(row.publication_plan_hash ? { publicationPlanHash: String(row.publication_plan_hash) } : {}),
    ...(row.publication_package_signature ? { publicationPackageSignature: String(row.publication_package_signature) } : {}),
    ...(row.publication_materialization_hash ? { publicationMaterializationHash: String(row.publication_materialization_hash) } : {}),
    ...(row.automation_job_id ? { automationJobId: String(row.automation_job_id) } : {}),
    ...(row.automation_run_id ? { automationRunId: String(row.automation_run_id) } : {}),
    ...(row.automation_state ? { automationState: String(row.automation_state) } : {}),
    ...(row.runtime_task_id ? { runtimeTaskId: String(row.runtime_task_id) } : {}),
    ...(row.runtime_state ? { runtimeState: String(row.runtime_state) } : {}),
    ...(row.runtime_work_relpath ? { runtimeWorkRelpath: String(row.runtime_work_relpath) } : {}),
    ...(row.runtime_publication_id ? { runtimePublicationId: String(row.runtime_publication_id) } : {})
  };
}
