import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import {
  AppError,
  type OzonSourceMediaCleanupArtifactKind,
  type OzonSourceMediaCleanupState,
  type OzonSourceMediaCleanupSummary
} from '@n8n-media-review/shared';

type SqlRow = Record<string, any>;

export type OzonSourceMediaCleanupSource = 'MANUAL' | 'AUTOMATION' | 'HISTORICAL';

export type OzonSourceMediaCleanupBatch = {
  id: string;
  generatedVersionId: string;
  sku: string;
  revision: number;
  source: OzonSourceMediaCleanupSource;
  rootDirectory: string;
  materialHash: string;
  sourceMediaIdentityHash: string;
  expectedTargetHash: string;
  expectedTargetCount: number;
  triggerIdentity: Record<string, unknown>;
  state: OzonSourceMediaCleanupState;
  rowVersion: number;
  attemptCount: number;
  nextAttemptAt: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  reclaimedBytes: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  cleanedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type OzonSourceMediaCleanupArtifact = {
  cleanupId: string;
  kind: OzonSourceMediaCleanupArtifactKind;
  state: OzonSourceMediaCleanupState;
  sourceRelPath: string;
  quarantineRelPath?: string;
  directorySignature?: string;
  mediaIdentityHash: string;
  fileCount: number;
  totalBytes: number;
  reclaimedBytes: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  cleanedAt?: string;
  updatedAt: string;
};

export type OzonSourceMediaCleanupTargetRegistration = {
  storeId: string;
  publicationId: string;
  jobId: string;
  taskId: string;
};

export type OzonSourceMediaCleanupRegistration = {
  id?: string;
  generatedVersionId: string;
  sku: string;
  revision: number;
  source: OzonSourceMediaCleanupSource;
  rootDirectory: string;
  materialHash: string;
  sourceMediaIdentityHash: string;
  expectedTargetHash: string;
  triggerIdentity: Record<string, unknown>;
  targets: OzonSourceMediaCleanupTargetRegistration[];
  initialState?: 'WAITING_TARGETS' | 'READY';
};

export type OzonSourceMediaCleanupEvidence = {
  batch: OzonSourceMediaCleanupBatch;
  artifacts: OzonSourceMediaCleanupArtifact[];
  targets: Array<OzonSourceMediaCleanupTargetRegistration & {
    publicationStatus?: string;
    publicationSource?: string;
    publicationPlanHash?: string;
    publicationGeneratedVersionId?: string;
    runtimeState?: string;
    runtimeTaskId?: string;
    runtimeTaskKind?: string;
    runtimeWorkRelPath?: string;
    runtimeDirectoryStage?: string;
    runtimeDirectorySignature?: string;
    runtimeLeaseOwner?: string;
    runtimeLeaseExpiresAt?: string;
  }>;
  versionSnapshot: Record<string, unknown>;
  versionMaterialHash: string;
  versionSourceMediaIdentityHash: string;
  actualPublicationIds: string[];
  activeJobCount: number;
  activeSlotCount: number;
  unsafeGatewayCount: number;
  preparationState?: string;
  preparationTaskKind?: string;
  automaticMediaDecisions: string[];
  newerMediaDeliveryCount: number;
};

const ACTIVE_BATCH_STATES = ['WAITING_TARGETS', 'READY', 'RETRY_WAIT', 'QUARANTINING', 'QUARANTINED'] as const;

export async function ensureOzonSourceMediaCleanupSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS ozon_schema_migrations(
      id TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query(`ALTER TABLE ozon_listing_versions
      ADD COLUMN IF NOT EXISTS source_media_identity_hash TEXT NOT NULL DEFAULT ''`);
    const applied = await client.query("SELECT 1 FROM ozon_schema_migrations WHERE id='019_ozon_source_media_cleanup'");
    if (!applied.rows[0]) {
      await client.query(`CREATE TABLE ozon_source_media_cleanup_batches(
        id UUID PRIMARY KEY,
        generated_version_id UUID NOT NULL UNIQUE REFERENCES ozon_listing_versions(id) ON DELETE RESTRICT,
        sku CHAR(7) NOT NULL REFERENCES products(sku) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK(revision>0),
        source TEXT NOT NULL CHECK(source IN ('MANUAL','AUTOMATION','HISTORICAL')),
        root_directory TEXT NOT NULL,
        material_hash TEXT NOT NULL CHECK(material_hash ~ '^sha256:[a-f0-9]{64}$'),
        source_media_identity_hash TEXT NOT NULL CHECK(source_media_identity_hash ~ '^sha256:[a-f0-9]{64}$'),
        expected_target_hash TEXT NOT NULL CHECK(expected_target_hash ~ '^sha256:[a-f0-9]{64}$'),
        expected_target_count INTEGER NOT NULL CHECK(expected_target_count>0),
        trigger_identity JSONB NOT NULL DEFAULT '{}'::jsonb,
        state TEXT NOT NULL DEFAULT 'WAITING_TARGETS' CHECK(state IN (
          'WAITING_TARGETS','READY','QUARANTINING','QUARANTINED','CLEANED','SUPERSEDED','RETRY_WAIT','BLOCKED'
        )),
        row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        lease_owner TEXT,
        lease_token UUID,
        lease_expires_at TIMESTAMPTZ,
        reclaimed_bytes BIGINT NOT NULL DEFAULT 0 CHECK(reclaimed_bytes>=0),
        last_error_code TEXT NOT NULL DEFAULT '',
        last_error_message TEXT NOT NULL DEFAULT '',
        cleaned_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query(`CREATE TABLE ozon_source_media_cleanup_targets(
        cleanup_id UUID NOT NULL REFERENCES ozon_source_media_cleanup_batches(id) ON DELETE CASCADE,
        store_id UUID NOT NULL REFERENCES ozon_stores(id) ON DELETE RESTRICT,
        publication_id UUID NOT NULL,
        job_id UUID NOT NULL,
        task_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(cleanup_id,store_id),
        UNIQUE(cleanup_id,publication_id),
        UNIQUE(cleanup_id,job_id)
      )`);
      await client.query(`CREATE TABLE ozon_source_media_cleanup_artifacts(
        cleanup_id UUID NOT NULL REFERENCES ozon_source_media_cleanup_batches(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('RAW_INBOX','SHARED_VERSION')),
        state TEXT NOT NULL DEFAULT 'WAITING_TARGETS' CHECK(state IN (
          'WAITING_TARGETS','READY','QUARANTINING','QUARANTINED','CLEANED','SUPERSEDED','RETRY_WAIT','BLOCKED'
        )),
        source_rel_path TEXT NOT NULL,
        quarantine_rel_path TEXT,
        directory_signature TEXT,
        media_identity_hash TEXT NOT NULL CHECK(media_identity_hash ~ '^sha256:[a-f0-9]{64}$'),
        file_count INTEGER NOT NULL DEFAULT 0 CHECK(file_count>=0),
        total_bytes BIGINT NOT NULL DEFAULT 0 CHECK(total_bytes>=0),
        reclaimed_bytes BIGINT NOT NULL DEFAULT 0 CHECK(reclaimed_bytes>=0),
        last_error_code TEXT NOT NULL DEFAULT '',
        last_error_message TEXT NOT NULL DEFAULT '',
        cleaned_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(cleanup_id,kind)
      )`);
      await client.query(`CREATE TABLE ozon_source_media_cleanup_events(
        id BIGSERIAL PRIMARY KEY,
        cleanup_id UUID NOT NULL REFERENCES ozon_source_media_cleanup_batches(id) ON DELETE RESTRICT,
        event_type TEXT NOT NULL,
        artifact_kind TEXT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query(`CREATE INDEX ozon_source_media_cleanup_due
        ON ozon_source_media_cleanup_batches(state,next_attempt_at,lease_expires_at)
        WHERE state IN ('WAITING_TARGETS','READY','RETRY_WAIT','QUARANTINING','QUARANTINED')`);
      await client.query(`CREATE INDEX ozon_source_media_cleanup_sku_created
        ON ozon_source_media_cleanup_batches(sku,created_at DESC)`);
      const historicalVersions = await client.query<SqlRow>(`SELECT id,snapshot FROM ozon_listing_versions
        WHERE source_media_identity_hash='' FOR UPDATE`);
      for (const historical of historicalVersions.rows) {
        const identityHash = sourceMediaIdentityHashFromVersionSnapshot(jsonObject(historical.snapshot));
        if (/^sha256:[a-f0-9]{64}$/.test(identityHash)) {
          await client.query(`UPDATE ozon_listing_versions SET source_media_identity_hash=$2
            WHERE id=$1 AND source_media_identity_hash=''`, [historical.id, identityHash]);
        }
      }
      await client.query("INSERT INTO ozon_schema_migrations(id) VALUES('019_ozon_source_media_cleanup')");
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export class OzonSourceMediaCleanupRepository {
  private pool?: Pool;

  constructor(private readonly connectionString?: string) {}
  get configured(): boolean { return Boolean(this.pool); }

  async initialize(input: { migrate?: boolean } = {}): Promise<void> {
    if (!this.connectionString) return;
    this.pool = new Pool({ connectionString: this.connectionString, max: 4, idleTimeoutMillis: 30_000 });
    try {
      await this.pool.query('SELECT 1');
      if (input.migrate !== false) await ensureOzonSourceMediaCleanupSchema(this.pool);
      else await this.assertSchemaAvailable();
    } catch (error) {
      await this.pool.end().catch(() => undefined);
      this.pool = undefined;
      throw error;
    }
  }

  async close(): Promise<void> { await this.pool?.end(); }

  async getConfiguredRootDirectory(): Promise<string> {
    const result = await this.query<SqlRow>(`SELECT root_directory FROM ozon_system_settings WHERE id='default'`);
    const value = String(result.rows[0]?.root_directory || '').trim();
    if (!value) throw new AppError('CONFIG_INVALID', 'OZON 根目录尚未配置', undefined, 409);
    return value;
  }

  async registerBatch(input: OzonSourceMediaCleanupRegistration): Promise<OzonSourceMediaCleanupBatch> {
    assertRegistration(input);
    return this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`merchroute-ozon-source-cleanup:${input.generatedVersionId}`]);
      const version = await client.query<SqlRow>(`SELECT id,sku,revision,material_hash,source_media_identity_hash,snapshot
        FROM ozon_listing_versions WHERE id=$1 FOR SHARE`, [input.generatedVersionId]);
      const row = version.rows[0];
      if (row && !String(row.source_media_identity_hash || '') && input.source === 'HISTORICAL') {
        const historicalHash = sourceMediaIdentityHashFromVersionSnapshot(jsonObject(row.snapshot));
        if (historicalHash !== input.sourceMediaIdentityHash) {
          throw new AppError('VERSION_CONFLICT', 'OZON 历史稳定版本媒体身份哈希无法重现', {
            generatedVersionId: input.generatedVersionId
          }, 409);
        }
        await client.query(`UPDATE ozon_listing_versions SET source_media_identity_hash=$2
          WHERE id=$1 AND source_media_identity_hash=''`, [input.generatedVersionId, historicalHash]);
        row.source_media_identity_hash = historicalHash;
      }
      if (!row || String(row.sku) !== input.sku || Number(row.revision) !== input.revision
        || String(row.material_hash || '') !== input.materialHash
        || String(row.source_media_identity_hash || '') !== input.sourceMediaIdentityHash) {
        throw new AppError('VERSION_CONFLICT', 'OZON 媒体清理批次与稳定版本身份不一致', {
          generatedVersionId: input.generatedVersionId,
          sku: input.sku
        }, 409);
      }
      const existing = await client.query<SqlRow>(`SELECT * FROM ozon_source_media_cleanup_batches
        WHERE generated_version_id=$1 FOR UPDATE`, [input.generatedVersionId]);
      if (existing.rows[0]) {
        const current = toBatch(existing.rows[0]);
        assertSameRegistration(current, input);
        const targets = await this.targetsWithClient(client, current.id);
        assertSameTargets(targets, input.targets);
        return current;
      }
      const id = input.id || randomUUID();
      const state = input.initialState || 'WAITING_TARGETS';
      const inserted = await client.query<SqlRow>(`INSERT INTO ozon_source_media_cleanup_batches(
        id,generated_version_id,sku,revision,source,root_directory,material_hash,source_media_identity_hash,
        expected_target_hash,expected_target_count,trigger_identity,state
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) RETURNING *`, [
        id, input.generatedVersionId, input.sku, input.revision, input.source, input.rootDirectory,
        input.materialHash, input.sourceMediaIdentityHash, input.expectedTargetHash, input.targets.length,
        JSON.stringify(input.triggerIdentity), state
      ]);
      for (const target of normalizedTargets(input.targets)) {
        await client.query(`INSERT INTO ozon_source_media_cleanup_targets(
          cleanup_id,store_id,publication_id,job_id,task_id
        ) VALUES($1,$2,$3,$4,$5)`, [id, target.storeId, target.publicationId, target.jobId, target.taskId]);
      }
      const artifactState = state === 'READY' ? 'READY' : 'WAITING_TARGETS';
      await client.query(`INSERT INTO ozon_source_media_cleanup_artifacts(
        cleanup_id,kind,state,source_rel_path,media_identity_hash
      ) VALUES
        ($1,'RAW_INBOX',$2,$3,$5),
        ($1,'SHARED_VERSION',$2,$4,$5)`, [
        id, artifactState, `inbox/${input.sku}`, `shared/${input.sku}/${input.generatedVersionId}`,
        input.sourceMediaIdentityHash
      ]);
      await insertEvent(client, id, 'REGISTERED', undefined, {
        source: input.source,
        generatedVersionId: input.generatedVersionId,
        expectedTargetHash: input.expectedTargetHash,
        targetCount: input.targets.length
      });
      return toBatch(inserted.rows[0]!);
    });
  }

  async assertVersionAvailable(generatedVersionId: string): Promise<void> {
    if (!this.pool) return;
    const result = await this.pool.query<SqlRow>(`SELECT id,state FROM ozon_source_media_cleanup_batches
      WHERE generated_version_id=$1 AND state IN ('QUARANTINING','QUARANTINED','CLEANED')`, [generatedVersionId]);
    if (result.rows[0]) {
      throw new AppError('OZON_SOURCE_MEDIA_CLEANED', '该 OZON 稳定版本的公共媒体已清理，请重新投递媒体并生成下一真实 revision', {
        generatedVersionId,
        cleanupId: String(result.rows[0].id),
        cleanupState: String(result.rows[0].state)
      }, 410);
    }
  }

  async getByGeneratedVersion(generatedVersionId: string): Promise<OzonSourceMediaCleanupSummary | undefined> {
    if (!this.pool) return undefined;
    const batch = await this.pool.query<SqlRow>('SELECT * FROM ozon_source_media_cleanup_batches WHERE generated_version_id=$1', [generatedVersionId]);
    if (!batch.rows[0]) return undefined;
    return this.summaryFromRow(batch.rows[0]);
  }

  async get(id: string): Promise<OzonSourceMediaCleanupBatch> {
    const result = await this.query<SqlRow>('SELECT * FROM ozon_source_media_cleanup_batches WHERE id=$1', [id]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'OZON 媒体清理批次不存在', { id }, 404);
    return toBatch(result.rows[0]);
  }

  async evidenceForVersionSnapshot(generatedVersionId: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.query<SqlRow>('SELECT snapshot FROM ozon_listing_versions WHERE id=$1', [generatedVersionId]);
    return result.rows[0] ? jsonObject(result.rows[0].snapshot) : undefined;
  }

  async status(): Promise<{ items: OzonSourceMediaCleanupSummary[]; total: number; reclaimedBytes: number }> {
    const rows = await this.query<SqlRow>('SELECT * FROM ozon_source_media_cleanup_batches ORDER BY created_at DESC,id');
    const items: OzonSourceMediaCleanupSummary[] = [];
    for (const row of rows.rows) items.push(await this.summaryFromRow(row));
    return { items, total: items.length, reclaimedBytes: items.reduce((sum, item) => sum + item.reclaimedBytes, 0) };
  }

  async legacyRootReferenceCounts(isLegacyPath: (value: string) => boolean): Promise<{ databaseConfigured: boolean; batches: number; actionableBatches: number }> {
    if (!this.configured) return { databaseConfigured: false, batches: 0, actionableBatches: 0 };
    const result = await this.query<SqlRow>('SELECT state,root_directory FROM ozon_source_media_cleanup_batches');
    const matches = result.rows.filter((row) => isLegacyPath(String(row.root_directory || '')));
    return {
      databaseConfigured: true,
      batches: matches.length,
      actionableBatches: matches.filter((row) => !['CLEANED', 'SUPERSEDED', 'BLOCKED'].includes(String(row.state))).length
    };
  }

  async claimDue(owner: string, limit = 10): Promise<OzonSourceMediaCleanupBatch[]> {
    const claimed: OzonSourceMediaCleanupBatch[] = [];
    for (let index = 0; index < Math.max(0, Math.min(limit, 100)); index += 1) {
      const item = await this.transaction(async (client) => {
        const selected = await client.query<SqlRow>(`SELECT id FROM ozon_source_media_cleanup_batches
          WHERE state=ANY($1::text[]) AND next_attempt_at<=NOW()
            AND (lease_expires_at IS NULL OR lease_expires_at<=NOW())
          ORDER BY next_attempt_at,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [ACTIVE_BATCH_STATES]);
        if (!selected.rows[0]) return undefined;
        const token = randomUUID();
        const updated = await client.query<SqlRow>(`UPDATE ozon_source_media_cleanup_batches SET
          lease_owner=$2,lease_token=$3,lease_expires_at=NOW()+INTERVAL '5 minutes',
          attempt_count=attempt_count+1,row_version=row_version+1,updated_at=NOW()
          WHERE id=$1 RETURNING *`, [selected.rows[0].id, owner, token]);
        return toBatch(updated.rows[0]!);
      });
      if (!item) break;
      claimed.push(item);
    }
    return claimed;
  }

  async claimById(id: string, owner: string): Promise<OzonSourceMediaCleanupBatch> {
    return this.transaction(async (client) => {
      const token = randomUUID();
      const result = await client.query<SqlRow>(`UPDATE ozon_source_media_cleanup_batches SET
          lease_owner=$2,lease_token=$3,lease_expires_at=NOW()+INTERVAL '5 minutes',
          attempt_count=attempt_count+1,row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 AND state=ANY($4::text[]) AND next_attempt_at<=NOW()
          AND (lease_expires_at IS NULL OR lease_expires_at<=NOW()) RETURNING *`, [id, owner, token, ACTIVE_BATCH_STATES]);
      if (!result.rows[0]) throw new AppError('TASK_LOCKED', 'OZON 媒体清理批次当前不可认领', { id }, 409);
      return toBatch(result.rows[0]);
    });
  }

  async withSkuAdvisoryLock<T>(sku: string, operation: () => Promise<T>): Promise<T> {
    if (!/^\d{7}$/.test(sku)) throw new AppError('CONFIG_INVALID', 'OZON 媒体清理 SKU 无效', { sku }, 409);
    const client = await this.requirePool().connect();
    const key = `merchroute-ozon-source-cleanup-sku:${sku}`;
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
      return await operation();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => undefined);
      client.release();
    }
  }

  async evidence(id: string): Promise<OzonSourceMediaCleanupEvidence> {
    return this.transaction(async (client) => {
      const batchResult = await client.query<SqlRow>('SELECT * FROM ozon_source_media_cleanup_batches WHERE id=$1', [id]);
      if (!batchResult.rows[0]) throw new AppError('NOT_FOUND', 'OZON 媒体清理批次不存在', { id }, 404);
      const batch = toBatch(batchResult.rows[0]);
      const artifactRows = await client.query<SqlRow>('SELECT * FROM ozon_source_media_cleanup_artifacts WHERE cleanup_id=$1 ORDER BY kind', [id]);
      const targetRows = await client.query<SqlRow>(`SELECT target.*,
          p.status publication_status,p.source publication_source,p.plan_hash publication_plan_hash,
          p.generated_version_id publication_generated_version_id,
          j.state runtime_state,j.task_id runtime_task_id,j.task_kind runtime_task_kind,
          j.work_rel_path runtime_work_rel_path,j.directory_stage runtime_directory_stage,
          j.directory_signature runtime_directory_signature,j.lease_owner runtime_lease_owner,
          j.lease_expires_at runtime_lease_expires_at
        FROM ozon_source_media_cleanup_targets target
        LEFT JOIN ozon_store_publications p ON p.id=target.publication_id
        LEFT JOIN ozon_publish_jobs j ON j.id=target.job_id
        WHERE target.cleanup_id=$1 ORDER BY target.store_id`, [id]);
      const version = await client.query<SqlRow>(`SELECT snapshot,material_hash,source_media_identity_hash
        FROM ozon_listing_versions WHERE id=$1`, [batch.generatedVersionId]);
      const versionSnapshot = jsonObject(version.rows[0]?.snapshot);
      const sharedMaterial = jsonObject(versionSnapshot.sharedMaterial);
      const frozenAssets = Array.isArray(sharedMaterial.mediaAssets) ? sharedMaterial.mediaAssets.map(jsonObject) : [];
      const frozenSubmissionIds = [...new Set(frozenAssets.map((asset) => String(asset.sourceSubmissionId || '')).filter(Boolean))];
      const deliveredTimes = frozenAssets.map((asset) => Date.parse(String(asset.deliveredAt || ''))).filter(Number.isFinite);
      const latestFrozenDelivery = deliveredTimes.length ? new Date(Math.max(...deliveredTimes)).toISOString() : undefined;
      const newerDeliveries = latestFrozenDelivery
        ? await client.query<{ count: string }>(`SELECT COUNT(*) count FROM ozon_media_deliveries
            WHERE sku=$1 AND received_at>$2::timestamptz
              AND NOT (submission_id=ANY($3::text[]))`, [batch.sku, latestFrozenDelivery, frozenSubmissionIds])
        : { rows: [{ count: '0' }] };
      const actualPublications = await client.query<SqlRow>(`SELECT id FROM ozon_store_publications
        WHERE generated_version_id=$1 ORDER BY id`, [batch.generatedVersionId]);
      const activeJobs = await client.query<{ count: string }>(`SELECT COUNT(*) count FROM ozon_publish_jobs j
        JOIN ozon_store_publications p ON p.id=j.publication_id
        WHERE p.generated_version_id=$1 AND j.state IN (
          'WAITING_MEDIA','READY','UPLOADING_MEDIA','SUBMITTING','IMPORTING','VERIFYING_IMAGES',
          'UPDATING_PRICE','UPDATING_STOCK','MODERATING','RETRY_WAIT'
        )`, [batch.generatedVersionId]);
      const activeSlots = await client.query<{ count: string }>(`SELECT COUNT(*) count FROM ozon_publish_slots slot
        JOIN ozon_publish_jobs j ON j.id=slot.job_id
        JOIN ozon_store_publications p ON p.id=j.publication_id
        WHERE p.generated_version_id=$1 AND slot.lease_expires_at>NOW()`, [batch.generatedVersionId]);
      const unsafeGateway = await client.query<{ count: string }>(`SELECT COUNT(*) count
        FROM ozon_gateway_requests g JOIN ozon_store_publications p ON p.id=g.publication_id
        WHERE p.generated_version_id=$1 AND (
          g.delivery_state='UNKNOWN' OR g.retry_class='UNKNOWN' OR g.delegation_state='READBACK_REQUIRED'
        )`, [batch.generatedVersionId]);
      const preparationJobId = String(batch.triggerIdentity.preparationJobId || '');
      const preparation = preparationJobId
        ? await client.query<SqlRow>('SELECT state,task_kind FROM ozon_publish_jobs WHERE id=$1', [preparationJobId])
        : { rows: [] as SqlRow[] };
      const deliveries = preparationJobId
        ? await client.query<SqlRow>(`SELECT COALESCE(payload->>'autoPublishDecision','') decision
            FROM ozon_media_deliveries WHERE job_id=$1 ORDER BY source_stage_id,submission_id,variant_id`, [preparationJobId])
        : { rows: [] as SqlRow[] };
      return {
        batch,
        artifacts: artifactRows.rows.map(toArtifact),
        targets: targetRows.rows.map(toEvidenceTarget),
        versionSnapshot,
        versionMaterialHash: String(version.rows[0]?.material_hash || ''),
        versionSourceMediaIdentityHash: String(version.rows[0]?.source_media_identity_hash || ''),
        actualPublicationIds: actualPublications.rows.map((row) => String(row.id)),
        activeJobCount: Number(activeJobs.rows[0]?.count || 0),
        activeSlotCount: Number(activeSlots.rows[0]?.count || 0),
        unsafeGatewayCount: Number(unsafeGateway.rows[0]?.count || 0),
        ...(preparation.rows[0] ? {
          preparationState: String(preparation.rows[0].state || ''),
          preparationTaskKind: String(preparation.rows[0].task_kind || '')
        } : {}),
        automaticMediaDecisions: deliveries.rows.map((row) => String(row.decision || '')),
        newerMediaDeliveryCount: Number(newerDeliveries.rows[0]?.count || 0)
      };
    });
  }

  async markArtifactState(input: {
    cleanupId: string;
    leaseToken: string;
    kind: OzonSourceMediaCleanupArtifactKind;
    expected: OzonSourceMediaCleanupState[];
    state: OzonSourceMediaCleanupState;
    quarantineRelPath?: string;
    directorySignature?: string;
    fileCount?: number;
    totalBytes?: number;
    reclaimedBytes?: number;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<OzonSourceMediaCleanupArtifact> {
    return this.transaction(async (client) => {
      const updated = await client.query<SqlRow>(`UPDATE ozon_source_media_cleanup_artifacts artifact SET
          state=$5,
          quarantine_rel_path=COALESCE($6,artifact.quarantine_rel_path),
          directory_signature=COALESCE($7,artifact.directory_signature),
          file_count=COALESCE($8,artifact.file_count),total_bytes=COALESCE($9,artifact.total_bytes),
          reclaimed_bytes=COALESCE($10,artifact.reclaimed_bytes),
          last_error_code=COALESCE($11,''),last_error_message=COALESCE($12,''),
          cleaned_at=CASE WHEN $5 IN ('CLEANED','SUPERSEDED') THEN NOW() ELSE artifact.cleaned_at END,
          updated_at=NOW()
        FROM ozon_source_media_cleanup_batches batch
        WHERE artifact.cleanup_id=batch.id AND artifact.cleanup_id=$1 AND artifact.kind=$2
          AND artifact.state=ANY($3::text[]) AND batch.lease_token=$4::uuid AND batch.lease_expires_at>NOW()
        RETURNING artifact.*`, [
        input.cleanupId, input.kind, input.expected, input.leaseToken, input.state,
        input.quarantineRelPath || null, input.directorySignature || null,
        input.fileCount ?? null, input.totalBytes ?? null, input.reclaimedBytes ?? null,
        input.errorCode ?? null, input.errorMessage ?? null
      ]);
      if (!updated.rows[0]) {
        throw new AppError('VERSION_CONFLICT', 'OZON 媒体清理 artifact 状态已变化或 lease 失效', {
          cleanupId: input.cleanupId,
          kind: input.kind,
          expected: input.expected
        }, 409);
      }
      await client.query(`UPDATE ozon_source_media_cleanup_batches SET state=$3,row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 AND lease_token=$2::uuid`, [
        input.cleanupId,
        input.leaseToken,
        ['CLEANED', 'SUPERSEDED'].includes(input.state) ? 'READY' : input.state
      ]);
      await insertEvent(client, input.cleanupId, `ARTIFACT_${input.state}`, input.kind, {
        directorySignature: input.directorySignature,
        totalBytes: input.totalBytes,
        reclaimedBytes: input.reclaimedBytes,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage
      });
      return toArtifact(updated.rows[0]);
    });
  }

  async releaseWaiting(batch: OzonSourceMediaCleanupBatch, reasons: string[], delaySeconds = 60): Promise<void> {
    await this.release(batch, 'WAITING_TARGETS', 'OZON_SOURCE_MEDIA_NOT_READY', reasons.join(','), delaySeconds);
  }

  async retry(batch: OzonSourceMediaCleanupBatch, code: string, message: string, delaySeconds: number): Promise<void> {
    await this.release(batch, 'RETRY_WAIT', code, message, delaySeconds);
  }

  async block(batch: OzonSourceMediaCleanupBatch, code: string, message: string): Promise<void> {
    await this.release(batch, 'BLOCKED', code, message, 0);
  }

  async finalize(batch: OzonSourceMediaCleanupBatch): Promise<OzonSourceMediaCleanupSummary> {
    return this.transaction(async (client) => {
      const artifacts = await client.query<SqlRow>('SELECT * FROM ozon_source_media_cleanup_artifacts WHERE cleanup_id=$1 FOR UPDATE', [batch.id]);
      const parsed = artifacts.rows.map(toArtifact);
      if (parsed.length !== 2 || parsed.some((item) => !['CLEANED', 'SUPERSEDED'].includes(item.state))) {
        throw new AppError('VERSION_CONFLICT', 'OZON 媒体清理 artifact 尚未全部进入安全终态', { cleanupId: batch.id }, 409);
      }
      const reclaimed = parsed.reduce((sum, item) => sum + item.reclaimedBytes, 0);
      const updated = await client.query<SqlRow>(`UPDATE ozon_source_media_cleanup_batches SET
          state='CLEANED',reclaimed_bytes=$3,cleaned_at=NOW(),lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
          last_error_code='',last_error_message='',row_version=row_version+1,updated_at=NOW()
        WHERE id=$1 AND lease_token=$2::uuid RETURNING *`, [batch.id, batch.leaseToken, reclaimed]);
      if (!updated.rows[0]) throw new AppError('VERSION_CONFLICT', 'OZON 媒体清理完成提交时 lease 已失效', { cleanupId: batch.id }, 409);
      await insertEvent(client, batch.id, 'CLEANED', undefined, { reclaimedBytes: reclaimed });
      return this.summaryFromRowWithClient(client, updated.rows[0]);
    });
  }

  async listHistoricalGroups(skus?: string[]): Promise<Array<{
    generatedVersionId: string;
    sku: string;
    revision: number;
    materialHash: string;
    sourceMediaIdentityHash: string;
    source: 'MANUAL' | 'AUTOMATION';
    preparationJobId?: string;
    targets: OzonSourceMediaCleanupEvidence['targets'];
    databaseReasons: string[];
  }>> {
    const result = await this.query<SqlRow>(`SELECT v.id generated_version_id,v.sku,v.revision,v.material_hash,
        v.source_media_identity_hash,MIN(p.source) publication_source,
        COUNT(DISTINCT p.source) publication_source_count,
        MIN(p.preparation_job_id::text) preparation_job_id
      FROM ozon_listing_versions v
      JOIN ozon_store_publications p ON p.generated_version_id=v.id
      WHERE ($1::text[] IS NULL OR v.sku=ANY($1::text[]))
        AND NOT EXISTS(SELECT 1 FROM ozon_source_media_cleanup_batches c WHERE c.generated_version_id=v.id)
      GROUP BY v.id,v.sku,v.revision,v.material_hash,v.source_media_identity_hash
      ORDER BY v.sku,v.revision`, [skus?.length ? skus : null]);
    const output: Array<{
      generatedVersionId: string; sku: string; revision: number; materialHash: string;
      sourceMediaIdentityHash: string; source: 'MANUAL' | 'AUTOMATION'; preparationJobId?: string;
      targets: OzonSourceMediaCleanupEvidence['targets']; databaseReasons: string[];
    }> = [];
    for (const row of result.rows) {
      const generatedVersionId = String(row.generated_version_id);
      const source = row.publication_source === 'AUTOMATION' ? 'AUTOMATION' : 'MANUAL';
      const readiness = await this.historicalReadiness(generatedVersionId, source);
      const databaseReasons = [...readiness.reasons];
      if (Number(row.publication_source_count || 0) !== 1) databaseReasons.push('PUBLICATION_SOURCE_MISMATCH');
      output.push({
        generatedVersionId,
        sku: String(row.sku),
        revision: Number(row.revision),
        materialHash: String(row.material_hash || ''),
        sourceMediaIdentityHash: String(row.source_media_identity_hash || ''),
        source,
        ...(row.preparation_job_id ? { preparationJobId: String(row.preparation_job_id) } : {}),
        targets: readiness.targets,
        databaseReasons: [...new Set(databaseReasons)]
      });
    }
    return output;
  }

  private async historicalReadiness(
    generatedVersionId: string,
    source: 'MANUAL' | 'AUTOMATION'
  ): Promise<{ targets: OzonSourceMediaCleanupEvidence['targets']; reasons: string[] }> {
    const publicationRows = await this.query<SqlRow>(`SELECT
        p.store_id,p.id publication_id,p.status publication_status,p.source publication_source,
        p.plan_hash publication_plan_hash,p.generated_version_id publication_generated_version_id,
        p.preparation_job_id,
        j.id job_id,j.state runtime_state,j.task_id runtime_task_id,j.task_kind runtime_task_kind,
        j.work_rel_path runtime_work_rel_path,j.directory_stage runtime_directory_stage,
        j.directory_signature runtime_directory_signature,j.lease_owner runtime_lease_owner,
        j.lease_expires_at runtime_lease_expires_at
      FROM ozon_store_publications p
      LEFT JOIN ozon_publish_jobs j ON j.id=p.planned_job_id AND j.publication_id=p.id
      WHERE p.generated_version_id=$1 ORDER BY p.store_id,p.id`, [generatedVersionId]);
    const targets = publicationRows.rows.map((row) => toEvidenceTarget({
      ...row,
      cleanup_id: '',
      publication_id: row.publication_id,
      job_id: row.job_id,
      task_id: row.runtime_task_id
    }));
    const reasons: string[] = [];
    if (!targets.length) reasons.push('TARGET_SET_EMPTY');
    for (const target of targets) {
      if (!target.jobId || !target.taskId) reasons.push(`TARGET_IDENTITY_INCOMPLETE:${target.storeId}`);
      if (target.publicationStatus !== 'SUCCEEDED') reasons.push(`PUBLICATION_${target.publicationStatus || 'MISSING'}:${target.storeId}`);
      if (target.runtimeState !== 'SUCCEEDED') reasons.push(`JOB_${target.runtimeState || 'MISSING'}:${target.storeId}`);
      if (target.runtimeTaskKind !== 'STORE_PUBLICATION') reasons.push(`TASK_KIND_MISMATCH:${target.storeId}`);
      if (target.runtimeTaskId !== target.taskId) reasons.push(`TASK_ID_MISMATCH:${target.storeId}`);
      if (target.runtimeDirectoryStage !== 'SUCCESS' || !target.runtimeWorkRelPath?.match(/^success\/\d{4}-\d{2}-\d{2}\//)) {
        reasons.push(`SUCCESS_ARCHIVE_MISSING:${target.storeId}`);
      }
      if (!target.runtimeDirectorySignature) reasons.push(`DIRECTORY_SIGNATURE_MISSING:${target.storeId}`);
      if (target.runtimeLeaseOwner || (target.runtimeLeaseExpiresAt && Date.parse(target.runtimeLeaseExpiresAt) > Date.now())) {
        reasons.push(`LEASE_ACTIVE:${target.storeId}`);
      }
    }
    const counts = await this.query<SqlRow>(`SELECT
        (SELECT COUNT(*) FROM ozon_publish_jobs j JOIN ozon_store_publications p ON p.id=j.publication_id
          WHERE p.generated_version_id=$1 AND j.state IN (
            'WAITING_MEDIA','READY','UPLOADING_MEDIA','SUBMITTING','IMPORTING','VERIFYING_IMAGES',
            'UPDATING_PRICE','UPDATING_STOCK','MODERATING','RETRY_WAIT')) active_jobs,
        (SELECT COUNT(*) FROM ozon_publish_slots slot
          JOIN ozon_publish_jobs j ON j.id=slot.job_id
          JOIN ozon_store_publications p ON p.id=j.publication_id
          WHERE p.generated_version_id=$1 AND slot.lease_expires_at>NOW()) active_slots,
        (SELECT COUNT(*) FROM ozon_gateway_requests g JOIN ozon_store_publications p ON p.id=g.publication_id
          WHERE p.generated_version_id=$1 AND (
            g.delivery_state='UNKNOWN' OR g.retry_class='UNKNOWN' OR g.delegation_state='READBACK_REQUIRED')) unsafe_gateway`,
    [generatedVersionId]);
    if (Number(counts.rows[0]?.active_jobs || 0) > 0) reasons.push('ACTIVE_JOB_PRESENT');
    if (Number(counts.rows[0]?.active_slots || 0) > 0) reasons.push('ACTIVE_SLOT_PRESENT');
    if (Number(counts.rows[0]?.unsafe_gateway || 0) > 0) reasons.push('REMOTE_STATE_UNPROVEN');
    if (source === 'AUTOMATION') {
      const preparationIds = [...new Set(publicationRows.rows.map((row) => String(row.preparation_job_id || '')).filter(Boolean))];
      if (preparationIds.length !== 1) reasons.push('PREPARATION_IDENTITY_MISMATCH');
      else {
        const preparation = await this.query<SqlRow>('SELECT state,task_kind FROM ozon_publish_jobs WHERE id=$1', [preparationIds[0]]);
        if (preparation.rows[0]?.state !== 'SUCCEEDED' || preparation.rows[0]?.task_kind !== 'SHARED_PREPARATION') {
          reasons.push('PREPARATION_NOT_SUCCEEDED');
        }
        const media = await this.query<SqlRow>(`SELECT COALESCE(payload->>'autoPublishDecision','') decision
          FROM ozon_media_deliveries WHERE job_id=$1`, [preparationIds[0]]);
        if (!media.rows.length || media.rows.some((row) => row.decision !== 'FANNED_OUT')) reasons.push('MEDIA_NOT_FANNED_OUT');
      }
    }
    return { targets, reasons: [...new Set(reasons)] };
  }

  private async release(
    batch: OzonSourceMediaCleanupBatch,
    state: OzonSourceMediaCleanupState,
    code: string,
    message: string,
    delaySeconds: number
  ): Promise<void> {
    const result = await this.query(`UPDATE ozon_source_media_cleanup_batches SET state=$3,
      next_attempt_at=NOW()+($4::text||' seconds')::interval,last_error_code=$5,last_error_message=$6,
      lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,row_version=row_version+1,updated_at=NOW()
      WHERE id=$1 AND lease_token=$2::uuid`, [batch.id, batch.leaseToken, state, Math.max(0, delaySeconds), code, message]);
    if (result.rowCount !== 1) throw new AppError('VERSION_CONFLICT', 'OZON 媒体清理 lease 已变化', { cleanupId: batch.id }, 409);
    await this.query(`INSERT INTO ozon_source_media_cleanup_events(cleanup_id,event_type,details)
      VALUES($1,$2,$3::jsonb)`, [batch.id, state, JSON.stringify({ code, message })]);
  }

  private async summaryFromRow(row: SqlRow): Promise<OzonSourceMediaCleanupSummary> {
    return this.summaryFromRowWithClient(this.requirePool(), row);
  }

  private async summaryFromRowWithClient(client: Pick<Pool, 'query'> | PoolClient, row: SqlRow): Promise<OzonSourceMediaCleanupSummary> {
    const artifacts = await client.query<SqlRow>('SELECT * FROM ozon_source_media_cleanup_artifacts WHERE cleanup_id=$1 ORDER BY kind', [row.id]);
    const batch = toBatch(row);
    return {
      cleanupId: batch.id,
      generatedVersionId: batch.generatedVersionId,
      sku: batch.sku,
      revision: batch.revision,
      source: batch.source,
      state: batch.state,
      targetStoreCount: batch.expectedTargetCount,
      reclaimedBytes: batch.reclaimedBytes,
      artifacts: artifacts.rows.map((value) => {
        const artifact = toArtifact(value);
        return {
          kind: artifact.kind,
          state: artifact.state,
          sourceRelPath: artifact.sourceRelPath,
          ...(artifact.quarantineRelPath ? { quarantineRelPath: artifact.quarantineRelPath } : {}),
          ...(artifact.directorySignature ? { directorySignature: artifact.directorySignature } : {}),
          mediaIdentityHash: artifact.mediaIdentityHash,
          fileCount: artifact.fileCount,
          totalBytes: artifact.totalBytes,
          reclaimedBytes: artifact.reclaimedBytes,
          ...(artifact.cleanedAt ? { cleanedAt: artifact.cleanedAt } : {}),
          ...(artifact.lastErrorMessage ? { blockedReason: artifact.lastErrorMessage } : {})
        };
      }),
      ...(batch.lastErrorMessage ? { blockedReason: batch.lastErrorMessage } : {}),
      ...(batch.cleanedAt ? { cleanedAt: batch.cleanedAt } : {}),
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt
    };
  }

  private async targetsWithClient(client: PoolClient, cleanupId: string): Promise<OzonSourceMediaCleanupTargetRegistration[]> {
    const result = await client.query<SqlRow>(`SELECT store_id,publication_id,job_id,task_id
      FROM ozon_source_media_cleanup_targets WHERE cleanup_id=$1 ORDER BY store_id`, [cleanupId]);
    return result.rows.map((row) => ({
      storeId: String(row.store_id), publicationId: String(row.publication_id),
      jobId: String(row.job_id), taskId: String(row.task_id)
    }));
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.requirePool().connect();
    try {
      await client.query('BEGIN');
      const value = await operation(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private query<T extends Record<string, any> = Record<string, any>>(text: string, values: unknown[] = []) {
    return this.requirePool().query<T>(text, values);
  }

  private requirePool(): Pool {
    if (!this.pool) throw new AppError('DB_UNAVAILABLE', 'OZON 媒体清理数据库未配置', undefined, 503);
    return this.pool;
  }

  private async assertSchemaAvailable(): Promise<void> {
    const result = await this.requirePool().query<{ migration: string | null; batches: string | null }>(`SELECT
      to_regclass('ozon_schema_migrations')::text migration,
      to_regclass('ozon_source_media_cleanup_batches')::text batches`);
    if (!result.rows[0]?.migration || !result.rows[0]?.batches) {
      throw new AppError('DB_UNAVAILABLE', 'OZON 媒体清理迁移 019 尚未部署，CLI 不会隐式修改数据库', undefined, 503);
    }
    const applied = await this.requirePool().query(`SELECT 1 FROM ozon_schema_migrations
      WHERE id='019_ozon_source_media_cleanup'`);
    if (!applied.rows[0]) {
      throw new AppError('DB_UNAVAILABLE', 'OZON 媒体清理迁移 019 尚未完成，CLI 已停止', undefined, 503);
    }
  }
}

function assertRegistration(input: OzonSourceMediaCleanupRegistration): void {
  if (!/^\d{7}$/.test(input.sku) || !/^[0-9a-f-]{36}$/i.test(input.generatedVersionId)
    || !/^sha256:[a-f0-9]{64}$/.test(input.materialHash)
    || !/^sha256:[a-f0-9]{64}$/.test(input.sourceMediaIdentityHash)
    || !/^sha256:[a-f0-9]{64}$/.test(input.expectedTargetHash)
    || !Number.isInteger(input.revision) || input.revision < 1 || !input.targets.length
    || !String(input.rootDirectory || '').trim()) {
    throw new AppError('CONFIG_INVALID', 'OZON 媒体清理批次冻结合同无效', { sku: input.sku }, 409);
  }
  const targets = normalizedTargets(input.targets);
  if (targets.some((target) => !target.storeId || !target.publicationId || !target.jobId || !target.taskId)
    || new Set(targets.map((target) => target.storeId)).size !== targets.length
    || new Set(targets.map((target) => target.publicationId)).size !== targets.length
    || new Set(targets.map((target) => target.jobId)).size !== targets.length) {
    throw new AppError('CONFIG_INVALID', 'OZON 媒体清理批次目标身份不完整或重复', { sku: input.sku }, 409);
  }
}

function assertSameRegistration(current: OzonSourceMediaCleanupBatch, input: OzonSourceMediaCleanupRegistration): void {
  if (current.sku !== input.sku || current.revision !== input.revision || current.source !== input.source
    || current.rootDirectory !== input.rootDirectory || current.materialHash !== input.materialHash
    || current.sourceMediaIdentityHash !== input.sourceMediaIdentityHash
    || current.expectedTargetHash !== input.expectedTargetHash || current.expectedTargetCount !== input.targets.length) {
    throw new AppError('VERSION_CONFLICT', 'OZON 媒体清理批次幂等身份不一致', {
      cleanupId: current.id,
      generatedVersionId: current.generatedVersionId
    }, 409);
  }
}

function assertSameTargets(actual: OzonSourceMediaCleanupTargetRegistration[], expected: OzonSourceMediaCleanupTargetRegistration[]): void {
  if (JSON.stringify(normalizedTargets(actual)) !== JSON.stringify(normalizedTargets(expected))) {
    throw new AppError('VERSION_CONFLICT', 'OZON 媒体清理批次目标集合已冻结，不能追加或替换店铺', undefined, 409);
  }
}

function normalizedTargets(targets: OzonSourceMediaCleanupTargetRegistration[]): OzonSourceMediaCleanupTargetRegistration[] {
  return [...targets].map((target) => ({
    storeId: String(target.storeId), publicationId: String(target.publicationId),
    jobId: String(target.jobId), taskId: String(target.taskId)
  })).sort((left, right) => left.storeId.localeCompare(right.storeId));
}

function toBatch(row: SqlRow): OzonSourceMediaCleanupBatch {
  return {
    id: String(row.id), generatedVersionId: String(row.generated_version_id), sku: String(row.sku),
    revision: Number(row.revision), source: row.source, rootDirectory: String(row.root_directory),
    materialHash: String(row.material_hash), sourceMediaIdentityHash: String(row.source_media_identity_hash),
    expectedTargetHash: String(row.expected_target_hash), expectedTargetCount: Number(row.expected_target_count),
    triggerIdentity: jsonObject(row.trigger_identity), state: row.state, rowVersion: Number(row.row_version),
    attemptCount: Number(row.attempt_count), nextAttemptAt: iso(row.next_attempt_at),
    ...(row.lease_owner ? { leaseOwner: String(row.lease_owner) } : {}),
    ...(row.lease_token ? { leaseToken: String(row.lease_token) } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    reclaimedBytes: Number(row.reclaimed_bytes || 0),
    ...(row.last_error_code ? { lastErrorCode: String(row.last_error_code) } : {}),
    ...(row.last_error_message ? { lastErrorMessage: String(row.last_error_message) } : {}),
    ...(row.cleaned_at ? { cleanedAt: iso(row.cleaned_at) } : {}),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at)
  };
}

function toArtifact(row: SqlRow): OzonSourceMediaCleanupArtifact {
  return {
    cleanupId: String(row.cleanup_id), kind: row.kind, state: row.state,
    sourceRelPath: String(row.source_rel_path),
    ...(row.quarantine_rel_path ? { quarantineRelPath: String(row.quarantine_rel_path) } : {}),
    ...(row.directory_signature ? { directorySignature: String(row.directory_signature) } : {}),
    mediaIdentityHash: String(row.media_identity_hash), fileCount: Number(row.file_count || 0),
    totalBytes: Number(row.total_bytes || 0), reclaimedBytes: Number(row.reclaimed_bytes || 0),
    ...(row.last_error_code ? { lastErrorCode: String(row.last_error_code) } : {}),
    ...(row.last_error_message ? { lastErrorMessage: String(row.last_error_message) } : {}),
    ...(row.cleaned_at ? { cleanedAt: iso(row.cleaned_at) } : {}), updatedAt: iso(row.updated_at)
  };
}

function toEvidenceTarget(row: SqlRow): OzonSourceMediaCleanupEvidence['targets'][number] {
  return {
    storeId: String(row.store_id || ''), publicationId: String(row.publication_id || ''),
    jobId: String(row.job_id || ''), taskId: String(row.task_id || ''),
    ...(row.publication_status ? { publicationStatus: String(row.publication_status) } : {}),
    ...(row.publication_source ? { publicationSource: String(row.publication_source) } : {}),
    ...(row.publication_plan_hash ? { publicationPlanHash: String(row.publication_plan_hash) } : {}),
    ...(row.publication_generated_version_id ? { publicationGeneratedVersionId: String(row.publication_generated_version_id) } : {}),
    ...(row.runtime_state ? { runtimeState: String(row.runtime_state) } : {}),
    ...(row.runtime_task_id ? { runtimeTaskId: String(row.runtime_task_id) } : {}),
    ...(row.runtime_task_kind ? { runtimeTaskKind: String(row.runtime_task_kind) } : {}),
    ...(row.runtime_work_rel_path ? { runtimeWorkRelPath: String(row.runtime_work_rel_path) } : {}),
    ...(row.runtime_directory_stage ? { runtimeDirectoryStage: String(row.runtime_directory_stage) } : {}),
    ...(row.runtime_directory_signature ? { runtimeDirectorySignature: String(row.runtime_directory_signature) } : {}),
    ...(row.runtime_lease_owner ? { runtimeLeaseOwner: String(row.runtime_lease_owner) } : {}),
    ...(row.runtime_lease_expires_at ? { runtimeLeaseExpiresAt: iso(row.runtime_lease_expires_at) } : {})
  };
}

async function insertEvent(
  client: PoolClient,
  cleanupId: string,
  eventType: string,
  artifactKind: OzonSourceMediaCleanupArtifactKind | undefined,
  details: Record<string, unknown>
): Promise<void> {
  await client.query(`INSERT INTO ozon_source_media_cleanup_events(cleanup_id,event_type,artifact_kind,details)
    VALUES($1,$2,$3,$4::jsonb)`, [cleanupId, eventType, artifactKind || null, JSON.stringify(details)]);
}

function jsonObject(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function iso(value: unknown): string { return new Date(String(value)).toISOString(); }

function sourceMediaIdentityHashFromVersionSnapshot(snapshot: Record<string, unknown>): string {
  const shared = jsonObject(snapshot.sharedMaterial);
  const mediaAssets = Array.isArray(shared.mediaAssets) ? shared.mediaAssets.map(jsonObject) : [];
  const variants = Array.isArray(shared.variants) ? shared.variants.map(jsonObject) : [];
  if (!mediaAssets.length) return '';
  const identity = {
    schemaVersion: 1,
    mediaAssets: mediaAssets.map((asset) => ({
      assetId: asset.assetId,
      relativePath: asset.relativePath,
      kind: asset.kind,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
      productVariantId: asset.productVariantId || null,
      sourceStageId: asset.sourceStageId || null,
      sourceSubmissionId: asset.sourceSubmissionId || null,
      deliveredAt: asset.deliveredAt || null
    })),
    variants: variants.map((variant) => ({
      productVariantId: variant.productVariantId,
      media: Array.isArray(variant.media) ? variant.media.map((entry) => {
        const media = jsonObject(entry);
        return { assetId: media.assetId, sortOrder: media.sortOrder };
      }) : []
    }))
  };
  return `sha256:${createHash('sha256').update(stableJson(identity)).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
