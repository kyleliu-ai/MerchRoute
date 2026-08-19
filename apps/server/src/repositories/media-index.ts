import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { AppError, type ImageItem } from '@n8n-media-review/shared';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

type SqlRow = Record<string, any>;
export type MediaIndexWatcherStatus = 'ACTIVE' | 'STARTING' | 'DEGRADED' | 'UNAVAILABLE' | 'DISABLED';

export type MediaIndexRepresentativeMedia = {
  relativePath: string;
  mediaType: 'image' | 'video';
};

/** Filesystem-derived task data. Review state and stage configuration do not belong in this projection. */
export type MediaIndexTaskInput = {
  relativeTaskDirectory: string;
  sourceFolderName: string;
  imageCount: number;
  videoCount: number;
  mediaCount: number;
  subfolderCount: number;
  lastModifiedAt: string;
  representativeImages: string[];
  representativeMedia: MediaIndexRepresentativeMedia[];
  files: ImageItem[];
};

export type MediaIndexTask = MediaIndexTaskInput & {
  taskId: string;
  sourceFolder: string;
};

export type MediaIndexSource = {
  id: string;
  instanceId: string;
  stageId: string;
  root: string;
  configRevision: string;
  enabled: boolean;
  queueCount: number;
  rootFingerprint?: string;
  rootDirectoryCount?: number;
  shallowCheckedAt?: string;
  watcherStatus?: MediaIndexWatcherStatus;
  lastReconciledAt?: string;
  lastFullReconciledAt?: string;
  lastEventAt?: string;
  lastError?: string;
  activeGenerationId?: string;
  createdAt: string;
  updatedAt: string;
};

export type MediaIndexGenerationStatus = 'BUILDING' | 'ACTIVE' | 'RETIRED' | 'FAILED';
export type MediaIndexGeneration = {
  id: string;
  stageId: string;
  configRevision: string;
  status: MediaIndexGenerationStatus;
  taskCount: number;
  fileCount: number;
  rootFingerprint?: string;
  rootDirectoryCount?: number;
  createdAt: string;
  activatedAt?: string;
  failedAt?: string;
};

export type MediaIndexSnapshot = {
  stageId: string;
  configRevision: string;
  queueCount: number;
  rootFingerprint?: string;
  rootDirectoryCount?: number;
  shallowCheckedAt?: string;
  watcherStatus?: MediaIndexWatcherStatus;
  lastReconciledAt?: string;
  lastFullReconciledAt?: string;
  lastEventAt?: string;
  lastError?: string;
  generation: {
    id: string;
    activatedAt: string;
    taskCount: number;
    fileCount: number;
    rootFingerprint?: string;
    rootDirectoryCount?: number;
  };
  tasks: MediaIndexTask[];
};

export type MediaIndexSourceProbe = {
  queueCount: number;
  rootFingerprint?: string;
  rootDirectoryCount?: number;
  shallowCheckedAt?: string;
  watcherStatus?: MediaIndexWatcherStatus;
  lastReconciledAt?: string;
  lastFullReconciledAt?: string;
  lastEventAt?: string;
  lastError?: string | null;
};

export type MediaIndexActivationProbe = {
  rootFingerprint: string;
  rootDirectoryCount: number;
  reconciledAt?: string;
};

export type MediaIndexGenerationFailure = {
  error?: string;
  reconciledAt?: string;
  eventAt?: string;
};

export type MediaIndexReconcileKind = 'FULL' | 'TASK';
export type MediaIndexReconcileJob = {
  id: string;
  stageId: string;
  kind: MediaIndexReconcileKind;
  taskId?: string;
  relativeTaskDirectory?: string;
  pathKey?: string;
  configRevision: string;
  eventRevision: string;
  dueAt: string;
  retryCount: number;
  lastError?: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseUntil?: string;
  createdAt: string;
  updatedAt: string;
};

export type EnqueueMediaIndexReconcileInput = {
  stageId: string;
  kind: 'FULL';
  configRevision: string;
  dueAt?: string;
  taskId?: never;
  relativeTaskDirectory?: never;
} | {
  stageId: string;
  kind: 'TASK';
  relativeTaskDirectory: string;
  taskId?: string;
  configRevision: string;
  dueAt?: string;
};

export type MediaIndexCompleteResult = 'COMPLETED' | 'SUPERSEDED' | 'LEASE_LOST';
export type MediaIndexFailResult = 'RETRY_SCHEDULED' | 'SUPERSEDED' | 'LEASE_LOST';
export type MediaIndexPruneResult = { deletedCount: number; retiredDeleted: number; failedDeleted: number };

const MIGRATION_LOCK = 'pixroute_media_index_schema';
const INSERT_CHUNK_SIZE = 1_000;

export class MediaIndexRepository {
  private pool?: Pool;
  readonly instanceId: string;

  constructor(instanceIdValue: string, private readonly connectionString = process.env.DATABASE_URL) {
    this.instanceId = requiredText(instanceIdValue, 'instanceId');
  }

  /** Whether PostgreSQL was configured, independent of its current connection state. */
  get configured(): boolean { return Boolean(this.connectionString); }

  /** Whether this repository currently owns an initialized connection pool. */
  get connected(): boolean { return Boolean(this.pool); }

  async initialize(): Promise<void> {
    if (!this.connectionString || this.pool) return;
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

  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = undefined;
    await pool?.end();
  }

  async upsertSource(stageIdValue: string, rootValue: string, configRevisionValue: string, enabled: boolean): Promise<MediaIndexSource> {
    const stageId = requiredText(stageIdValue, 'stageId');
    const root = enabled ? requiredText(rootValue, 'root') : String(rootValue || '');
    const configRevision = requiredText(configRevisionValue, 'configRevision');
    return this.transaction(async (client) => {
      await client.query(`INSERT INTO media_index_sources(id,instance_id,stage_id,root,config_revision,enabled)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(instance_id,stage_id) DO NOTHING`,
      [randomUUID(), this.instanceId, stageId, root, configRevision, enabled]);
      const current = await client.query<SqlRow>(`SELECT * FROM media_index_sources
        WHERE instance_id=$1 AND stage_id=$2 FOR UPDATE`, [this.instanceId, stageId]);
      const row = current.rows[0]!;
      const projectionChanged = String(row.root) !== root || String(row.config_revision) !== configRevision;
      if (projectionChanged && row.active_generation_id) {
        await client.query(`UPDATE media_index_generations SET status='RETIRED',updated_at=NOW()
          WHERE id=$1 AND status='ACTIVE'`, [row.active_generation_id]);
      }
      const updated = await client.query<SqlRow>(`UPDATE media_index_sources SET
        root=$3,config_revision=$4,enabled=$5,
        active_generation_id=CASE WHEN $6 THEN NULL ELSE active_generation_id END,
        root_fingerprint=CASE WHEN $6 THEN NULL ELSE root_fingerprint END,
        root_directory_count=CASE WHEN $6 THEN NULL ELSE root_directory_count END,
        shallow_checked_at=CASE WHEN $6 THEN NULL ELSE shallow_checked_at END,
        updated_at=NOW() WHERE instance_id=$1 AND stage_id=$2 RETURNING *`,
      [this.instanceId, stageId, root, configRevision, enabled, projectionChanged]);
      return toSource(updated.rows[0]!);
    });
  }

  async getSource(stageIdValue: string): Promise<MediaIndexSource | undefined> {
    const stageId = requiredText(stageIdValue, 'stageId');
    const result = await this.query<SqlRow>('SELECT * FROM media_index_sources WHERE instance_id=$1 AND stage_id=$2', [this.instanceId, stageId]);
    return result.rows[0] ? toSource(result.rows[0]) : undefined;
  }

