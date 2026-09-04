import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { watch, type Dirent, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import pLimit from 'p-limit';
import {
  AppError,
  type MediaIndexState,
  type MediaIndexStatus,
  type ProductTask,
  type StageConfig,
  type WatcherStatus
} from '@n8n-media-review/shared';
import type { ConfigService } from '../../config/service.js';
import {
  MediaIndexRepository,
  type MediaIndexReconcileJob,
  type MediaIndexSnapshot,
  type MediaIndexSource,
  type MediaIndexTaskInput
} from '../../repositories/media-index.js';
import {
  ScannerService,
  mediaDirectoryFingerprint,
  type IndexedTaskInvalidation,
  type PersistedMediaStageSnapshot,
  type PersistedMediaTaskSnapshot
} from '../scanner/index.js';

export type { MediaIndexState, MediaIndexStatus, WatcherStatus } from '@n8n-media-review/shared';
export type MediaIndexWatcherStatus = WatcherStatus;
export type MediaIndexActiveGeneration = NonNullable<MediaIndexState['activeGeneration']>;

export type MediaIndexChangeEvent = { stageId: string; state: MediaIndexState };

type WatchHandle = Pick<FSWatcher, 'close' | 'on'>;
type WatchFactory = (
  root: string,
  options: { recursive: boolean },
  listener: (eventType: string, filename: string | Buffer | null) => void
) => WatchHandle;

export type MediaIndexServiceOptions = {
  databaseUrl?: string | null;
  repository?: MediaIndexRepository;
  debounceMs?: number;
  shallowIntervalMs?: number;
  fullIntervalMs?: number;
  queuePollMs?: number;
  taskConcurrency?: number;
  fullConcurrency?: number;
  leaseMs?: number;
  watcherFactory?: WatchFactory;
  now?: () => Date;
};

type StageRuntime = {
  configRevision: string;
  candidateRoot?: string;
  inputQueueRoot?: string;
  rootFingerprint?: string;
  rootDirectoryCount?: number;
};

type StageWatchers = {
  token: string;
  candidateRoot?: string;
  candidate?: WatchHandle;
  inputQueueRoot?: string;
  inputQueue?: WatchHandle;
};

type DirtyTimer = {
  stageId: string;
  kind: 'FULL' | 'TASK' | 'QUEUE';
  relativeTaskDirectory?: string;
  firstAt: number;
  timer: NodeJS.Timeout;
};

type MemoryReconcile = {
  stageId: string;
  kind: 'FULL' | 'TASK';
  relativeTaskDirectory?: string;
  eventRevision: number;
};

const DEFAULT_DEBOUNCE_MS = 2_000;
const DEFAULT_SHALLOW_INTERVAL_MS = 10 * 60_000;
const DEFAULT_FULL_INTERVAL_MS = 24 * 60 * 60_000;
const DEFAULT_QUEUE_POLL_MS = 1_000;
const MAX_DIRTY_WAIT_MS = 15_000;
const DIRTY_BURST_WINDOW_MS = 30_000;
const DIRTY_TASK_THRESHOLD = 25;
const MAX_WATCHER_RESTART_ATTEMPTS = 5;

/**
 * Maintains a durable filesystem projection while keeping request-time reads entirely in memory.
 * Filesystem events are hints only: they enqueue reconciliation and never mutate the index directly.
 */
export class MediaIndexService {
  private readonly repository: MediaIndexRepository;
  private readonly options: Required<Omit<MediaIndexServiceOptions, 'databaseUrl' | 'repository' | 'watcherFactory'>> & { watcherFactory: WatchFactory };
  private readonly workerId = randomUUID();
  private readonly states = new Map<string, MediaIndexState>();
  private readonly runtimes = new Map<string, StageRuntime>();
  private readonly watchers = new Map<string, StageWatchers>();
  private readonly listeners = new Set<(event: MediaIndexChangeEvent) => void>();
  private readonly dirtyTimers = new Map<string, DirtyTimer>();
  private readonly eventPersistenceTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingEventAt = new Map<string, string>();
  private readonly watcherRestartTimers = new Map<string, NodeJS.Timeout>();
  private readonly watcherRestartAttempts = new Map<string, number>();
  private readonly dirtyBursts = new Map<string, { startedAt: number; tasks: Set<string> }>();
  private readonly memoryQueue = new Map<string, MemoryReconcile>();
  private readonly backgroundFlights = new Set<Promise<unknown>>();
  private readonly fullFlights = new Map<string, Promise<ProductTask[]>>();
  private readonly stageLocks = new Map<string, Promise<void>>();
  private readonly fullLimit: ReturnType<typeof pLimit>;
  private readonly taskLimit: ReturnType<typeof pLimit>;
  private databaseAvailable = false;
  private configSyncTail: Promise<void> = Promise.resolve();
  private initialized = false;
  private closed = false;
  private queueFlight?: Promise<void>;
  private queueRerunRequested = false;
  private queueTimer?: NodeJS.Timeout;
  private shallowTimer?: NodeJS.Timeout;
  private fullTimer?: NodeJS.Timeout;
  private removeScannerInvalidation?: () => void;

  constructor(
    private readonly config: ConfigService,
    private readonly scanner: ScannerService,
    private readonly logger: FastifyBaseLogger,
    options: MediaIndexServiceOptions = {}
  ) {
    const instanceId = createHash('sha256').update(`pixroute-media-index\0${normalizedInstancePath(config.appDataDir)}`).digest('hex');
    this.repository = options.repository || new MediaIndexRepository(instanceId, options.databaseUrl === null ? '' : options.databaseUrl);
    this.options = {
      debounceMs: Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS),
      shallowIntervalMs: Math.max(1_000, options.shallowIntervalMs ?? DEFAULT_SHALLOW_INTERVAL_MS),
      fullIntervalMs: Math.max(10_000, options.fullIntervalMs ?? DEFAULT_FULL_INTERVAL_MS),
      queuePollMs: Math.max(100, options.queuePollMs ?? DEFAULT_QUEUE_POLL_MS),
      taskConcurrency: Math.min(2, Math.max(1, options.taskConcurrency ?? 2)),
      fullConcurrency: 1,
      leaseMs: Math.max(5_000, options.leaseMs ?? 60_000),
      watcherFactory: options.watcherFactory || ((root, watchOptions, listener) => watch(root, watchOptions, listener)),
      now: options.now || (() => new Date())
    };
    this.fullLimit = pLimit(this.options.fullConcurrency);
    this.taskLimit = pLimit(this.options.taskConcurrency);
  }

  get configured(): boolean {
    return this.repository.configured && this.databaseAvailable;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      await this.repository.initialize();
      this.databaseAvailable = this.repository.connected;
      if (this.databaseAvailable) {
        await this.repository.recoverExpiredLeases();
        await this.repository.recoverStaleBuildingGenerations(6 * 60 * 60_000);
      }
    } catch (error) {
      this.databaseAvailable = false;
      this.logger.warn({ err: error }, 'PostgreSQL 媒体索引不可用，已切换到内存 single-flight 回退');
    }
    this.scanner.setPersistentIndexAuthoritative(this.repository.configured);
    this.removeScannerInvalidation = this.scanner.onTaskInvalidated((event) => this.handleScannerInvalidation(event));
    await this.syncConfig();
    this.startTimers();
    this.trackBackground(this.processQueue(), '媒体索引队列启动失败');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.queueTimer) clearInterval(this.queueTimer);
    if (this.shallowTimer) clearInterval(this.shallowTimer);
    if (this.fullTimer) clearInterval(this.fullTimer);
    this.queueTimer = undefined;
    this.shallowTimer = undefined;
    this.fullTimer = undefined;
    for (const dirty of this.dirtyTimers.values()) clearTimeout(dirty.timer);
    this.dirtyTimers.clear();
    for (const timer of this.eventPersistenceTimers.values()) clearTimeout(timer);
    this.eventPersistenceTimers.clear();
    for (const timer of this.watcherRestartTimers.values()) clearTimeout(timer);
    this.watcherRestartTimers.clear();
    this.watcherRestartAttempts.clear();
    for (const watcher of this.watchers.values()) closeWatchers(watcher);
    this.watchers.clear();
    this.removeScannerInvalidation?.();
    this.removeScannerInvalidation = undefined;
    const pendingEvents = [...this.pendingEventAt];
    this.pendingEventAt.clear();
    await Promise.allSettled(pendingEvents.map(([stageId, lastEventAt]) => this.updateSourceRuntime(stageId, {
      queueCount: this.getState(stageId).queueCount,
      watcherStatus: this.getState(stageId).watcherStatus,
      lastEventAt
    })));
    await this.configSyncTail.catch(() => undefined);
    while (this.backgroundFlights.size > 0 || this.fullFlights.size > 0 || this.queueFlight) {
      await Promise.allSettled([
        ...this.backgroundFlights,
        ...this.fullFlights.values(),
        ...(this.queueFlight ? [this.queueFlight] : [])
      ]);
    }
    await this.repository.close();
  }

  syncConfig(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const operation = this.configSyncTail.catch(() => undefined).then(() => this.runConfigSync());
    this.configSyncTail = operation.catch(() => undefined);
    return operation;
  }

  private async runConfigSync(): Promise<void> {
    const stages = this.config.get().stages;
    const currentIds = new Set(stages.map((stage) => stage.id));
    for (const stageId of [...this.runtimes.keys()]) {
      if (currentIds.has(stageId)) continue;
      this.stopStageWatchers(stageId);
      this.clearStageWork(stageId);
      this.scanner.clearStageIndex(stageId);
      const runtime = this.runtimes.get(stageId)!;
      const deletedRevision = createHash('sha256').update(`${runtime.configRevision}:deleted`).digest('hex');
      this.runtimes.delete(stageId);
      this.setState(stageId, { revision: deletedRevision, status: 'DISABLED', watcherStatus: 'DISABLED', queueCount: 0, pendingReconciliations: 0, activeGeneration: undefined });
      if (this.databaseAvailable) {
        await this.repository.upsertSource(stageId, '', deletedRevision, false)
          .catch((error) => this.handleDatabaseFailure(error));
      }
    }

    for (const stage of stages) {
      const revision = stageConfigRevision(stage);
      const previous = this.runtimes.get(stage.id);
      const revisionChanged = previous !== undefined && previous.configRevision !== revision;
      const runtime: StageRuntime = {
        configRevision: revision,
        candidateRoot: stage.candidateRoot,
        inputQueueRoot: stage.inputQueueRoot,
        ...(previous?.configRevision === revision ? {
          rootFingerprint: previous.rootFingerprint,
          rootDirectoryCount: previous.rootDirectoryCount
        } : {})
      };
      this.runtimes.set(stage.id, runtime);
      this.setState(stage.id, { revision });
      if (!isIndexedStage(stage)) {
        this.stopStageWatchers(stage.id);
        this.clearStageWork(stage.id);
        this.setState(stage.id, {
          revision, status: 'DISABLED', watcherStatus: 'DISABLED', queueCount: 0,
          pendingReconciliations: 0, activeGeneration: undefined, error: undefined
        });
        if (this.databaseAvailable) {
          await this.repository.upsertSource(stage.id, stage.candidateRoot || '', revision, false)
            .catch((error) => this.handleDatabaseFailure(error));
        }
        continue;
      }

      if (revisionChanged) {
        this.clearStageWork(stage.id);
        this.scanner.hydrateStage(emptySnapshot(stage.id, this.nowIso()));
        this.setState(stage.id, {
          revision, status: 'WARMING',
          activeGeneration: undefined,
          pendingReconciliations: 0,
          error: undefined
        });
      }
      this.ensureState(stage.id, 'WARMING');
      if (this.databaseAvailable) {
        try {
          const source = await this.repository.upsertSource(stage.id, stage.candidateRoot!, revision, true);
          const snapshot = await this.repository.loadActiveSnapshot(stage.id);
          if (snapshot && snapshot.configRevision === revision) {
            this.hydrateRepositorySnapshot(stage, snapshot, source);
            await this.refreshPendingCount(stage.id);
            await this.enqueueFull(stage.id);
          }
          else {
            this.setState(stage.id, stateFromSource(stage.id, source, 'WARMING'));
            await this.enqueueFull(stage.id);
          }
        } catch (error) {
          this.handleDatabaseFailure(error, stage.id);
        }
      } else if (revisionChanged || !this.scanner.hasStageSnapshot(stage.id)) {
        await this.enqueueFull(stage.id);
      }
      this.startStageWatchers(stage);
    }
  }

  async listStageTasks(stageId: string): Promise<ProductTask[]> {
    const stage = this.requireStage(stageId);
    if (!isIndexedStage(stage)) return [];
    if (this.scanner.hasStageSnapshot(stageId)) return this.scanner.listIndexedStageTasks(stageId);
    if (this.repository.configured) {
      this.ensureState(stageId, this.databaseAvailable ? 'WARMING' : 'STALE');
      this.trackBackground(this.enqueueFull(stageId), '媒体索引冷态排队失败');
      return [];
    }
    this.ensureState(stageId, 'WARMING');
    this.trackBackground(this.enqueueFull(stageId), '媒体索引回退排队失败');
    this.trackBackground(this.processQueue(), '媒体索引回退扫描失败');
    return [];
  }

  snapshotStageTasks(stageId: string): ProductTask[] {
    this.requireStage(stageId);
    return this.scanner.hasStageSnapshot(stageId) ? this.scanner.listIndexedStageTasks(stageId) : [];
  }

  getState(stageId: string): MediaIndexState {
    const revision = this.runtimes.get(stageId)?.configRevision || '';
    return cloneState(this.states.get(stageId) || defaultState(stageId, 'WARMING', revision));
  }

  refreshStage(stageId: string): Promise<ProductTask[]> {
    return this.refreshStageInternal(stageId);
  }

  private refreshStageInternal(stageId: string, canCommit: () => boolean = () => true): Promise<ProductTask[]> {
    const active = this.fullFlights.get(stageId);
    if (active) return active;
    const operation = this.fullLimit(() => this.withStageLock(stageId, () => this.runFullRefresh(stageId, canCommit)));
    this.fullFlights.set(stageId, operation);
    return operation.finally(() => {
      if (this.fullFlights.get(stageId) === operation) this.fullFlights.delete(stageId);
    });
  }

  async refreshAll(): Promise<Map<string, ProductTask[]>> {
    const stages = this.config.get().stages.filter(isIndexedStage);
    const entries = await Promise.all(stages.map(async (stage) => [stage.id, await this.refreshStage(stage.id)] as const));
    return new Map(entries);
  }

  async enqueueTask(stageId: string, relativeTaskDirectory: string): Promise<void> {
    if (this.closed) return;
    const stage = this.requireStage(stageId);
    if (!isIndexedStage(stage)) return;
    const relative = normalizeTaskDirectory(relativeTaskDirectory);
    const revision = this.runtimes.get(stageId)?.configRevision || stageConfigRevision(stage);
    if (this.databaseAvailable) {
      try {
        await this.repository.enqueueReconcile({
          stageId, kind: 'TASK', relativeTaskDirectory: relative,
          taskId: this.scanner.taskId(stageId, path.join(stage.candidateRoot!, relative)),
          configRevision: revision
        });
        await this.refreshPendingCount(stageId);
        return;
      } catch (error) {
        this.handleDatabaseFailure(error, stageId);
      }
    }
    this.enqueueMemory({ stageId, kind: 'TASK', relativeTaskDirectory: relative });
  }

  onChange(listener: (event: MediaIndexChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async runFullRefresh(stageId: string, canCommit: () => boolean): Promise<ProductTask[]> {
    const stage = this.requireStage(stageId);
    if (!isIndexedStage(stage)) return [];
    const revision = this.runtimes.get(stageId)?.configRevision || stageConfigRevision(stage);
    const hadSnapshot = this.scanner.hasStageSnapshot(stageId);
    if (this.repository.configured && !this.databaseAvailable) {
      const error = new AppError('MEDIA_INDEX_DATABASE_UNAVAILABLE', '媒体索引数据库暂时不可用，已保留最近完整内存代', { stageId }, 503);
      this.setState(stageId, { status: hadSnapshot ? 'STALE' : 'ERROR', error: error.message });
      this.enqueueMemory({ stageId, kind: 'FULL' });
      throw error;
    }
    this.setState(stageId, { status: hadSnapshot ? 'REFRESHING' : 'WARMING', error: undefined });
    let generationId: string | undefined;
    try {
      await requireReadableDirectory(stage.candidateRoot!, stageId);
      const [snapshot, queueProbe] = await Promise.all([
        this.scanner.buildStageSnapshot(stageId),
        probeQueueDirectories(stage.inputQueueRoot, this.getState(stageId).queueCount)
      ]);
      const queueCount = queueProbe.count;
      const watcherStatus = queueProbe.error
        ? (this.getState(stageId).watcherStatus === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'DEGRADED')
        : this.getState(stageId).watcherStatus;
      if (!this.isCurrentRevision(stageId, revision)) {
        this.trackBackground(this.enqueueFull(stageId), '配置修订变化后的全量重排失败');
        return this.scanner.listIndexedStageTasks(stageId);
      }
      assertCommitLease(canCommit, stageId);
      let activeGeneration: MediaIndexActiveGeneration | undefined;
      if (this.databaseAvailable) {
        try {
          const generation = await this.repository.beginFullGeneration(stageId, revision);
          if (!generation) {
            this.trackBackground(this.enqueueFull(stageId), '配置修订冲突后的全量重排失败');
            return this.scanner.listIndexedStageTasks(stageId);
          }
          generationId = generation.id;
          await this.repository.writeFullGeneration(generation.id, snapshot.tasks.map(toRepositoryTask));
          assertCommitLease(canCommit, stageId);
          const activated = await this.repository.activateGeneration(stageId, generation.id, revision, {
            rootFingerprint: snapshot.rootFingerprint,
            rootDirectoryCount: snapshot.rootDirectoryCount
          });
          if (!activated || !this.isCurrentRevision(stageId, revision)) {
            this.trackBackground(this.enqueueFull(stageId), '索引代切换冲突后的全量重排失败');
            return this.scanner.listIndexedStageTasks(stageId);
          }
          const reconciledAt = this.nowIso();
          const runtimePersisted = await this.updateSourceRuntime(stageId, {
            queueCount,
            rootFingerprint: snapshot.rootFingerprint,
            rootDirectoryCount: snapshot.rootDirectoryCount,
            shallowCheckedAt: reconciledAt,
            watcherStatus,
            lastReconciledAt: reconciledAt,
            lastFullReconciledAt: reconciledAt,
            lastError: queueProbe.error || null
          });
          if (!runtimePersisted) throw new AppError('MEDIA_INDEX_DATABASE_UNAVAILABLE', '媒体索引运行时状态持久化失败', { stageId }, 503);
          activeGeneration = {
            id: activated.id,
            configRevision: revision,
            taskCount: activated.taskCount,
            fileCount: activated.fileCount,
            activatedAt: activated.activatedAt || reconciledAt
          };
          await this.repository.pruneGenerations(stageId, { keepRetired: 1 });
          this.scanner.setPersistentIndexAuthoritative(true);
        } catch (error) {
          if (generationId) await this.repository.failGeneration(generationId, errorMessage(error)).catch(() => undefined);
          this.handleDatabaseFailure(error, stageId);
          throw error;
        }
      }
      this.scanner.hydrateStage(snapshot);
      const reconciledAt = this.nowIso();
      const runtime = this.runtimes.get(stageId);
      if (runtime) {
        runtime.rootFingerprint = snapshot.rootFingerprint;
        runtime.rootDirectoryCount = snapshot.rootDirectoryCount;
      }
      this.setState(stageId, {
        status: queueProbe.error ? 'STALE' : 'READY', watcherStatus, queueCount, activeGeneration,
        lastReconciledAt: reconciledAt, lastFullReconciledAt: reconciledAt,
        error: queueProbe.error
      });
      if (this.getState(stageId).watcherStatus === 'DEGRADED') this.startStageWatchers(stage, true);
      return this.scanner.listIndexedStageTasks(stageId);
    } catch (error) {
      const state = this.getState(stageId);
      this.setState(stageId, {
        status: hadSnapshot ? 'STALE' : 'ERROR',
        error: errorMessage(error),
        activeGeneration: state.activeGeneration
      });
      await this.persistFailure(stageId, error);
      throw error;
    }
  }

  private async runTaskRefresh(stageId: string, relativeTaskDirectory: string, canCommit: () => boolean = () => true): Promise<void> {
    await this.taskLimit(() => this.withStageLock(stageId, async () => {
      const stage = this.requireStage(stageId);
      if (!isIndexedStage(stage)) return;
      if (this.repository.configured && !this.databaseAvailable) {
        throw new AppError('MEDIA_INDEX_DATABASE_UNAVAILABLE', '媒体索引数据库暂时不可用，任务增量校准已延后', { stageId }, 503);
      }
      const revision = this.runtimes.get(stageId)?.configRevision || stageConfigRevision(stage);
      const relative = normalizeTaskDirectory(relativeTaskDirectory);
      await requireReadableDirectory(stage.candidateRoot, stageId);
      const snapshot = await this.scanner.buildTaskSnapshot(stageId, relative);
      if (!this.isCurrentRevision(stageId, revision)) {
        await this.enqueueFull(stageId);
        return;
      }
      assertCommitLease(canCommit, stageId);
      if (this.databaseAvailable) {
        try {
          const replaced = await this.repository.replaceTask(stageId, revision, relative, snapshot ? toRepositoryTask(snapshot) : undefined, this.nowIso());
          if (!replaced) {
            await this.enqueueFull(stageId);
            return;
          }
          const runtimePersisted = await this.updateSourceRuntime(stageId, {
            queueCount: this.getState(stageId).queueCount,
            lastReconciledAt: this.nowIso(),
            lastError: null
          });
          if (!runtimePersisted) throw new AppError('MEDIA_INDEX_DATABASE_UNAVAILABLE', '媒体索引运行时状态持久化失败', { stageId }, 503);
        } catch (error) {
          this.handleDatabaseFailure(error, stageId);
          throw error;
        }
      }
      this.scanner.applyTaskSnapshot(stageId, relative, snapshot);
      this.setState(stageId, {
        status: 'READY', lastReconciledAt: this.nowIso(), error: undefined
      });
    }));
  }

  private processQueue(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.queueFlight) {
      this.queueRerunRequested = true;
      return this.queueFlight;
    }
    const operation = (async () => {
      do {
        this.queueRerunRequested = false;
        await this.runQueueCycle();
      } while (this.queueRerunRequested && !this.closed);
    })();
    const tracked = operation.finally(() => {
      if (this.queueFlight === tracked) this.queueFlight = undefined;
    });
    this.queueFlight = tracked;
    return tracked;
  }

  private async runQueueCycle(): Promise<void> {
    try {
      if (!this.databaseAvailable) {
        if (this.repository.configured) {
          await this.tryDatabaseRecovery();
          if (!this.databaseAvailable) return;
        } else {
          await this.processMemoryQueue();
          return;
        }
      }
      await this.processMemoryQueue();
      const jobs = await this.repository.claimReconcile(this.workerId, this.options.taskConcurrency, this.options.leaseMs);
      await Promise.all(jobs.map((job) => this.processPersistentJob(job)));
    } catch (error) {
      this.handleDatabaseFailure(error);
    }
  }

  private async processPersistentJob(job: MediaIndexReconcileJob): Promise<void> {
    if (!job.leaseToken) return;
    const heartbeat = this.startLeaseHeartbeat(job);
    try {
      const runtime = this.runtimes.get(job.stageId);
      if (!runtime || runtime.configRevision !== job.configRevision) {
        await heartbeat.stop();
        assertCommitLease(heartbeat.isValid, job.stageId);
        await this.repository.completeReconcile(job.id, job.leaseToken, job.eventRevision);
        await this.refreshPendingCount(job.stageId);
        return;
      }
      if (job.kind === 'FULL') await this.refreshStageInternal(job.stageId, heartbeat.isValid);
      else if (job.relativeTaskDirectory) await this.runTaskRefresh(job.stageId, job.relativeTaskDirectory, heartbeat.isValid);
      await heartbeat.stop();
      assertCommitLease(heartbeat.isValid, job.stageId);
      await this.repository.completeReconcile(job.id, job.leaseToken, job.eventRevision);
      await this.refreshPendingCount(job.stageId);
    } catch (error) {
      await heartbeat.stop();
      await this.repository.failReconcile({
        id: job.id, leaseToken: job.leaseToken, eventRevision: job.eventRevision, error: errorMessage(error)
      }).catch((repositoryError) => this.handleDatabaseFailure(repositoryError, job.stageId));
    } finally {
      await heartbeat.stop();
    }
  }

  private startLeaseHeartbeat(job: MediaIndexReconcileJob): { isValid: () => boolean; stop: () => Promise<void> } {
    let valid = true;
    let stopped = false;
    let renewal: Promise<void> | undefined;
    const renew = (): void => {
      if (stopped || renewal) return;
      renewal = this.repository.renewReconcileLease(job.id, job.leaseToken!, this.options.leaseMs)
        .then((renewed) => { if (!renewed) valid = false; })
        .catch((error) => {
          valid = false;
          this.handleDatabaseFailure(error, job.stageId);
        })
        .finally(() => { renewal = undefined; });
    };
    const timer = setInterval(renew, Math.max(1_000, Math.floor(this.options.leaseMs / 3)));
    timer.unref?.();
    return {
      isValid: () => valid,
      stop: async () => {
        if (!stopped) {
          stopped = true;
          clearInterval(timer);
        }
        await renewal?.catch(() => undefined);
      }
    };
  }

  private async processMemoryQueue(): Promise<void> {
    const jobs = [...this.memoryQueue.values()];
    this.memoryQueue.clear();
    for (const stageId of new Set(jobs.map((job) => job.stageId))) this.refreshMemoryPendingCount(stageId);
    for (const job of jobs) {
      try {
        if (job.kind === 'FULL') await this.refreshStage(job.stageId);
        else if (job.relativeTaskDirectory) await this.runTaskRefresh(job.stageId, job.relativeTaskDirectory);
      } catch {
        this.enqueueMemory(job);
      }
    }
  }

  private async tryDatabaseRecovery(): Promise<void> {
    if (!this.repository.configured) return;
    try {
      await this.repository.initialize();
      if (!this.repository.connected) return;
      await this.repository.recoverExpiredLeases();
      await this.repository.recoverStaleBuildingGenerations(6 * 60 * 60_000);
      this.databaseAvailable = true;
      this.scanner.setPersistentIndexAuthoritative(true);
      const memoryStages = new Set([...this.memoryQueue.values()].map((job) => job.stageId));
      this.memoryQueue.clear();
      await this.syncConfig();
      for (const stageId of memoryStages) await this.enqueueFull(stageId);
      this.logger.info('媒体索引 PostgreSQL 连接已恢复，已重新排队全量校准');
    } catch {
      // The pool reconnects lazily. Keep serving the last complete memory generation.
    }
  }

  private startTimers(): void {
    this.queueTimer = setInterval(() => this.trackBackground(this.processQueue(), '媒体索引队列轮询失败'), this.options.queuePollMs);
    this.shallowTimer = setInterval(() => this.trackBackground(this.runShallowValidation(), '媒体索引浅校验失败'), this.options.shallowIntervalMs);
    this.fullTimer = setInterval(() => {
      if (this.closed) return;
      for (const stage of this.config.get().stages.filter(isIndexedStage)) {
        this.trackBackground(this.enqueueFull(stage.id), '媒体索引周期全量排队失败');
      }
    }, this.options.fullIntervalMs);
    this.queueTimer.unref?.();
    this.shallowTimer.unref?.();
    this.fullTimer.unref?.();
  }

  private async runShallowValidation(): Promise<void> {
    if (this.closed) return;
    const stages = this.config.get().stages.filter(isIndexedStage);
    await Promise.all(stages.map(async (stage) => {
      try {
        const rootProbe = await readDirectoryProbe(stage.candidateRoot!, stage.id);
        const queueProbe = await probeQueueDirectories(stage.inputQueueRoot, this.getState(stage.id).queueCount);
        const queueCount = queueProbe.count;
        const runtime = this.runtimes.get(stage.id);
        const changed = runtime?.rootFingerprint !== undefined
          && (runtime.rootFingerprint !== rootProbe.fingerprint || runtime.rootDirectoryCount !== rootProbe.count);
        if (runtime) {
          runtime.rootFingerprint ??= rootProbe.fingerprint;
          runtime.rootDirectoryCount ??= rootProbe.count;
        }
        const watcherStatus = queueProbe.error
          ? (this.getState(stage.id).watcherStatus === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'DEGRADED')
          : this.getState(stage.id).watcherStatus;
        this.setState(stage.id, {
          queueCount,
          watcherStatus,
          ...(queueProbe.error ? { status: 'STALE' as const, error: queueProbe.error } : {})
        });
        const runtimePersisted = await this.updateSourceRuntime(stage.id, {
          queueCount,
          rootFingerprint: rootProbe.fingerprint,
          rootDirectoryCount: rootProbe.count,
          shallowCheckedAt: this.nowIso(),
          watcherStatus,
          lastError: queueProbe.error || null
        });
        if (this.repository.configured && !runtimePersisted) {
          throw new AppError('MEDIA_INDEX_DATABASE_UNAVAILABLE', '媒体索引浅校验状态持久化失败', { stageId: stage.id }, 503);
        }
        if (changed) await this.enqueueFull(stage.id);
        if (this.getState(stage.id).watcherStatus !== 'ACTIVE') this.startStageWatchers(stage, true);
      } catch (error) {
        this.setState(stage.id, { status: this.scanner.hasStageSnapshot(stage.id) ? 'STALE' : 'ERROR', error: errorMessage(error) });
        await this.enqueueFull(stage.id);
      }
    }));
  }

  private startStageWatchers(stage: StageConfig, force = false): void {
    if (this.closed || !isIndexedStage(stage)) return;
    const current = this.watchers.get(stage.id);
    if (!force && current?.candidateRoot === stage.candidateRoot && current?.inputQueueRoot === stage.inputQueueRoot
      && this.getState(stage.id).watcherStatus === 'ACTIVE') return;
    const restartTimer = this.watcherRestartTimers.get(stage.id);
    if (restartTimer) clearTimeout(restartTimer);
    this.watcherRestartTimers.delete(stage.id);
    this.stopStageWatchers(stage.id);
    const next: StageWatchers = { token: randomUUID(), candidateRoot: stage.candidateRoot, inputQueueRoot: stage.inputQueueRoot };
    this.setState(stage.id, { watcherStatus: 'STARTING' });
    try {
      next.candidate = this.options.watcherFactory(stage.candidateRoot!, { recursive: true }, (eventType, filename) => {
        if (!this.isCurrentWatcher(stage.id, next.token)) return;
        this.markCandidateDirty(stage.id, eventType, filename);
      });
    } catch (error) {
      closeWatchers(next);
      this.setState(stage.id, { watcherStatus: 'UNAVAILABLE', status: this.scanner.hasStageSnapshot(stage.id) ? 'STALE' : 'WARMING', error: errorMessage(error) });
      this.trackBackground(this.enqueueFull(stage.id), 'watcher 启动失败后的全量排队失败');
      this.scheduleWatcherRestart(stage.id);
      return;
    }
    this.watchers.set(stage.id, next);
    next.candidate.on('error', (error) => this.handleWatcherError(stage.id, error, next.token, 'candidate'));
    let watcherStatus: MediaIndexWatcherStatus = 'ACTIVE';
    let watcherError: string | undefined;
    if (stage.inputQueueRoot) {
      try {
        next.inputQueue = this.options.watcherFactory(stage.inputQueueRoot, { recursive: false }, () => {
          if (!this.isCurrentWatcher(stage.id, next.token)) return;
          this.recordStageEvent(stage.id);
          this.scheduleDirty({ stageId: stage.id, kind: 'QUEUE' });
        });
        next.inputQueue.on('error', (error) => this.handleWatcherError(stage.id, error, next.token, 'inputQueue'));
      } catch (error) {
        watcherStatus = 'DEGRADED';
        watcherError = errorMessage(error);
      }
    }
    this.setState(stage.id, {
      watcherStatus,
      ...(watcherError ? { status: this.scanner.hasStageSnapshot(stage.id) ? 'STALE' : 'WARMING', error: watcherError } : { error: undefined })
    });
    if (watcherStatus === 'ACTIVE') this.watcherRestartAttempts.delete(stage.id);
    else this.scheduleWatcherRestart(stage.id);
    this.trackBackground(this.updateSourceRuntime(stage.id, {
      queueCount: this.getState(stage.id).queueCount,
      watcherStatus,
      lastError: watcherError || null
    }), 'watcher 状态持久化失败');
  }

  private stopStageWatchers(stageId: string): void {
    const current = this.watchers.get(stageId);
    this.watchers.delete(stageId);
    if (current) closeWatchers(current);
  }

  private isCurrentWatcher(stageId: string, token: string): boolean {
    return !this.closed && this.watchers.get(stageId)?.token === token;
  }

  private markCandidateDirty(stageId: string, eventType: string, filename: string | Buffer | null): void {
    if (this.closed || !this.runtimes.has(stageId)) return;
    const now = Date.now();
    this.recordStageEvent(stageId);
    if (!filename) {
      this.scheduleDirty({ stageId, kind: 'FULL' });
      return;
    }
    const raw = Buffer.isBuffer(filename) ? filename.toString('utf8') : filename;
    const first = raw.replaceAll('\\', '/').split('/').filter(Boolean)[0];
    if (!first || eventType === 'rename' && raw.replaceAll('\\', '/').split('/').filter(Boolean).length === 0) {
      this.scheduleDirty({ stageId, kind: 'FULL' });
      return;
    }
    let relative: string;
    try { relative = normalizeTaskDirectory(first); }
    catch { this.scheduleDirty({ stageId, kind: 'FULL' }); return; }
    const burst = this.dirtyBursts.get(stageId);
    const activeBurst = !burst || now - burst.startedAt > DIRTY_BURST_WINDOW_MS ? { startedAt: now, tasks: new Set<string>() } : burst;
    activeBurst.tasks.add(relative);
    this.dirtyBursts.set(stageId, activeBurst);
    const indexedCount = this.scanner.exportStageSnapshot(stageId)?.tasks.length || 0;
    if (activeBurst.tasks.size >= DIRTY_TASK_THRESHOLD || (indexedCount >= DIRTY_TASK_THRESHOLD && activeBurst.tasks.size / indexedCount >= 0.2)) {
      this.cancelTaskDebounces(stageId);
      this.scheduleDirty({ stageId, kind: 'FULL' });
      return;
    }
    this.scheduleDirty({ stageId, kind: 'TASK', relativeTaskDirectory: relative });
  }

  private scheduleDirty(input: { stageId: string; kind: DirtyTimer['kind']; relativeTaskDirectory?: string }): void {
    if (this.closed || !this.runtimes.has(input.stageId)) return;
    const key = dirtyKey(input.stageId, input.kind, input.relativeTaskDirectory);
    const current = this.dirtyTimers.get(key);
    const firstAt = current?.firstAt ?? Date.now();
    if (current) clearTimeout(current.timer);
    const elapsed = Date.now() - firstAt;
    const delay = Math.max(0, Math.min(this.options.debounceMs, MAX_DIRTY_WAIT_MS - elapsed));
    const timer = setTimeout(() => {
      this.dirtyTimers.delete(key);
      if (this.closed || !this.runtimes.has(input.stageId)) return;
      if (input.kind === 'FULL') this.trackBackground(this.enqueueFullAndProcess(input.stageId), 'watcher 全量排队失败');
      else if (input.kind === 'TASK' && input.relativeTaskDirectory) this.trackBackground(this.enqueueTaskAndProcess(input.stageId, input.relativeTaskDirectory), 'watcher 任务排队失败');
      else this.trackBackground(this.refreshQueueCount(input.stageId), '输入队列计数刷新失败');
    }, delay);
    timer.unref?.();
    this.dirtyTimers.set(key, { ...input, firstAt, timer });
  }

  private cancelTaskDebounces(stageId: string): void {
    for (const [key, dirty] of this.dirtyTimers) {
      if (dirty.stageId !== stageId || dirty.kind !== 'TASK') continue;
      clearTimeout(dirty.timer);
      this.dirtyTimers.delete(key);
    }
  }

  private async refreshQueueCount(stageId: string): Promise<void> {
    if (this.closed || !this.runtimes.has(stageId)) return;
    try {
      const stage = this.requireStage(stageId);
      const queueCount = await countTopLevelDirectories(stage.inputQueueRoot);
      this.setState(stageId, { queueCount, lastEventAt: this.nowIso() });
      await this.updateSourceRuntime(stageId, {
        queueCount,
        watcherStatus: this.getState(stageId).watcherStatus,
        lastEventAt: this.getState(stageId).lastEventAt
      });
    } catch (error) {
      this.setState(stageId, {
        status: this.scanner.hasStageSnapshot(stageId) ? 'STALE' : 'ERROR',
        error: errorMessage(error)
      });
      await this.persistFailure(stageId, error);
    }
  }

  private handleWatcherError(stageId: string, error: unknown, token?: string, kind: 'candidate' | 'inputQueue' = 'candidate'): void {
    if (this.closed || token && !this.isCurrentWatcher(stageId, token)) return;
    if (kind === 'inputQueue') {
      const current = this.watchers.get(stageId);
      try { current?.inputQueue?.close(); } catch { /* already closed */ }
      if (current) current.inputQueue = undefined;
    } else {
      this.stopStageWatchers(stageId);
    }
    this.setState(stageId, {
      watcherStatus: 'DEGRADED',
      status: this.scanner.hasStageSnapshot(stageId) ? 'STALE' : 'WARMING',
      error: errorMessage(error)
    });
    this.trackBackground(this.updateSourceRuntime(stageId, {
      queueCount: this.getState(stageId).queueCount,
      watcherStatus: 'DEGRADED',
      lastError: errorMessage(error)
    }), 'watcher 降级状态持久化失败');
    this.scheduleDirty({ stageId, kind: kind === 'candidate' ? 'FULL' : 'QUEUE' });
    this.scheduleWatcherRestart(stageId);
  }

  private scheduleWatcherRestart(stageId: string): void {
    if (this.closed || this.watcherRestartTimers.has(stageId) || !this.runtimes.has(stageId)) return;
    const attempt = (this.watcherRestartAttempts.get(stageId) || 0) + 1;
    if (attempt > MAX_WATCHER_RESTART_ATTEMPTS) return;
    this.watcherRestartAttempts.set(stageId, attempt);
    const delay = Math.min(30_000, this.options.debounceMs * 2 ** (attempt - 1));
    const timer = setTimeout(() => {
      this.watcherRestartTimers.delete(stageId);
      if (this.closed || !this.runtimes.has(stageId)) return;
      const stage = this.config.get().stages.find((item) => item.id === stageId);
      if (!stage || !isIndexedStage(stage)) return;
      this.startStageWatchers(stage, true);
    }, delay);
    timer.unref?.();
    this.watcherRestartTimers.set(stageId, timer);
  }

  private handleScannerInvalidation(event: IndexedTaskInvalidation): void {
    if (this.closed) return;
    this.trackBackground(this.enqueueTaskAndProcess(event.stageId, event.relativeTaskDirectory), '缓存失效后的任务排队失败');
  }

  private async enqueueFullAndProcess(stageId: string): Promise<void> {
    await this.enqueueFull(stageId);
    await this.processQueue();
  }

  private async enqueueTaskAndProcess(stageId: string, relativeTaskDirectory: string): Promise<void> {
    await this.enqueueTask(stageId, relativeTaskDirectory);
    await this.processQueue();
  }

  private async enqueueFull(stageId: string): Promise<void> {
    if (this.closed) return;
    const stage = this.requireStage(stageId);
    if (!isIndexedStage(stage)) return;
    const revision = this.runtimes.get(stageId)?.configRevision || stageConfigRevision(stage);
    if (this.databaseAvailable) {
      try {
        await this.repository.enqueueReconcile({ stageId, kind: 'FULL', configRevision: revision });
        await this.refreshPendingCount(stageId);
        return;
      } catch (error) {
        this.handleDatabaseFailure(error, stageId);
      }
    }
    this.enqueueMemory({ stageId, kind: 'FULL' });
  }

  private enqueueMemory(input: Omit<MemoryReconcile, 'eventRevision'> & { eventRevision?: number }): void {
    const fullKey = `${input.stageId}:FULL`;
    if (input.kind === 'FULL') {
      for (const [key, job] of this.memoryQueue) if (job.stageId === input.stageId) this.memoryQueue.delete(key);
    } else if (this.memoryQueue.has(fullKey)) {
      this.refreshMemoryPendingCount(input.stageId);
      return;
    }
    const key = input.kind === 'FULL' ? fullKey : `${input.stageId}:TASK:${input.relativeTaskDirectory}`;
    const current = this.memoryQueue.get(key);
    this.memoryQueue.set(key, { ...input, eventRevision: (current?.eventRevision || input.eventRevision || 0) + 1 });
    this.refreshMemoryPendingCount(input.stageId);
  }

  private refreshMemoryPendingCount(stageId: string): void {
    const pendingReconciliations = [...this.memoryQueue.values()].filter((job) => job.stageId === stageId).length;
    this.setState(stageId, { pendingReconciliations });
  }

  private hydrateRepositorySnapshot(stage: StageConfig, snapshot: MediaIndexSnapshot, source: MediaIndexSource): void {
    const candidateRoot = stage.candidateRoot;
    if (!candidateRoot) throw new AppError('CONFIG_INVALID', `流程 ${stage.id} 缺少候选目录`, { stageId: stage.id }, 409);
    const persisted = fromRepositorySnapshot({ ...stage, candidateRoot }, snapshot);
    this.scanner.hydrateStage(persisted);
    const sourceRuntime = source as MediaIndexSource & SourceRuntimeFields;
    const runtime = this.runtimes.get(stage.id);
    if (runtime) {
      runtime.rootFingerprint = snapshot.generation.rootFingerprint || snapshot.rootFingerprint;
      runtime.rootDirectoryCount = snapshot.generation.rootDirectoryCount ?? snapshot.rootDirectoryCount;
    }
    this.setState(stage.id, {
      stageId: stage.id,
      revision: snapshot.configRevision,
      status: sourceRuntime.lastError ? 'STALE' : 'READY',
      watcherStatus: normalizeWatcherStatus(snapshot.watcherStatus || source.watcherStatus),
      queueCount: snapshot.queueCount,
      activeGeneration: {
        id: snapshot.generation.id,
        configRevision: snapshot.configRevision,
        taskCount: snapshot.generation.taskCount,
        fileCount: snapshot.generation.fileCount,
        activatedAt: snapshot.generation.activatedAt
      },
      pendingReconciliations: 0,
      lastReconciledAt: sourceRuntime.lastReconciledAt || snapshot.generation.activatedAt,
      lastFullReconciledAt: sourceRuntime.lastFullReconciledAt || snapshot.generation.activatedAt,
      lastEventAt: sourceRuntime.lastEventAt,
      error: sourceRuntime.lastError
    });
  }

  private async updateSourceRuntime(stageId: string, input: SourceRuntimeUpdate): Promise<boolean> {
    if (!this.databaseAvailable) return false;
    try {
      await this.repository.updateSourceProbe(stageId, input);
      return true;
    } catch (error) {
      this.handleDatabaseFailure(error, stageId);
      return false;
    }
  }

  private recordStageEvent(stageId: string): void {
    if (this.closed || !this.runtimes.has(stageId)) return;
    const lastEventAt = this.nowIso();
    this.setState(stageId, { lastEventAt });
    this.pendingEventAt.set(stageId, lastEventAt);
    const current = this.eventPersistenceTimers.get(stageId);
    if (current) clearTimeout(current);
    const timer = setTimeout(() => {
      this.eventPersistenceTimers.delete(stageId);
      const pending = this.pendingEventAt.get(stageId);
      if (!pending || this.closed || !this.runtimes.has(stageId)) return;
      this.pendingEventAt.delete(stageId);
      this.trackBackground(this.updateSourceRuntime(stageId, {
        queueCount: this.getState(stageId).queueCount,
        watcherStatus: this.getState(stageId).watcherStatus,
        lastEventAt: pending
      }), 'watcher 事件时间持久化失败');
    }, this.options.debounceMs);
    timer.unref?.();
    this.eventPersistenceTimers.set(stageId, timer);
  }

  private async persistFailure(stageId: string, error: unknown): Promise<void> {
    await this.updateSourceRuntime(stageId, {
      queueCount: this.getState(stageId).queueCount,
      lastError: errorMessage(error),
      watcherStatus: this.getState(stageId).watcherStatus
    });
  }

  private handleDatabaseFailure(error: unknown, stageId?: string): void {
    const wasAvailable = this.databaseAvailable;
    this.databaseAvailable = false;
    this.scanner.setPersistentIndexAuthoritative(this.repository.configured);
    for (const id of this.states.keys()) {
      if (this.getState(id).status === 'DISABLED') continue;
      const hasSnapshot = this.scanner.hasStageSnapshot(id);
      this.setState(id, { status: hasSnapshot ? 'STALE' : 'ERROR', error: errorMessage(error) });
    }
    const affectedStages = stageId ? [stageId] : [...this.runtimes.keys()];
    if (!this.closed) for (const id of affectedStages) this.enqueueMemory({ stageId: id, kind: 'FULL' });
    if (wasAvailable) this.logger.warn({ err: error }, '媒体索引 PostgreSQL 运行时不可用，保留最近完整内存代');
  }

  private ensureState(stageId: string, status: MediaIndexStatus): void {
    if (!this.states.has(stageId)) this.states.set(stageId, defaultState(stageId, status, this.runtimes.get(stageId)?.configRevision || ''));
  }

  private setState(stageId: string, patch: Partial<MediaIndexState>): void {
    const previous = this.states.get(stageId) || defaultState(stageId, patch.status || 'WARMING', patch.revision || this.runtimes.get(stageId)?.configRevision || '');
    const next: MediaIndexState = { ...previous, ...patch, stageId };
    if (patch.activeGeneration === undefined && Object.prototype.hasOwnProperty.call(patch, 'activeGeneration')) delete next.activeGeneration;
    if (patch.error === undefined && Object.prototype.hasOwnProperty.call(patch, 'error')) delete next.error;
    this.states.set(stageId, next);
    const event = { stageId, state: cloneState(next) };
    for (const listener of this.listeners) listener(event);
  }

  private async refreshPendingCount(stageId: string): Promise<void> {
    if (!this.databaseAvailable) return;
    try {
      this.setState(stageId, { pendingReconciliations: await this.repository.countReconciliations(stageId) });
    } catch (error) {
      this.handleDatabaseFailure(error, stageId);
    }
  }

  private isCurrentRevision(stageId: string, revision: string): boolean {
    return this.runtimes.get(stageId)?.configRevision === revision;
  }

  private requireStage(stageId: string): StageConfig {
    const stage = this.config.get().stages.find((item) => item.id === stageId);
    if (!stage) throw new AppError('CONFIG_INVALID', '阶段不存在', { stageId }, 404);
    return stage;
  }

  private nowIso(): string {
    return this.options.now().toISOString();
  }

  private async withStageLock<T>(stageId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.stageLocks.get(stageId) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const chained = previous.catch(() => undefined).then(() => gate);
    this.stageLocks.set(stageId, chained);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.stageLocks.get(stageId) === chained) this.stageLocks.delete(stageId);
    }
  }

  private clearStageWork(stageId: string): void {
    for (const [key, dirty] of this.dirtyTimers) {
      if (dirty.stageId !== stageId) continue;
      clearTimeout(dirty.timer);
      this.dirtyTimers.delete(key);
    }
    const eventTimer = this.eventPersistenceTimers.get(stageId);
    if (eventTimer) clearTimeout(eventTimer);
    this.eventPersistenceTimers.delete(stageId);
    this.pendingEventAt.delete(stageId);
    const restartTimer = this.watcherRestartTimers.get(stageId);
    if (restartTimer) clearTimeout(restartTimer);
    this.watcherRestartTimers.delete(stageId);
    this.watcherRestartAttempts.delete(stageId);
    this.dirtyBursts.delete(stageId);
    for (const [key, job] of this.memoryQueue) if (job.stageId === stageId) this.memoryQueue.delete(key);
  }

  private trackBackground<T>(operation: Promise<T>, message: string): void {
    const tracked: Promise<unknown> = operation
      .catch((error) => this.logger.warn({ err: error }, message))
      .finally(() => this.backgroundFlights.delete(tracked));
    this.backgroundFlights.add(tracked);
  }
}