  async updateSourceProbe(stageIdValue: string, probe: MediaIndexSourceProbe): Promise<MediaIndexSource | undefined> {
    const stageId = requiredText(stageIdValue, 'stageId');
    const queueCount = nonNegativeInteger(probe.queueCount, 'queueCount');
    const rootFingerprint = probe.rootFingerprint === undefined ? undefined : requiredText(probe.rootFingerprint, 'rootFingerprint');
    const rootDirectoryCount = probe.rootDirectoryCount === undefined ? undefined : nonNegativeInteger(probe.rootDirectoryCount, 'rootDirectoryCount');
    const shallowCheckedAt = probe.shallowCheckedAt === undefined
      ? (rootFingerprint === undefined && rootDirectoryCount === undefined ? undefined : new Date().toISOString())
      : validIso(probe.shallowCheckedAt, 'shallowCheckedAt');
    const watcherStatus = probe.watcherStatus === undefined ? undefined : validWatcherStatus(probe.watcherStatus);
    const lastReconciledAt = probe.lastReconciledAt === undefined ? undefined : validIso(probe.lastReconciledAt, 'lastReconciledAt');
    const lastFullReconciledAt = probe.lastFullReconciledAt === undefined ? undefined : validIso(probe.lastFullReconciledAt, 'lastFullReconciledAt');
    const lastEventAt = probe.lastEventAt === undefined ? undefined : validIso(probe.lastEventAt, 'lastEventAt');
    const lastError = probe.lastError === undefined ? undefined : optionalError(probe.lastError || undefined);
    const updated = await this.query<SqlRow>(`UPDATE media_index_sources SET
      queue_count=$3,
      root_fingerprint=CASE WHEN $4::boolean THEN $5 ELSE root_fingerprint END,
      root_directory_count=CASE WHEN $6::boolean THEN $7 ELSE root_directory_count END,
      shallow_checked_at=CASE WHEN $8::boolean THEN $9 ELSE shallow_checked_at END,
      watcher_status=CASE WHEN $10::boolean THEN $11 ELSE watcher_status END,
      last_reconciled_at=CASE WHEN $12::boolean THEN $13 ELSE last_reconciled_at END,
      last_full_reconciled_at=CASE WHEN $14::boolean THEN $15 ELSE last_full_reconciled_at END,
      last_event_at=CASE WHEN $16::boolean THEN $17 ELSE last_event_at END,
      last_error=CASE WHEN $18::boolean THEN $19 ELSE last_error END,
      updated_at=NOW() WHERE instance_id=$1 AND stage_id=$2 RETURNING *`, [
      this.instanceId, stageId, queueCount,
      rootFingerprint !== undefined, rootFingerprint ?? null,
      rootDirectoryCount !== undefined, rootDirectoryCount ?? null,
      shallowCheckedAt !== undefined, shallowCheckedAt ?? null,
      watcherStatus !== undefined, watcherStatus ?? null,
      lastReconciledAt !== undefined, lastReconciledAt ?? null,
      lastFullReconciledAt !== undefined, lastFullReconciledAt ?? null,
      lastEventAt !== undefined, lastEventAt ?? null,
      probe.lastError !== undefined, lastError
    ]);
    return updated.rows[0] ? toSource(updated.rows[0]) : undefined;
  }

  /** Starts an invisible FULL snapshot. Undefined means the source is disabled, missing, or already stale. */
  async beginFullGeneration(stageIdValue: string, configRevisionValue: string): Promise<MediaIndexGeneration | undefined> {
    const stageId = requiredText(stageIdValue, 'stageId');
    const configRevision = requiredText(configRevisionValue, 'configRevision');
    return this.transaction(async (client) => {
      const source = await client.query<SqlRow>(`SELECT * FROM media_index_sources
        WHERE instance_id=$1 AND stage_id=$2 FOR SHARE`, [this.instanceId, stageId]);
      const row = source.rows[0];
      if (!row || !row.enabled || String(row.config_revision) !== configRevision) return undefined;
      const generation = await client.query<SqlRow>(`INSERT INTO media_index_generations(
        id,source_id,source_root,config_revision,status) VALUES($1,$2,$3,$4,'BUILDING') RETURNING *`,
      [randomUUID(), row.id, row.root, configRevision]);
      return toGeneration(generation.rows[0]!, stageId);
    });
  }

  /** Replaces all rows of a BUILDING generation. It remains invisible until activateGeneration succeeds. */
  async writeFullGeneration(generationIdValue: string, taskValues: MediaIndexTaskInput[]): Promise<MediaIndexGeneration> {
    const generationId = requiredText(generationIdValue, 'generationId');
    const tasks = normalizeTasks(taskValues);
    return this.transaction(async (client) => {
      const generation = await client.query<SqlRow>(`SELECT g.*,s.stage_id FROM media_index_generations g
        JOIN media_index_sources s ON s.id=g.source_id WHERE g.id=$1 AND s.instance_id=$2 FOR UPDATE OF g`,
      [generationId, this.instanceId]);
      const row = generation.rows[0];
      if (!row) throw new AppError('NOT_FOUND', '媒体索引代不存在', { generationId }, 404);
      if (row.status !== 'BUILDING') throw new AppError('CONFIG_INVALID', '只能写入 BUILDING 状态的媒体索引代', { generationId, status: row.status }, 409);
      await client.query('DELETE FROM media_index_tasks WHERE generation_id=$1', [generationId]);
      await insertTasks(client, generationId, tasks);
      const updated = await client.query<SqlRow>(`UPDATE media_index_generations SET task_count=$2,file_count=$3,updated_at=NOW()
        WHERE id=$1 RETURNING *`, [generationId, tasks.length, tasks.reduce((count, task) => count + task.files.length, 0)]);
      return toGeneration(updated.rows[0]!, String(row.stage_id));
    });
  }

  /** Atomically swaps a completed BUILDING generation into view after revalidating both revision and root. */
  async activateGeneration(
    stageIdValue: string,
    generationIdValue: string,
    configRevisionValue: string,
    probe?: MediaIndexActivationProbe
  ): Promise<MediaIndexGeneration | undefined> {
    const stageId = requiredText(stageIdValue, 'stageId');
    const generationId = requiredText(generationIdValue, 'generationId');
    const configRevision = requiredText(configRevisionValue, 'configRevision');
    const rootFingerprint = probe ? requiredText(probe.rootFingerprint, 'rootFingerprint') : undefined;
    const rootDirectoryCount = probe ? nonNegativeInteger(probe.rootDirectoryCount, 'rootDirectoryCount') : undefined;
    const reconciledAt = probe?.reconciledAt ? validIso(probe.reconciledAt, 'reconciledAt') : new Date().toISOString();
    return this.transaction(async (client) => {
      const sourceResult = await client.query<SqlRow>(`SELECT * FROM media_index_sources
        WHERE instance_id=$1 AND stage_id=$2 FOR UPDATE`, [this.instanceId, stageId]);
      const generationResult = await client.query<SqlRow>(`SELECT g.*,s.stage_id FROM media_index_generations g
        JOIN media_index_sources s ON s.id=g.source_id WHERE g.id=$1 AND s.instance_id=$2 FOR UPDATE OF g`,
      [generationId, this.instanceId]);
      const source = sourceResult.rows[0];
      const generation = generationResult.rows[0];
      if (!generation || String(generation.stage_id) !== stageId) {
        throw new AppError('NOT_FOUND', '媒体索引代不存在', { stageId, generationId }, 404);
      }
      if (generation.status !== 'BUILDING') return undefined;
      if (!source) {
        await client.query(`UPDATE media_index_generations SET status='FAILED',failed_at=NOW(),failure_reason='CONFIG_REVISION_MISMATCH',updated_at=NOW()
          WHERE id=$1`, [generationId]);
        return undefined;
      }
      const stillCurrent = Boolean(source.enabled)
        && String(source.config_revision) === configRevision
        && String(generation.config_revision) === configRevision
        && String(generation.source_id) === String(source.id)
        && String(source.root) === String(generation.source_root);
      if (!stillCurrent) {
        await client.query(`UPDATE media_index_generations SET status='FAILED',failed_at=NOW(),failure_reason='CONFIG_REVISION_MISMATCH',updated_at=NOW()
          WHERE id=$1`, [generationId]);
        return undefined;
      }
      if (source.active_generation_id && String(source.active_generation_id) !== generationId) {
        await client.query(`UPDATE media_index_generations SET status='RETIRED',updated_at=NOW()
          WHERE id=$1 AND status='ACTIVE'`, [source.active_generation_id]);
      }
      const activated = await client.query<SqlRow>(`UPDATE media_index_generations SET
        status='ACTIVE',activated_at=NOW(),failure_reason=NULL,failed_at=NULL,
        root_fingerprint=$2,root_directory_count=$3,updated_at=NOW()
        WHERE id=$1 RETURNING *`, [generationId, rootFingerprint ?? null, rootDirectoryCount ?? null]);
      await client.query(`UPDATE media_index_sources SET active_generation_id=$3,
        root_fingerprint=COALESCE($4,root_fingerprint),root_directory_count=COALESCE($5,root_directory_count),
        shallow_checked_at=CASE WHEN $4::text IS NULL AND $5::integer IS NULL THEN shallow_checked_at ELSE NOW() END,
        last_reconciled_at=$6,last_full_reconciled_at=$6,last_error=NULL,
        updated_at=NOW() WHERE instance_id=$1 AND stage_id=$2`,
      [this.instanceId, stageId, generationId, rootFingerprint ?? null, rootDirectoryCount ?? null, reconciledAt]);
      return toGeneration(activated.rows[0]!, stageId);
    });
  }

  async failGeneration(generationIdValue: string, failure: string | MediaIndexGenerationFailure = {}): Promise<boolean> {
    const generationId = requiredText(generationIdValue, 'generationId');
    const input = typeof failure === 'string' ? { error: failure } : failure;
    const error = optionalError(input.error) || 'RECONCILE_FAILED';
    const reconciledAt = input.reconciledAt ? validIso(input.reconciledAt, 'reconciledAt') : new Date().toISOString();
    const eventAt = input.eventAt ? validIso(input.eventAt, 'eventAt') : undefined;
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>(`SELECT g.id,g.source_id FROM media_index_generations g
        JOIN media_index_sources s ON s.id=g.source_id
        WHERE g.id=$1 AND s.instance_id=$2 AND g.status='BUILDING' FOR UPDATE OF g,s`, [generationId, this.instanceId]);
      if (!current.rows[0]) return false;
      await client.query(`UPDATE media_index_generations SET status='FAILED',failed_at=NOW(),failure_reason=$2,updated_at=NOW()
        WHERE id=$1`, [generationId, error]);
      await client.query(`UPDATE media_index_sources SET last_reconciled_at=$2,last_error=$3,
        last_event_at=CASE WHEN $4::timestamptz IS NULL THEN last_event_at ELSE $4::timestamptz END,updated_at=NOW()
        WHERE id=$1`, [current.rows[0].source_id, reconciledAt, error, eventAt ?? null]);
      return true;
    });
  }

  async loadActiveSnapshot(stageIdValue: string): Promise<MediaIndexSnapshot | undefined> {
    const stageId = requiredText(stageIdValue, 'stageId');
    return this.readTransaction(async (client) => {
      const headerResult = await client.query<SqlRow>(`SELECT s.stage_id,s.config_revision,s.queue_count,s.root_fingerprint AS source_root_fingerprint,
          s.root_directory_count AS source_root_directory_count,s.shallow_checked_at,s.watcher_status,s.root,
          s.last_reconciled_at,s.last_full_reconciled_at,s.last_event_at,s.last_error,
          g.id,g.activated_at,g.task_count,g.file_count,g.root_fingerprint,g.root_directory_count
        FROM media_index_sources s JOIN media_index_generations g ON g.id=s.active_generation_id
        WHERE s.instance_id=$1 AND s.stage_id=$2 AND s.enabled=true AND g.status='ACTIVE'
          AND g.config_revision=s.config_revision AND g.source_root=s.root`, [this.instanceId, stageId]);
      const header = headerResult.rows[0];
      if (!header) return undefined;
      const taskRows = await client.query<SqlRow>(`SELECT * FROM media_index_tasks
        WHERE generation_id=$1 ORDER BY last_modified_at DESC,path_key`, [header.id]);
      const fileRows = await client.query<SqlRow>(`SELECT f.* FROM media_index_files f
        WHERE f.generation_id=$1 ORDER BY f.task_path_key,f.sort_order,f.relative_path_key`, [header.id]);
      const filesByTask = new Map<string, ImageItem[]>();
      for (const row of fileRows.rows) {
        const files = filesByTask.get(String(row.task_path_key)) || [];
        files.push(toFile(row));
        filesByTask.set(String(row.task_path_key), files);
      }
      return {
        stageId: String(header.stage_id),
        configRevision: String(header.config_revision),
        queueCount: Number(header.queue_count),
        ...(header.source_root_fingerprint ? { rootFingerprint: String(header.source_root_fingerprint) } : {}),
        ...(header.source_root_directory_count !== null && header.source_root_directory_count !== undefined
          ? { rootDirectoryCount: Number(header.source_root_directory_count) } : {}),
        ...(header.shallow_checked_at ? { shallowCheckedAt: toIso(header.shallow_checked_at) } : {}),
        ...(header.watcher_status ? { watcherStatus: validWatcherStatus(header.watcher_status) } : {}),
        ...(header.last_reconciled_at ? { lastReconciledAt: toIso(header.last_reconciled_at) } : {}),
        ...(header.last_full_reconciled_at ? { lastFullReconciledAt: toIso(header.last_full_reconciled_at) } : {}),
        ...(header.last_event_at ? { lastEventAt: toIso(header.last_event_at) } : {}),
        ...(header.last_error ? { lastError: String(header.last_error) } : {}),
        generation: {
          id: String(header.id),
          activatedAt: toIso(header.activated_at),
          taskCount: Number(header.task_count),
          fileCount: Number(header.file_count),
          ...(header.root_fingerprint ? { rootFingerprint: String(header.root_fingerprint) } : {}),
          ...(header.root_directory_count !== null && header.root_directory_count !== undefined
            ? { rootDirectoryCount: Number(header.root_directory_count) } : {})
        },
        tasks: taskRows.rows.map((row) => toTask(
          row,
          filesByTask.get(String(row.path_key)) || [],
          String(header.stage_id),
          String(header.root)
        ))
      };
    });
  }

  /** Transactionally replaces or removes one task inside the current ACTIVE generation. */
  async replaceTask(
    stageIdValue: string,
    configRevisionValue: string,
    relativeTaskDirectoryValue: string,
    taskValue?: MediaIndexTaskInput,
    reconciledAtValue?: string
  ): Promise<boolean> {
    const stageId = requiredText(stageIdValue, 'stageId');
    const configRevision = requiredText(configRevisionValue, 'configRevision');
    const relativeTaskDirectory = normalizeRelativeTaskDirectory(relativeTaskDirectoryValue);
    const taskPathKey = pathKey(relativeTaskDirectory);
    const task = taskValue ? normalizeTask(taskValue) : undefined;
    if (task && task.relativeTaskDirectory !== relativeTaskDirectory) {
      throw new AppError('CONFIG_INVALID', 'relativeTaskDirectory 与增量任务内容不一致', {
        relativeTaskDirectory, actualRelativeTaskDirectory: task.relativeTaskDirectory
      });
    }
    const reconciledAt = reconciledAtValue ? validIso(reconciledAtValue, 'reconciledAt') : new Date().toISOString();
    return this.transaction(async (client) => {
      const sourceResult = await client.query<SqlRow>(`SELECT * FROM media_index_sources
        WHERE instance_id=$1 AND stage_id=$2 FOR UPDATE`, [this.instanceId, stageId]);
      const source = sourceResult.rows[0];
      if (!source?.enabled || String(source.config_revision) !== configRevision || !source.active_generation_id) return false;
      const generationResult = await client.query<SqlRow>(`SELECT * FROM media_index_generations
        WHERE id=$1 AND source_id=$2 FOR UPDATE`, [source.active_generation_id, source.id]);
      const generation = generationResult.rows[0];
      if (!generation || generation.status !== 'ACTIVE'
        || String(generation.config_revision) !== configRevision || String(generation.source_root) !== String(source.root)) return false;
      await client.query('DELETE FROM media_index_tasks WHERE generation_id=$1 AND path_key=$2', [generation.id, taskPathKey]);
      if (task) await insertTasks(client, String(generation.id), [task]);
      await client.query(`UPDATE media_index_generations SET
        task_count=(SELECT COUNT(*) FROM media_index_tasks WHERE generation_id=$1),
        file_count=(SELECT COUNT(*) FROM media_index_files WHERE generation_id=$1),updated_at=NOW()
        WHERE id=$1`, [generation.id]);
      await client.query(`UPDATE media_index_sources SET last_reconciled_at=$2,last_error=NULL,updated_at=NOW()
        WHERE id=$1`, [source.id, reconciledAt]);
      return true;
    });
  }

  /** Coalesces events by stage/kind/task and increments an opaque event revision on every enqueue. */
  async enqueueReconcile(input: EnqueueMediaIndexReconcileInput): Promise<MediaIndexReconcileJob> {
    const stageId = requiredText(input.stageId, 'stageId');
    const configRevision = requiredText(input.configRevision, 'configRevision');
    const dueAt = input.dueAt ? validIso(input.dueAt, 'dueAt') : new Date().toISOString();
    return this.transaction(async (client) => {
      const source = await client.query<SqlRow>(`SELECT id,root FROM media_index_sources
        WHERE instance_id=$1 AND stage_id=$2 FOR UPDATE`, [this.instanceId, stageId]);
      if (!source.rows[0]) throw new AppError('NOT_FOUND', '媒体索引源不存在', { stageId }, 404);
      const sourceId = String(source.rows[0].id);
      let result;
      if (input.kind === 'TASK') {
        const relativeTaskDirectory = normalizeRelativeTaskDirectory(input.relativeTaskDirectory);
        const taskPathKey = pathKey(relativeTaskDirectory);
        const taskId = input.taskId
          ? requiredText(input.taskId, 'taskId')
          : mediaIndexTaskId(stageId, resolveTaskFolder(String(source.rows[0].root), relativeTaskDirectory));
        result = await client.query<SqlRow>(`INSERT INTO media_index_reconcile_queue(
          id,source_id,kind,task_id,relative_task_directory,path_key,config_revision,due_at)
          VALUES($1,$2,'TASK',$3,$4,$5,$6,$7)
          ON CONFLICT(source_id,path_key) WHERE kind='TASK' DO UPDATE SET
            task_id=EXCLUDED.task_id,relative_task_directory=EXCLUDED.relative_task_directory,
            config_revision=EXCLUDED.config_revision,event_revision=media_index_reconcile_queue.event_revision+1,
            due_at=LEAST(media_index_reconcile_queue.due_at,EXCLUDED.due_at),retry_count=0,last_error=NULL,updated_at=NOW()
          RETURNING *`, [randomUUID(), sourceId, taskId, relativeTaskDirectory, taskPathKey, configRevision, dueAt]);
      } else {
        result = await client.query<SqlRow>(`INSERT INTO media_index_reconcile_queue(
          id,source_id,kind,task_id,relative_task_directory,path_key,config_revision,due_at)
          VALUES($1,$2,'FULL',NULL,NULL,NULL,$3,$4)
          ON CONFLICT(source_id) WHERE kind='FULL' DO UPDATE SET
            config_revision=EXCLUDED.config_revision,event_revision=media_index_reconcile_queue.event_revision+1,
            due_at=LEAST(media_index_reconcile_queue.due_at,EXCLUDED.due_at),retry_count=0,last_error=NULL,updated_at=NOW()
          RETURNING *`, [randomUUID(), sourceId, configRevision, dueAt]);
      }
      await client.query('UPDATE media_index_sources SET last_event_at=NOW(),updated_at=NOW() WHERE id=$1', [sourceId]);
      return toReconcileJob(result.rows[0]!, stageId, String(source.rows[0].root));
    });
  }

  async countReconciliations(stageIdValue?: string): Promise<number> {
    const stageId = stageIdValue === undefined ? undefined : requiredText(stageIdValue, 'stageId');
    const result = await this.query<{ count: string }>(`SELECT COUNT(*)::text AS count
      FROM media_index_reconcile_queue q JOIN media_index_sources s ON s.id=q.source_id
      WHERE s.instance_id=$1 AND ($2::text IS NULL OR s.stage_id=$2)`, [this.instanceId, stageId ?? null]);
    return Number(result.rows[0]?.count || 0);
  }

  async claimReconcile(workerIdValue: string, limitValue = 1, leaseMsValue = 60_000): Promise<MediaIndexReconcileJob[]> {
    const workerId = requiredText(workerIdValue, 'workerId');
    const limit = Math.min(100, Math.max(1, Math.trunc(limitValue)));
    const leaseMs = Math.min(3_600_000, Math.max(1_000, Math.trunc(leaseMsValue)));
    const leaseToken = randomUUID();
    return this.transaction(async (client) => {
      const due = await client.query<SqlRow>(`SELECT q.*,s.stage_id,s.root FROM media_index_reconcile_queue q
        JOIN media_index_sources s ON s.id=q.source_id
        WHERE s.instance_id=$1 AND q.due_at<=NOW() AND (q.lease_until IS NULL OR q.lease_until<=NOW())
        ORDER BY q.due_at,q.created_at FOR UPDATE OF q SKIP LOCKED LIMIT $2`, [this.instanceId, limit]);
      if (!due.rows.length) return [];
      const ids = due.rows.map((row) => row.id);
      const stages = new Map(due.rows.map((row) => [String(row.id), String(row.stage_id)]));
      const roots = new Map(due.rows.map((row) => [String(row.id), String(row.root)]));
      const claimed = await client.query<SqlRow>(`UPDATE media_index_reconcile_queue SET
        retry_count=retry_count+CASE WHEN lease_until IS NOT NULL AND lease_until<=NOW() THEN 1 ELSE 0 END,
        last_error=CASE WHEN lease_until IS NOT NULL AND lease_until<=NOW() THEN 'LEASE_EXPIRED' ELSE last_error END,
        lease_owner=$2,lease_token=$3,lease_until=NOW()+($4::text||' milliseconds')::interval,updated_at=NOW()
      WHERE id=ANY($1::uuid[]) RETURNING *`, [ids, workerId, leaseToken, leaseMs]);
      const order = new Map(ids.map((id, index) => [String(id), index]));
      return claimed.rows.sort((left, right) => order.get(String(left.id))! - order.get(String(right.id))!)
        .map((row) => toReconcileJob(row, stages.get(String(row.id))!, roots.get(String(row.id))!));
    });
  }

  async renewReconcileLease(idValue: string, leaseTokenValue: string, leaseMsValue: number): Promise<boolean> {
    const id = requiredText(idValue, 'id');
    const leaseToken = requiredText(leaseTokenValue, 'leaseToken');
    const leaseMs = Math.min(3_600_000, Math.max(1_000, Math.trunc(leaseMsValue)));
    const renewed = await this.query(`UPDATE media_index_reconcile_queue q SET
      lease_until=NOW()+($3::text||' milliseconds')::interval,updated_at=NOW()
      FROM media_index_sources s WHERE q.id=$1 AND q.lease_token=$2
        AND q.lease_until>NOW() AND q.source_id=s.id AND s.instance_id=$4`,
    [id, leaseToken, leaseMs, this.instanceId]);
    return Boolean(renewed.rowCount);
  }

  async completeReconcile(idValue: string, leaseTokenValue: string, eventRevisionValue: string): Promise<MediaIndexCompleteResult> {
    const id = requiredText(idValue, 'id');
    const leaseToken = requiredText(leaseTokenValue, 'leaseToken');
    const eventRevision = revisionText(eventRevisionValue);
    return this.transaction(async (client) => {
      const completed = await client.query(`DELETE FROM media_index_reconcile_queue q USING media_index_sources s
        WHERE q.id=$1 AND q.lease_token=$2 AND q.event_revision=$3::bigint
          AND q.source_id=s.id AND s.instance_id=$4`, [id, leaseToken, eventRevision, this.instanceId]);
      if (completed.rowCount) return 'COMPLETED';
      const superseded = await client.query(`UPDATE media_index_reconcile_queue q SET
        lease_owner=NULL,lease_token=NULL,lease_until=NULL,due_at=LEAST(due_at,NOW()),updated_at=NOW()
        FROM media_index_sources s WHERE q.id=$1 AND q.lease_token=$2
          AND q.source_id=s.id AND s.instance_id=$3`, [id, leaseToken, this.instanceId]);
      return superseded.rowCount ? 'SUPERSEDED' : 'LEASE_LOST';
    });
  }

  async failReconcile(input: {
    id: string;
    leaseToken: string;
    eventRevision: string;
    error?: string;
    retryAt?: string;
  }): Promise<MediaIndexFailResult> {
    const id = requiredText(input.id, 'id');
    const leaseToken = requiredText(input.leaseToken, 'leaseToken');
    const eventRevision = revisionText(input.eventRevision);
    return this.transaction(async (client) => {
      const current = await client.query<SqlRow>(`SELECT q.* FROM media_index_reconcile_queue q
        JOIN media_index_sources s ON s.id=q.source_id
        WHERE q.id=$1 AND q.lease_token=$2 AND s.instance_id=$3 FOR UPDATE OF q`, [id, leaseToken, this.instanceId]);
      const row = current.rows[0];
      if (!row) return 'LEASE_LOST';
      if (String(row.event_revision) !== eventRevision) {
        await client.query(`UPDATE media_index_reconcile_queue SET
          lease_owner=NULL,lease_token=NULL,lease_until=NULL,due_at=LEAST(due_at,NOW()),updated_at=NOW() WHERE id=$1`, [id]);
        return 'SUPERSEDED';
      }
      const retryAt = input.retryAt
        ? validIso(input.retryAt, 'retryAt')
        : new Date(Date.now() + Math.min(300_000, 1_000 * (2 ** Math.min(8, Number(row.retry_count))))).toISOString();
      await client.query(`UPDATE media_index_reconcile_queue SET retry_count=retry_count+1,last_error=$2,due_at=$3,
        lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=NOW() WHERE id=$1`, [id, optionalError(input.error) || 'RECONCILE_FAILED', retryAt]);
      await client.query(`UPDATE media_index_sources SET last_reconciled_at=NOW(),last_error=$2,updated_at=NOW()
        WHERE id=$1`, [row.source_id, optionalError(input.error) || 'RECONCILE_FAILED']);
      return 'RETRY_SCHEDULED';
    });
  }

  /** Explicit startup recovery; claimReconcile can also directly reclaim an expired lease. */
  async recoverExpiredLeases(): Promise<number> {
    const result = await this.query(`UPDATE media_index_reconcile_queue q SET
      retry_count=retry_count+1,last_error='LEASE_EXPIRED',due_at=LEAST(due_at,NOW()),
      lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=NOW()
      FROM media_index_sources s WHERE q.source_id=s.id AND s.instance_id=$1
        AND q.lease_until IS NOT NULL AND q.lease_until<=NOW()`, [this.instanceId]);
    return result.rowCount || 0;
  }

  async pruneGenerations(stageIdValue: string, options: { keepRetired?: number } = {}): Promise<MediaIndexPruneResult> {
    const stageId = requiredText(stageIdValue, 'stageId');
    const keepRetired = Math.min(20, Math.max(0, Math.trunc(options.keepRetired ?? 1)));
    return this.transaction(async (client) => {
      const source = await client.query<SqlRow>(`SELECT id FROM media_index_sources
        WHERE instance_id=$1 AND stage_id=$2 FOR UPDATE`, [this.instanceId, stageId]);
      if (!source.rows[0]) return { deletedCount: 0, retiredDeleted: 0, failedDeleted: 0 };
      const removed = await client.query<{ status: MediaIndexGenerationStatus }>(`WITH ranked_retired AS (
          SELECT id,ROW_NUMBER() OVER(ORDER BY COALESCE(activated_at,created_at) DESC,created_at DESC,id) AS position
          FROM media_index_generations WHERE source_id=$1 AND status='RETIRED'
        )
        DELETE FROM media_index_generations g
        WHERE g.source_id=$1 AND (
          g.status='FAILED' OR (g.status='RETIRED' AND g.id IN (SELECT id FROM ranked_retired WHERE position>$2))
        ) RETURNING g.status`, [source.rows[0].id, keepRetired]);
      const retiredDeleted = removed.rows.filter((row) => row.status === 'RETIRED').length;
      const failedDeleted = removed.rows.filter((row) => row.status === 'FAILED').length;
      return { deletedCount: removed.rows.length, retiredDeleted, failedDeleted };
    });
  }

  async recoverStaleBuildingGenerations(cutoffMsValue: number, stageIdValue?: string): Promise<number> {
    const cutoffMs = Math.max(1_000, Math.trunc(cutoffMsValue));
    const stageId = stageIdValue === undefined ? undefined : requiredText(stageIdValue, 'stageId');
    return this.transaction(async (client) => {
      const recovered = await client.query<{ source_id: string }>(`UPDATE media_index_generations g SET
        status='FAILED',failed_at=NOW(),failure_reason='BUILDING_LEASE_EXPIRED',updated_at=NOW()
        FROM media_index_sources s WHERE g.source_id=s.id AND s.instance_id=$1
          AND ($2::text IS NULL OR s.stage_id=$2) AND g.status='BUILDING'
          AND g.updated_at<NOW()-($3::text||' milliseconds')::interval RETURNING g.source_id`,
      [this.instanceId, stageId ?? null, cutoffMs]);
      const sourceIds = [...new Set(recovered.rows.map((row) => row.source_id))];
      if (sourceIds.length) {
        await client.query(`UPDATE media_index_sources SET last_error='BUILDING_LEASE_EXPIRED',updated_at=NOW()
          WHERE id=ANY($1::uuid[])`, [sourceIds]);
      }
      return recovered.rows.length;
    });
  }

  private async migrate(): Promise<void> {
    const client = await this.requirePool().connect();
    let began = false;
    const businessTables = [
      'media_index_sources',
      'media_index_generations',
      'media_index_tasks',
      'media_index_files',
      'media_index_reconcile_queue'
    ];
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [MIGRATION_LOCK]);
      await client.query('BEGIN');
      began = true;

      const existingResult = await client.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables
        WHERE table_schema=current_schema() AND table_name=ANY($1::text[])`, [businessTables]);
      const existing = new Set(existingResult.rows.map((row) => row.table_name));
      const markerResult = await client.query<{ exists: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM information_schema.tables
        WHERE table_schema=current_schema() AND table_name='media_index_schema_migrations'
      ) AS exists`);
      const markerExists = Boolean(markerResult.rows[0]?.exists);

      if (existing.size || markerExists) {
        if (existing.size !== businessTables.length || !markerExists) {
          throw incompatibleSchemaError({
            existingTables: [...existing].sort(),
            missingTables: businessTables.filter((table) => !existing.has(table)),
            migrationMarkerPresent: markerExists
          });
        }
        const version = await client.query<{ exists: boolean }>(`SELECT EXISTS(
          SELECT 1 FROM media_index_schema_migrations WHERE id='001_media_index_projection'
        ) AS exists`);
        if (!version.rows[0]?.exists) {
          throw incompatibleSchemaError({ reason: 'migration marker version is missing' });
        }
        const columns = await client.query<{ table_name: string; column_name: string }>(`SELECT table_name,column_name
          FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=ANY($1::text[])`, [businessTables]);
        const actual = new Map<string, Set<string>>();
        for (const row of columns.rows) {
          const names = actual.get(row.table_name) || new Set<string>();
          names.add(row.column_name);
          actual.set(row.table_name, names);
        }
        const required: Record<string, string[]> = {
          media_index_sources: [
            'id', 'instance_id', 'stage_id', 'root', 'config_revision', 'enabled', 'queue_count',
            'root_fingerprint', 'root_directory_count', 'shallow_checked_at', 'watcher_status',
            'last_reconciled_at', 'last_full_reconciled_at', 'last_event_at', 'last_error',
            'active_generation_id', 'created_at', 'updated_at'
          ],
          media_index_generations: [
            'id', 'source_id', 'source_root', 'config_revision', 'status', 'task_count', 'file_count',
            'root_fingerprint', 'root_directory_count', 'failure_reason', 'created_at', 'updated_at',
            'activated_at', 'failed_at'
          ],
          media_index_tasks: [
            'generation_id', 'relative_task_directory', 'path_key', 'source_folder_name', 'image_count',
            'video_count', 'media_count', 'subfolder_count', 'last_modified_at',
            'representative_images', 'representative_media', 'created_at', 'updated_at'
          ],
          media_index_files: [
            'generation_id', 'task_path_key', 'relative_path', 'relative_path_key', 'size_bytes',
            'last_modified_at', 'media_type', 'sort_order'
          ],
          media_index_reconcile_queue: [
            'id', 'source_id', 'kind', 'task_id', 'relative_task_directory', 'path_key',
            'config_revision', 'event_revision', 'due_at', 'retry_count', 'last_error',
            'lease_owner', 'lease_token', 'lease_until', 'created_at', 'updated_at'
          ]
        };
        const forbidden: Record<string, string[]> = {
          media_index_generations: ['stage_id'],
          media_index_tasks: ['task_id', 'source_folder'],
          media_index_files: ['task_id', 'file_name', 'directory'],
          media_index_reconcile_queue: ['stage_id']
        };
        const missingColumns = Object.entries(required).flatMap(([table, names]) =>
          names.filter((name) => !actual.get(table)?.has(name)).map((name) => `${table}.${name}`));
        const forbiddenColumns = Object.entries(forbidden).flatMap(([table, names]) =>
          names.filter((name) => actual.get(table)?.has(name)).map((name) => `${table}.${name}`));
        if (missingColumns.length || forbiddenColumns.length) {
          throw incompatibleSchemaError({ missingColumns, forbiddenColumns });
        }
      }

      await client.query(`CREATE TABLE IF NOT EXISTS media_index_schema_migrations(
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS media_index_sources(
        id UUID PRIMARY KEY,
        instance_id TEXT NOT NULL,
        stage_id TEXT NOT NULL,
        root TEXT NOT NULL,
        config_revision TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        queue_count INTEGER NOT NULL DEFAULT 0 CHECK(queue_count>=0),
        root_fingerprint TEXT,
        root_directory_count INTEGER CHECK(root_directory_count>=0),
        shallow_checked_at TIMESTAMPTZ,
        watcher_status TEXT CHECK(watcher_status IS NULL OR watcher_status IN ('ACTIVE','STARTING','DEGRADED','UNAVAILABLE','DISABLED')),
        last_reconciled_at TIMESTAMPTZ,
        last_full_reconciled_at TIMESTAMPTZ,
        last_event_at TIMESTAMPTZ,
        last_error TEXT,
        active_generation_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(instance_id,stage_id)
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS media_index_generations(
        id UUID PRIMARY KEY,
        source_id UUID NOT NULL REFERENCES media_index_sources(id) ON DELETE CASCADE,
        source_root TEXT NOT NULL,
        config_revision TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('BUILDING','ACTIVE','RETIRED','FAILED')),
        task_count INTEGER NOT NULL DEFAULT 0 CHECK(task_count>=0),
        file_count INTEGER NOT NULL DEFAULT 0 CHECK(file_count>=0),
        root_fingerprint TEXT,
        root_directory_count INTEGER CHECK(root_directory_count>=0),
        failure_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        activated_at TIMESTAMPTZ,
        failed_at TIMESTAMPTZ
      )`);
      await client.query(`DO $media_index_active_generation_fk$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid='media_index_sources'::regclass
            AND conname='media_index_sources_active_generation_fk'
        ) THEN
          ALTER TABLE media_index_sources
            ADD CONSTRAINT media_index_sources_active_generation_fk
            FOREIGN KEY(active_generation_id) REFERENCES media_index_generations(id)
            ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE;
        END IF;
      END
      $media_index_active_generation_fk$`);
      await client.query(`CREATE TABLE IF NOT EXISTS media_index_tasks(
        generation_id UUID NOT NULL REFERENCES media_index_generations(id) ON DELETE CASCADE,
        relative_task_directory TEXT NOT NULL,
        path_key TEXT NOT NULL,
        source_folder_name TEXT NOT NULL,
        image_count INTEGER NOT NULL CHECK(image_count>=0),
        video_count INTEGER NOT NULL CHECK(video_count>=0),
        media_count INTEGER NOT NULL CHECK(media_count>=0),
        subfolder_count INTEGER NOT NULL CHECK(subfolder_count>=0),
        last_modified_at TIMESTAMPTZ NOT NULL,
        representative_images JSONB NOT NULL DEFAULT '[]'::jsonb,
        representative_media JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY(generation_id,path_key)
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS media_index_files(
        generation_id UUID NOT NULL,
        task_path_key TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        relative_path_key TEXT NOT NULL,
        size_bytes BIGINT NOT NULL CHECK(size_bytes>=0),
        last_modified_at TIMESTAMPTZ NOT NULL,
        media_type TEXT NOT NULL CHECK(media_type IN ('image','video')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(generation_id,task_path_key,relative_path_key),
        FOREIGN KEY(generation_id,task_path_key) REFERENCES media_index_tasks(generation_id,path_key) ON DELETE CASCADE
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS media_index_reconcile_queue(
        id UUID PRIMARY KEY,
        source_id UUID NOT NULL REFERENCES media_index_sources(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('FULL','TASK')),
        task_id TEXT,
        relative_task_directory TEXT,
        path_key TEXT,
        config_revision TEXT NOT NULL,
        event_revision BIGINT NOT NULL DEFAULT 1 CHECK(event_revision>0),
        due_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count>=0),
        last_error TEXT,
        lease_owner TEXT,
        lease_token UUID,
        lease_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK((kind='FULL' AND task_id IS NULL AND relative_task_directory IS NULL AND path_key IS NULL)
          OR (kind='TASK' AND relative_task_directory IS NOT NULL AND relative_task_directory<>'' AND path_key IS NOT NULL AND path_key<>''))
      )`);
      await client.query("CREATE UNIQUE INDEX IF NOT EXISTS media_index_generations_one_active ON media_index_generations(source_id) WHERE status='ACTIVE'");
      await client.query('CREATE INDEX IF NOT EXISTS media_index_tasks_generation_modified ON media_index_tasks(generation_id,last_modified_at DESC)');
      await client.query("CREATE UNIQUE INDEX IF NOT EXISTS media_index_reconcile_one_full ON media_index_reconcile_queue(source_id) WHERE kind='FULL'");
      await client.query("CREATE UNIQUE INDEX IF NOT EXISTS media_index_reconcile_one_task ON media_index_reconcile_queue(source_id,path_key) WHERE kind='TASK'");
      await client.query('CREATE INDEX IF NOT EXISTS media_index_reconcile_due ON media_index_reconcile_queue(due_at)');
      await client.query("INSERT INTO media_index_schema_migrations(id) VALUES('001_media_index_projection') ON CONFLICT(id) DO NOTHING");
      await client.query('COMMIT');
      began = false;
    } catch (error) {
      if (began) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK]).catch(() => undefined);
      client.release();
    }
  }

  private query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
    return this.requirePool().query<T>(text, values);
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

  private async readTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.requirePool().connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
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

  private requirePool(): Pool {
    if (!this.pool) throw new AppError('DATABASE_UNAVAILABLE', '媒体索引尚未配置 PostgreSQL DATABASE_URL', undefined, 503);
    return this.pool;
  }
}