type SourceRuntimeFields = {
  lastReconciledAt?: string;
  lastFullReconciledAt?: string;
  lastEventAt?: string;
  lastError?: string;
};

type SourceRuntimeUpdate = Parameters<MediaIndexRepository['updateSourceProbe']>[1] & {
  lastReconciledAt?: string;
  lastFullReconciledAt?: string;
  lastEventAt?: string;
  lastError?: string | null;
};

function isIndexedStage(stage: StageConfig): stage is StageConfig & { candidateRoot: string } {
  return Boolean(stage.enabled && stage.reviewEnabled && stage.candidateRoot);
}

function stageConfigRevision(stage: StageConfig): string {
  const normalizedRoot = stage.candidateRoot ? normalizedFilesystemPath(stage.candidateRoot) : '';
  const normalizedQueue = stage.inputQueueRoot ? normalizedFilesystemPath(stage.inputQueueRoot) : '';
  return createHash('sha256').update(JSON.stringify({
    id: stage.id,
    enabled: stage.enabled,
    reviewEnabled: stage.reviewEnabled,
    candidateRoot: normalizedRoot,
    inputQueueRoot: normalizedQueue,
    mediaTypes: [...stage.mediaTypes].sort()
  })).digest('hex');
}

function normalizedFilesystemPath(value: string): string {
  const resolved = path.resolve(value).normalize('NFC');
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function normalizedInstancePath(value: string): string {
  return normalizedFilesystemPath(value);
}

function normalizeTaskDirectory(value: string): string {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '').normalize('NFC');
  const parts = normalized.split('/');
  if (!normalized || parts.length !== 1 || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new AppError('INVALID_RELATIVE_PATH', '任务目录必须是候选根目录下的一级相对目录', { relativeTaskDirectory: value });
  }
  return normalized;
}