async function insertTasks(client: PoolClient, generationId: string, tasks: MediaIndexTaskInput[]): Promise<void> {
  if (!tasks.length) return;
  await client.query(`INSERT INTO media_index_tasks(
    generation_id,relative_task_directory,path_key,source_folder_name,image_count,video_count,media_count,subfolder_count,
    last_modified_at,representative_images,representative_media)
    SELECT $1,x.relative_task_directory,x.path_key,x.source_folder_name,x.image_count,x.video_count,x.media_count,x.subfolder_count,
      x.last_modified_at::timestamptz,x.representative_images,x.representative_media
    FROM jsonb_to_recordset($2::jsonb) AS x(
      relative_task_directory TEXT,path_key TEXT,source_folder_name TEXT,image_count INTEGER,video_count INTEGER,media_count INTEGER,
      subfolder_count INTEGER,last_modified_at TEXT,representative_images JSONB,representative_media JSONB)`, [
    generationId,
    JSON.stringify(tasks.map((task) => ({
      relative_task_directory: task.relativeTaskDirectory,
      path_key: pathKey(task.relativeTaskDirectory),
      source_folder_name: task.sourceFolderName,
      image_count: task.imageCount,
      video_count: task.videoCount,
      media_count: task.mediaCount,
      subfolder_count: task.subfolderCount,
      last_modified_at: task.lastModifiedAt,
      representative_images: task.representativeImages,
      representative_media: task.representativeMedia
    })))
  ]);
  const files = tasks.flatMap((task) => task.files.map((file, sortOrder) => ({
    task_path_key: pathKey(task.relativeTaskDirectory),
    relative_path: file.relativePath,
    relative_path_key: pathKey(file.relativePath),
    size_bytes: file.sizeBytes,
    last_modified_at: file.lastModifiedAt,
    media_type: file.mediaType || 'image',
    sort_order: sortOrder
  })));
  for (let offset = 0; offset < files.length; offset += INSERT_CHUNK_SIZE) {
    await client.query(`INSERT INTO media_index_files(
      generation_id,task_path_key,relative_path,relative_path_key,size_bytes,last_modified_at,media_type,sort_order)
      SELECT $1,x.task_path_key,x.relative_path,x.relative_path_key,x.size_bytes,x.last_modified_at::timestamptz,x.media_type,x.sort_order
      FROM jsonb_to_recordset($2::jsonb) AS x(task_path_key TEXT,relative_path TEXT,relative_path_key TEXT,
        size_bytes BIGINT,last_modified_at TEXT,media_type TEXT,sort_order INTEGER)`, [generationId, JSON.stringify(files.slice(offset, offset + INSERT_CHUNK_SIZE))]);
  }
}