function toRepositoryTask(task: PersistedMediaTaskSnapshot): MediaIndexTaskInput {
  return {
    relativeTaskDirectory: task.sourceFolderName.replaceAll('\\', '/'),
    sourceFolderName: task.sourceFolderName,
    imageCount: task.imageCount,
    videoCount: task.videoCount || 0,
    mediaCount: task.mediaCount || task.images.length,
    subfolderCount: task.subfolderCount,
    lastModifiedAt: task.lastModifiedAt,
    representativeImages: [...task.representativeImages],
    representativeMedia: task.representativeMedia?.map((item) => ({ ...item })) || [],
    files: task.images.map((file) => ({ ...file, relativePath: file.relativePath.replaceAll('\\', '/') }))
  };
}

async function requireReadableDirectory(root: string, stageId: string): Promise<void> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(root);
    await readdir(root);
  } catch (error) {
    throw new AppError('SOURCE_ROOT_UNAVAILABLE', '候选根目录暂时不可访问，已保留最近完整索引', {
      stageId,
      root,
      cause: errorMessage(error)
    }, 503);
  }
  if (!info.isDirectory()) {
    throw new AppError('SOURCE_ROOT_UNAVAILABLE', '候选根路径不是目录，已保留最近完整索引', { stageId, root }, 503);
  }
}