function incompatibleSchemaError(details: Record<string, unknown>): AppError {
  return new AppError(
    'MEDIA_INDEX_SCHEMA_INCOMPATIBLE',
    '检测到不兼容的同名媒体索引表；为保护现有数据，初始化已停止且未执行结构变更',
    details,
    409
  );
}

function normalizeTasks(values: MediaIndexTaskInput[]): MediaIndexTaskInput[] {
  if (!Array.isArray(values)) throw new AppError('CONFIG_INVALID', '媒体索引任务必须是数组');
  const tasks = values.map(normalizeTask);
  const keys = new Set<string>();
  for (const task of tasks) {
    const key = pathKey(task.relativeTaskDirectory);
    if (keys.has(key)) throw new AppError('CONFIG_INVALID', '媒体索引任务相对目录重复', { relativeTaskDirectory: task.relativeTaskDirectory });
    keys.add(key);
  }
  return tasks;
}

function normalizeTask(value: MediaIndexTaskInput): MediaIndexTaskInput {
  const relativeTaskDirectory = normalizeRelativeTaskDirectory(value?.relativeTaskDirectory);
  const sourceFolderName = requiredText(value?.sourceFolderName, 'sourceFolderName');
  const files = Array.isArray(value?.files) ? value.files.map((file) => normalizeFile(file, relativeTaskDirectory)) : [];
  const paths = new Set<string>();
  for (const file of files) {
    const key = pathKey(file.relativePath);
    if (paths.has(key)) throw new AppError('CONFIG_INVALID', '同一任务中的媒体相对路径重复', { relativeTaskDirectory, relativePath: file.relativePath });
    paths.add(key);
  }
  const imageCount = files.filter((file) => (file.mediaType || 'image') === 'image').length;
  const videoCount = files.filter((file) => file.mediaType === 'video').length;
  return {
    relativeTaskDirectory,
    sourceFolderName,
    imageCount,
    videoCount,
    mediaCount: files.length,
    subfolderCount: nonNegativeInteger(value.subfolderCount, 'subfolderCount'),
    lastModifiedAt: validIso(value.lastModifiedAt, 'lastModifiedAt'),
    representativeImages: stringArray(value.representativeImages, 'representativeImages')
      .map((item) => normalizePosixRelativePath(item, 'representativeImages')),
    representativeMedia: representativeMedia(value.representativeMedia),
    files
  };
}