function fromRepositorySnapshot(stage: StageConfig & { candidateRoot: string }, snapshot: MediaIndexSnapshot): PersistedMediaStageSnapshot {
  return {
    stageId: stage.id,
    scannedAt: snapshot.generation.activatedAt,
    rootFingerprint: snapshot.generation.rootFingerprint || snapshot.rootFingerprint || mediaDirectoryFingerprint(snapshot.tasks.map((task) => task.sourceFolderName)),
    rootDirectoryCount: snapshot.generation.rootDirectoryCount ?? snapshot.rootDirectoryCount ?? snapshot.tasks.length,
    tasks: snapshot.tasks.map((task) => ({
      taskId: task.taskId,
      stageId: stage.id,
      sourceFolder: task.sourceFolder || path.join(stage.candidateRoot, task.sourceFolderName),
      sourceFolderName: task.sourceFolderName,
      imageCount: task.imageCount,
      videoCount: task.videoCount,
      mediaCount: task.mediaCount,
      subfolderCount: task.subfolderCount,
      lastModifiedAt: task.lastModifiedAt,
      representativeImages: [...task.representativeImages],
      representativeMedia: task.representativeMedia.map((item) => ({ ...item })),
      images: task.files.map((file) => ({ ...file }))
    }))
  };
}

async function readDirectoryProbe(root: string, stageId: string): Promise<{ fingerprint: string; count: number }> {
  let rootInfo: Awaited<ReturnType<typeof stat>>;
  let entries: Dirent[];
  try {
    rootInfo = await stat(root);
    if (!rootInfo.isDirectory()) throw new Error('not a directory');
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new AppError('SOURCE_ROOT_UNAVAILABLE', '候选根目录暂时不可访问，已保留最近浅校验基线', {
      stageId,
      root,
      cause: errorMessage(error)
    }, 503);
  }
  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && !entry.name.startsWith('_'))
    .map((entry) => entry.name);
  return { fingerprint: mediaDirectoryFingerprint(names), count: names.length };
}

async function countTopLevelDirectories(root?: string): Promise<number> {
  if (!root) return 0;
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.')).length;
  } catch (error) {
    throw new AppError('INPUT_QUEUE_ROOT_UNAVAILABLE', '输入队列目录暂时不可访问，已保留最近队列数量', {
      root,
      cause: errorMessage(error)
    }, 503);
  }
}

async function probeQueueDirectories(root: string | undefined, previousCount: number): Promise<{ count: number; error?: string }> {
  try {
    return { count: await countTopLevelDirectories(root) };
  } catch (error) {
    return { count: previousCount, error: errorMessage(error) };
  }
}

function stateFromSource(stageId: string, source: MediaIndexSource, status: MediaIndexStatus): MediaIndexState {
  const runtime = source as MediaIndexSource & SourceRuntimeFields;
  return {
    stageId,
    revision: source.configRevision,
    status,
    watcherStatus: normalizeWatcherStatus(source.watcherStatus),
    queueCount: source.queueCount,
    pendingReconciliations: 0,
    ...(runtime.lastReconciledAt ? { lastReconciledAt: runtime.lastReconciledAt } : {}),
    ...(runtime.lastFullReconciledAt ? { lastFullReconciledAt: runtime.lastFullReconciledAt } : {}),
    ...(runtime.lastEventAt ? { lastEventAt: runtime.lastEventAt } : {}),
    ...(runtime.lastError ? { error: runtime.lastError } : {})
  };
}