function normalizeFile(value: ImageItem, relativeTaskDirectory: string): ImageItem {
  const mediaType = value?.mediaType || 'image';
  if (mediaType !== 'image' && mediaType !== 'video') {
    throw new AppError('CONFIG_INVALID', '媒体类型必须为 image 或 video', { relativeTaskDirectory, mediaType });
  }
  const relativePath = normalizePosixRelativePath(value?.relativePath, 'relativePath');
  const directory = path.posix.dirname(relativePath);
  return {
    relativePath,
    fileName: path.posix.basename(relativePath),
    directory: directory === '.' ? '' : directory,
    sizeBytes: nonNegativeInteger(value?.sizeBytes, 'sizeBytes'),
    lastModifiedAt: validIso(value?.lastModifiedAt, 'lastModifiedAt'),
    mediaType
  };
}

function representativeMedia(value: MediaIndexRepresentativeMedia[]): MediaIndexRepresentativeMedia[] {
  if (!Array.isArray(value)) throw new AppError('CONFIG_INVALID', 'representativeMedia 必须是数组');
  return value.map((item) => {
    if (item?.mediaType !== 'image' && item?.mediaType !== 'video') throw new AppError('CONFIG_INVALID', '代表媒体类型无效');
    return { relativePath: normalizePosixRelativePath(item.relativePath, 'relativePath'), mediaType: item.mediaType };
  });
}