function normalizeWatcherStatus(value?: string): MediaIndexWatcherStatus {
  return ['ACTIVE', 'STARTING', 'DEGRADED', 'UNAVAILABLE', 'DISABLED'].includes(String(value))
    ? value as MediaIndexWatcherStatus
    : 'STARTING';
}

function defaultState(stageId: string, status: MediaIndexStatus, revision: string): MediaIndexState {
  return { stageId, revision, status, watcherStatus: status === 'DISABLED' ? 'DISABLED' : 'STARTING', queueCount: 0, pendingReconciliations: 0 };
}

function cloneState(state: MediaIndexState): MediaIndexState {
  return { ...state, ...(state.activeGeneration ? { activeGeneration: { ...state.activeGeneration } } : {}) };
}

function emptySnapshot(stageId: string, scannedAt: string): PersistedMediaStageSnapshot {
  return { stageId, scannedAt, rootFingerprint: mediaDirectoryFingerprint([]), rootDirectoryCount: 0, tasks: [] };
}

function closeWatchers(watchers: StageWatchers): void {
  try { watchers.candidate?.close(); } catch { /* already closed */ }
  try { watchers.inputQueue?.close(); } catch { /* already closed */ }
}

function dirtyKey(stageId: string, kind: DirtyTimer['kind'], relativeTaskDirectory?: string): string {
  return `${stageId}:${kind}:${relativeTaskDirectory || ''}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '未知媒体索引错误');
}

function assertCommitLease(canCommit: () => boolean, stageId: string): void {
  if (!canCommit()) throw new AppError('MEDIA_INDEX_LEASE_LOST', '媒体索引任务租约已失效，已阻止旧扫描结果提交', { stageId }, 409);
}