function toSource(row: SqlRow): MediaIndexSource {
  return {
    id: String(row.id),
    instanceId: String(row.instance_id),
    stageId: String(row.stage_id),
    root: String(row.root),
    configRevision: String(row.config_revision),
    enabled: Boolean(row.enabled),
    queueCount: Number(row.queue_count || 0),
    ...(row.root_fingerprint ? { rootFingerprint: String(row.root_fingerprint) } : {}),
    ...(row.root_directory_count !== null && row.root_directory_count !== undefined
      ? { rootDirectoryCount: Number(row.root_directory_count) } : {}),
    ...(row.shallow_checked_at ? { shallowCheckedAt: toIso(row.shallow_checked_at) } : {}),
    ...(row.watcher_status ? { watcherStatus: validWatcherStatus(row.watcher_status) } : {}),
    ...(row.last_reconciled_at ? { lastReconciledAt: toIso(row.last_reconciled_at) } : {}),
    ...(row.last_full_reconciled_at ? { lastFullReconciledAt: toIso(row.last_full_reconciled_at) } : {}),
    ...(row.last_event_at ? { lastEventAt: toIso(row.last_event_at) } : {}),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    ...(row.active_generation_id ? { activeGenerationId: String(row.active_generation_id) } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function toGeneration(row: SqlRow, stageIdValue?: string): MediaIndexGeneration {
  return {
    id: String(row.id),
    stageId: String(row.stage_id || stageIdValue || ''),
    configRevision: String(row.config_revision),
    status: row.status as MediaIndexGenerationStatus,
    taskCount: Number(row.task_count),
    fileCount: Number(row.file_count),
    ...(row.root_fingerprint ? { rootFingerprint: String(row.root_fingerprint) } : {}),
    ...(row.root_directory_count !== null && row.root_directory_count !== undefined
      ? { rootDirectoryCount: Number(row.root_directory_count) } : {}),
    createdAt: toIso(row.created_at),
    ...(row.activated_at ? { activatedAt: toIso(row.activated_at) } : {}),
    ...(row.failed_at ? { failedAt: toIso(row.failed_at) } : {})
  };
}

function toTask(row: SqlRow, files: ImageItem[], stageId: string, root: string): MediaIndexTask {
  const relativeTaskDirectory = normalizeRelativeTaskDirectory(row.relative_task_directory);
  const sourceFolder = resolveTaskFolder(root, relativeTaskDirectory);
  return {
    taskId: mediaIndexTaskId(stageId, sourceFolder),
    sourceFolder,
    relativeTaskDirectory,
    sourceFolderName: String(row.source_folder_name),
    imageCount: Number(row.image_count),
    videoCount: Number(row.video_count),
    mediaCount: Number(row.media_count),
    subfolderCount: Number(row.subfolder_count),
    lastModifiedAt: toIso(row.last_modified_at),
    representativeImages: stringArray(row.representative_images, 'representativeImages'),
    representativeMedia: representativeMedia(row.representative_media),
    files
  };
}

function toFile(row: SqlRow): ImageItem {
  const relativePath = normalizePosixRelativePath(row.relative_path, 'relativePath');
  const directory = path.posix.dirname(relativePath);
  return {
    relativePath,
    fileName: path.posix.basename(relativePath),
    directory: directory === '.' ? '' : directory,
    sizeBytes: Number(row.size_bytes),
    lastModifiedAt: toIso(row.last_modified_at),
    mediaType: row.media_type === 'video' ? 'video' : 'image'
  };
}

function toReconcileJob(row: SqlRow, stageIdValue?: string, sourceRootValue?: string): MediaIndexReconcileJob {
  const stageId = String(row.stage_id || stageIdValue || '');
  const relativeTaskDirectory = row.relative_task_directory ? String(row.relative_task_directory) : undefined;
  const derivedTaskId = !row.task_id && relativeTaskDirectory && sourceRootValue
    ? mediaIndexTaskId(stageId, resolveTaskFolder(sourceRootValue, relativeTaskDirectory))
    : undefined;
  return {
    id: String(row.id),
    stageId,
    kind: row.kind as MediaIndexReconcileKind,
    ...(row.task_id || derivedTaskId ? { taskId: String(row.task_id || derivedTaskId) } : {}),
    ...(relativeTaskDirectory ? { relativeTaskDirectory } : {}),
    ...(row.path_key ? { pathKey: String(row.path_key) } : {}),
    configRevision: String(row.config_revision),
    eventRevision: String(row.event_revision),
    dueAt: toIso(row.due_at),
    retryCount: Number(row.retry_count),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    ...(row.lease_owner ? { leaseOwner: String(row.lease_owner) } : {}),
    ...(row.lease_token ? { leaseToken: String(row.lease_token) } : {}),
    ...(row.lease_until ? { leaseUntil: toIso(row.lease_until) } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function requiredText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new AppError('CONFIG_INVALID', `${field} 不能为空`);
  return text;
}

function validWatcherStatus(value: unknown): MediaIndexWatcherStatus {
  const status = requiredText(value, 'watcherStatus');
  if (!['ACTIVE', 'STARTING', 'DEGRADED', 'UNAVAILABLE', 'DISABLED'].includes(status)) {
    throw new AppError('CONFIG_INVALID', 'watcherStatus 无效', { watcherStatus: status });
  }
  return status as MediaIndexWatcherStatus;
}

function normalizeRelativeTaskDirectory(value: unknown): string {
  const input = requiredText(value, 'relativeTaskDirectory');
  if (input.includes('\0') || input.startsWith('/') || /^[A-Za-z]:[\\/]/.test(input)) {
    throw new AppError('CONFIG_INVALID', 'relativeTaskDirectory 必须是任务根目录内的相对路径');
  }
  const parts = input.replaceAll('\\', '/').split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) {
    throw new AppError('CONFIG_INVALID', 'relativeTaskDirectory 不能越过任务根目录');
  }
  return parts.join('/').normalize('NFC');
}

function normalizePosixRelativePath(value: unknown, field: string): string {
  const input = requiredText(value, field);
  if (input.includes('\0') || input.startsWith('/') || /^[A-Za-z]:[\\/]/.test(input)) {
    throw new AppError('CONFIG_INVALID', `${field} 必须是 POSIX 相对路径`);
  }
  const parts = input.replaceAll('\\', '/').split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) throw new AppError('CONFIG_INVALID', `${field} 不能越过任务目录`);
  return parts.join('/').normalize('NFC');
}

function pathKey(value: string): string {
  const normalized = value.normalize('NFC');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function resolveTaskFolder(rootValue: string, relativeTaskDirectory: string): string {
  const root = path.resolve(requiredText(rootValue, 'root'));
  const candidate = path.resolve(root, ...normalizeRelativeTaskDirectory(relativeTaskDirectory).split('/'));
  const relative = path.relative(root, candidate);
  const comparison = process.platform === 'win32' ? relative.toLocaleLowerCase('en-US') : relative;
  if (!comparison || comparison === '..' || comparison.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    if (!comparison) return candidate;
    throw new AppError('CONFIG_INVALID', '媒体索引任务目录超出 source.root');
  }
  return candidate;
}

export function mediaIndexTaskId(stageIdValue: string, sourceFolderValue: string): string {
  const stageId = requiredText(stageIdValue, 'stageId');
  const resolved = path.resolve(requiredText(sourceFolderValue, 'sourceFolder'));
  const normalized = process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  return createHash('sha256').update(`${stageId}${normalized}`).digest('hex');
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new AppError('CONFIG_INVALID', `${field} 必须是字符串数组`);
  return value.map(String);
}

function nonNegativeInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new AppError('CONFIG_INVALID', `${field} 必须是非负整数`);
  return number;
}

function validIso(value: unknown, field: string): string {
  const date = new Date(typeof value === 'string' || typeof value === 'number' ? value : Number.NaN);
  if (!Number.isFinite(date.getTime())) throw new AppError('CONFIG_INVALID', `${field} 必须是有效时间`);
  return date.toISOString();
}

function revisionText(value: unknown): string {
  const revision = requiredText(value, 'eventRevision');
  if (!/^\d+$/.test(revision) || revision === '0') throw new AppError('CONFIG_INVALID', 'eventRevision 必须是正整数');
  return revision;
}

function optionalError(value?: string): string | null {
  const message = String(value || '').trim();
  return message ? message.slice(0, 4_000) : null;
}

function toIso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}
