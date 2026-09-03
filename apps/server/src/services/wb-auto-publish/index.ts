import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import {
  AppError,
  latestWbMediaDeliveryBatch,
  wbMediaMatchesVariant,
  type SubmissionRecord,
  type WbAutoPublishState,
  type WbNetworkRecovery,
  type WbStore,
  type WbStorePublication
} from '@n8n-media-review/shared';
import type { DeliveryReplayService } from '../delivery-replay.js';
import { stableHash } from '../review-operations.js';
import type { StateStore } from '../../repositories/store.js';
import type {
  WbAutoGenerationLeaseClaim,
  WbAutoPublishJob,
  WbAutoPublishRepository
} from '../../repositories/wb-auto-publish.js';
import type { WbStoreRepository } from '../../repositories/wb-stores.js';
import type { WbMediaAsset, WbRuntimeCardMatch } from '../../repositories/wb.js';
import type { WbPresetExecutionBinding, WbPresetService } from '../wb-presets/index.js';
import { wbMaterialPresetDefinitionHash } from '../wb-presets/material-hash.js';
import type { WbPublishingService } from '../wb-publishing/index.js';
import type { WbExistingCardBaseline, WbVendorCodeMatch } from '../wb-publishing/n8n-client.js';
import { wbTaskErrorDetails } from '../wb-publishing/task-error.js';
import { classifyWbNetworkError, nextWbNetworkRecovery, transportErrorCode } from '../wb-network-recovery.js';
import { resolveManifestMediaOrder } from '../manifest-media-order.js';
import {
  classifyWbPublicationDispatchError,
  unknownDispatchReadbackError
} from '../wb-publication-dispatch.js';
import type { WbSourceMediaCleanupService } from '../wb-source-media/index.js';

type JsonRecord = Record<string, any>;
type DeliveryNotification = {
  sku: string;
  stageId: 'E004' | 'E005';
  submissionId: string;
  variantId?: string;
  deliveredAt: string;
  /** Historical compensation must not make an already consumed delivery new again. */
  replay?: boolean;
};
type ManifestAsset = {
  submissionId?: string; sourceStageId?: string; variantId?: string; variantColor?: { colorKey?: string };
  relativePath?: string; sizeBytes?: number; sha256?: string; deliveredAt?: string; kind?: string; sortOrder?: unknown;
};

type CoordinatorOptions = { historyReplay?: DeliveryReplayService; workerIntervalMs?: number; reconciliationIntervalMs?: number; debounceMs?: number; stableWindowMs?: number; stableProbeMs?: number; concurrency?: number };

const NON_NETWORK_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
const SUBMITTED_STATES = new Set(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED']);

export class WbAutoPublishingCoordinator {
  private stopped = true;
  private workerTimer?: NodeJS.Timeout;
  private reconciliationTimer?: NodeJS.Timeout;
  private workerPromise?: Promise<void>;
  private reconciliationPromise?: Promise<void>;
  private lastReconciledAt?: string;
  private readonly workerId = randomUUID();
  private readonly workerIntervalMs: number;
  private readonly reconciliationIntervalMs: number;
  private readonly debounceMs: number;
  private readonly stableWindowMs: number;
  private readonly stableProbeMs: number;
  private readonly concurrency: number;

  constructor(
    readonly repository: WbAutoPublishRepository,
    private readonly presets: WbPresetService,
    private readonly publishing: WbPublishingService,
    private readonly store: StateStore,
    private readonly logger: FastifyBaseLogger,
    private readonly options: CoordinatorOptions = {},
    private readonly wbStores?: WbStoreRepository,
    private readonly sourceMediaCleanup?: WbSourceMediaCleanupService
  ) {
    this.workerIntervalMs = Math.max(1_000, options.workerIntervalMs ?? 10_000);
    this.reconciliationIntervalMs = Math.max(5_000, options.reconciliationIntervalMs ?? 60_000);
    this.debounceMs = Math.max(0, options.debounceMs ?? 10_000);
    this.stableWindowMs = Math.max(0, options.stableWindowMs ?? 30_000);
    this.stableProbeMs = Math.max(0, options.stableProbeMs ?? 5_000);
    this.concurrency = Math.min(4, Math.max(1, options.concurrency ?? 2));
  }

  start(): void {
    if (!this.repository.configured || this.stopped === false) return;
    this.stopped = false;
    this.workerTimer = setInterval(() => { void this.runWorkerNow(); }, this.workerIntervalMs);
    this.reconciliationTimer = setInterval(() => { void this.reconcileNow(); }, this.reconciliationIntervalMs);
    void this.handlePresetChanged();
    void this.reconcileNow();
    void this.runWorkerNow();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.workerTimer) clearInterval(this.workerTimer);
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
    this.workerTimer = undefined;
    this.reconciliationTimer = undefined;
    await Promise.all([this.workerPromise?.catch(() => undefined), this.reconciliationPromise?.catch(() => undefined)]);
  }

  async onMediaDelivered(input: DeliveryNotification): Promise<WbAutoPublishJob | undefined> {
    if (!this.repository.configured) return undefined;
    if (!input.replay) await this.sourceMediaCleanup?.noteMediaDelivered(input.sku);
    if (!this.wbStores?.configured) return this.onMediaDeliveredLegacy(input);
    const [settings, stores] = await Promise.all([this.wbStores.getSettings(), this.wbStores.listStores()]);
    if (!settings.enabled) return undefined;
    const targets = stores.filter(isReadyAutoPublishStore);
    const replaySourceState = input.replay && this.sourceMediaCleanup
      ? await this.sourceMediaCleanup.sourceState(input.sku)
      : undefined;
    const outcomes = await Promise.all(targets.map(async (store) => {
      const locked = await this.repository.withSkuLock(input.sku, async () => {
        const existing = await this.repository.find(input.sku, store.id);
        if (input.replay && existing?.lastDeliveryAt) {
          const observedAt = Date.parse(existing.lastDeliveryAt);
          const deliveredAt = Date.parse(input.deliveredAt);
          if (Number.isFinite(observedAt) && Number.isFinite(deliveredAt) && observedAt >= deliveredAt) {
            if (observedAt > deliveredAt) return { kind: 'STALE_REPLAY', storeId: store.id, job: existing } as const;
            return { kind: 'REGISTERED', storeId: store.id, job: existing } as const;
          }
        }
        if (existing && !['SUCCEEDED', 'BLOCKED_EXISTING_CARD', 'CANCELLED'].includes(existing.state)) {
          const job = await this.repository.recordDelivery({ storeId: store.id, ...input, debounceUntil: new Date(Date.parse(input.deliveredAt) + this.debounceMs).toISOString() });
          return { kind: 'REGISTERED', storeId: store.id, job } as const;
        }
        const activationStartedAt = store.autoPublishActivatedAt;
        if (!activationStartedAt || Date.parse(input.deliveredAt) < Date.parse(activationStartedAt)) {
          return { kind: 'INELIGIBLE', storeId: store.id } as const;
        }
        const preset = store.defaultPresetId ? await this.presets.get(store.defaultPresetId) : undefined;
        if (!preset || preset.readiness !== 'READY') return { kind: 'INELIGIBLE', storeId: store.id } as const;
        const binding = this.presets.createExecutionBinding(preset, input.deliveredAt, activationStartedAt);
        const job = await this.repository.enqueueDelivery({
          storeId: store.id,
          ...input,
          preset: { id: binding.presetId, name: binding.presetName, rowVersion: binding.presetRowVersion, snapshot: binding.presetSnapshot },
          binding,
          materialPresetDefinitionHash: wbMaterialPresetDefinitionHash(binding),
          debounceUntil: new Date(Date.parse(input.deliveredAt) + this.debounceMs).toISOString(),
          operationMode: store.autoPublishMode
        });
        return job ? { kind: 'REGISTERED', storeId: store.id, job } as const
          : { kind: 'INELIGIBLE', storeId: store.id } as const;
      }, store.id);
      return locked.acquired && locked.value ? locked.value : { kind: 'LOCK_BUSY', storeId: store.id } as const;
    }));

    const registered = outcomes.filter((outcome) => outcome.kind === 'REGISTERED');
    const staleReplay = outcomes.some((outcome) => outcome.kind === 'STALE_REPLAY');
    const registrationIncomplete = outcomes.some((outcome) => outcome.kind === 'LOCK_BUSY');
    if (this.sourceMediaCleanup && targets.length && replaySourceState?.state !== 'CLEANED') {
      const previousExpectedStoreIds = targets.map((store) => store.id);
      if (staleReplay || registrationIncomplete || registered.length !== targets.length) {
        await this.sourceMediaCleanup.discardIncompleteAutomaticBatch({
          sku: input.sku,
          rootDirectory: settings.rootDirectory,
          deliveredAt: input.deliveredAt,
          submissionId: input.submissionId,
          expectedStoreIds: previousExpectedStoreIds
        });
      }
      if (!staleReplay && !registrationIncomplete && registered.length) {
        await this.sourceMediaCleanup.registerAutomaticBatch({
          sku: input.sku,
          rootDirectory: settings.rootDirectory,
          deliveredAt: input.deliveredAt,
          submissionId: input.submissionId,
          targets: registered.map(({ job }) => ({ storeId: job.storeId, jobId: job.id, runId: job.runId }))
        });
      }
    }
    const observedJobs = outcomes.flatMap((outcome) => 'job' in outcome && outcome.job ? [outcome.job] : []);
    return observedJobs.find((job) => job.storeId === '00000000-0000-4000-8000-000000000001') || observedJobs[0];
  }

  private async onMediaDeliveredLegacy(input: DeliveryNotification): Promise<WbAutoPublishJob | undefined> {
    const locked = await this.repository.withSkuLock(input.sku, async () => {
      const existing = await this.repository.find(input.sku);
      if (existing && !['SUCCEEDED', 'BLOCKED_EXISTING_CARD', 'CANCELLED'].includes(existing.state)) {
        return this.repository.recordDelivery({ ...input, debounceUntil: new Date(Date.parse(input.deliveredAt) + this.debounceMs).toISOString() });
      }
      const preset = await this.presets.getActiveAutoPreset();
      if (!preset || preset.readiness !== 'READY' || !preset.autoPublishActivatedAt) return undefined;
      if (Date.parse(input.deliveredAt) < Date.parse(preset.autoPublishActivatedAt)) return undefined;
      const binding = this.presets.createExecutionBinding(preset, input.deliveredAt);
      return this.repository.enqueueDelivery({
        ...input,
        preset: { id: binding.presetId, name: binding.presetName, rowVersion: binding.presetRowVersion, snapshot: binding.presetSnapshot },
        binding,
        materialPresetDefinitionHash: wbMaterialPresetDefinitionHash(binding),
        debounceUntil: new Date(Date.parse(input.deliveredAt) + this.debounceMs).toISOString(),
        operationMode: preset.autoPublishMode
      });
    });
    return locked.acquired ? locked.value : undefined;
  }

  async handlePresetChanged(): Promise<void> {
    if (!this.repository.configured) return;
    this.logger.info('WB 默认自动上品预设已更新；只影响之后首次投递的新 SKU');
  }

  async status() {
    const [countsByState, boundByPreset] = await Promise.all([this.repository.counts(), this.repository.boundCountsByPreset()]);
    const waiting = sum(countsByState, ['WAITING_MEDIA', 'WAITING_STABLE', 'WAITING_NETWORK', 'WAITING_GENERATION_TURN', 'CHECKING']);
    const processing = sum(countsByState, ['INITIALIZING', 'GENERATING', 'SUBMITTING', 'QUEUED', 'RUNNING']);
    const needsAttention = sum(countsByState, ['NEEDS_ATTENTION', 'PAUSED', 'BLOCKED_EXISTING_CARD', 'FAILED']);
    const total = Object.values(countsByState).reduce((left, right) => left + right, 0);
    const continuingBoundJobs = waiting + processing;
    let acceptingNewJobs: boolean;
    let enabled: boolean;
    let activePreset: { id: string; name: string; mode: string; activatedAt: string } | undefined;
    if (this.wbStores?.configured) {
      const [settings, stores] = await Promise.all([this.wbStores.getSettings(), this.wbStores.listStores()]);
      acceptingNewJobs = Boolean(settings.enabled && stores.some(isReadyAutoPublishStore));
      enabled = Boolean(settings.enabled && (acceptingNewJobs || continuingBoundJobs > 0));
    } else {
      const preset = await this.presets.getActiveAutoPreset();
      acceptingNewJobs = Boolean(preset?.readiness === 'READY' && preset.autoPublishActivatedAt);
      enabled = acceptingNewJobs;
      if (preset?.autoPublishActivatedAt) {
        activePreset = { id: preset.id, name: preset.name, mode: preset.autoPublishMode, activatedAt: preset.autoPublishActivatedAt };
      }
    }
    return {
      enabled, acceptingNewJobs, continuingBoundJobs,
      ...(activePreset ? { activePreset } : {}),
      counts: countsByState, boundByPreset,
      summary: { total, waiting, processing, needsAttention, succeeded: countsByState.SUCCEEDED || 0, cancelled: countsByState.CANCELLED || 0 },
      worker: { running: !this.stopped, ...(this.lastReconciledAt ? { lastReconciledAt: this.lastReconciledAt } : {}) }
    };
  }

  list(input: { page?: number; pageSize?: number; state?: string; query?: string; updatedFrom?: string; updatedTo?: string; storeId?: string }) { return this.repository.list(input); }
  get(sku: string, storeId?: string) { return this.repository.get(sku, storeId); }
  runs(sku: string, storeId?: string) { return this.repository.listRuns(sku, storeId); }
  boundCountsByPreset() { return this.repository.boundCountsByPreset(); }
  async recheck(sku: string, storeId?: string) {
    const locked = await this.repository.withSkuLock(sku, async () => {
      const job = await this.repository.get(sku, storeId);
      let binding: WbPresetExecutionBinding;
      try { binding = await this.bindingForJob(job); }
      catch (error) { throw new AppError('CONFIG_INVALID', error instanceof Error ? error.message : '任务的原模板快照无效', { sku }, 409); }
      if (!job.presetBinding) await this.repository.persistBinding(sku, binding, job.storeId);
      if (job.operationMode === 'COMPATIBLE_UPSERT' && job.n8nTaskId) {
        const runtimeJob = await this.publishing.repository.getRuntimeJob(job.n8nTaskId).catch((error) => {
          if (error instanceof AppError && error.code === 'NOT_FOUND') return undefined;
          throw error;
        });
        if (runtimeJob && isCompatibleRuntimeRecoveryCandidate(runtimeJob)) {
          const recovered = await this.recoverCompatibleForJob(job, runtimeJob);
          return recovered.automationJob;
        }
      }
      return this.repository.recheck(sku, job.storeId);
    }, storeId);
    if (!locked.acquired) throw new AppError('TASK_LOCKED', '自动上品任务正在推进，请稍后重试', { sku }, 409);
    void this.runWorkerNow();
    return locked.value!;
  }

  async recoverCompatibleRuntimeTask(taskIdInput: string) {
    const taskId = String(taskIdInput || '').trim();
    if (!taskId) throw new AppError('CONFIG_INVALID', 'taskId 必填');
    const runtimeJob = await this.publishing.repository.getRuntimeJob(taskId);
    if (!isCompatibleRuntimeRecoveryCandidate(runtimeJob)) {
      throw new AppError('CONFIG_INVALID', '任务不满足 FAILED + partialEffects + COMPATIBLE_UPSERT 恢复条件', {
        taskId, state: runtimeJob.state, partialEffects: runtimeJob.partial_effects
      }, 409);
    }
    const productCode = String(runtimeJob.productCode || runtimeJob.product_code || '').trim();
    const storeId = String(runtimeJob.storeId || runtimeJob.store_id || '00000000-0000-4000-8000-000000000001');
    if (!productCode) throw new AppError('COMPATIBLE_RECOVERY_UNSAFE', 'runtime task 缺少 productCode', { taskId }, 409);
    const locked = await this.repository.withSkuLock(productCode, async () => {
      const job = await this.repository.get(productCode, storeId);
      if (job.n8nTaskId !== taskId) {
        throw new AppError('COMPATIBLE_RECOVERY_UNSAFE', '自动任务当前绑定的 n8n task 与恢复请求不一致', {
          taskId, currentTaskId: job.n8nTaskId, sku: productCode
        }, 409);
      }
      return this.recoverCompatibleForJob(job, runtimeJob);
    }, storeId);
    if (!locked.acquired) throw new AppError('TASK_LOCKED', '自动上品任务正在推进，请稍后重试', { taskId, sku: productCode }, 409);
    return locked.value!;
  }
  async cancel(sku: string, storeId?: string) {
    const locked = await this.repository.withSkuLock(sku, () => this.repository.cancel(sku, storeId), storeId);
    if (!locked.acquired) throw new AppError('TASK_LOCKED', '自动上品任务正在推进，暂不能取消', { sku }, 409);
    await this.flushPendingNotifications();
    return locked.value!;
  }

  async startCompatible(sku: string, storeId?: string) {
    const locked = await this.repository.withSkuLock(sku, async () => {
      const selectedStore = storeId && this.wbStores?.configured ? await this.wbStores.getStore(storeId) : undefined;
      const preset = selectedStore?.defaultPresetId
        ? await this.presets.get(selectedStore.defaultPresetId)
        : selectedStore ? undefined : await this.presets.getActiveAutoPreset();
      const compatibleEnabled = selectedStore
        ? selectedStore.enabled && selectedStore.autoPublishEnabled && selectedStore.autoPublishMode === 'COMPATIBLE_UPSERT'
        : Boolean(preset?.autoPublishEnabled && preset?.autoPublishMode === 'COMPATIBLE_UPSERT');
      if (!preset || preset.readiness !== 'READY' || !compatibleEnabled) {
        throw new AppError('CONFIG_INVALID', '当前默认预设未启用“兼容既有商品”自动上品策略', undefined, 409);
      }
      const listing = await this.publishing.repository.getListing(sku);
      if (!['SUCCEEDED', 'FAILED', 'BLOCKED'].includes(listing.status)) {
        throw new AppError('TASK_LOCKED', '当前上品资料尚未结束，不能启动重新上品', { sku, status: listing.status }, 409);
      }
      const productVariants = await this.publishing.productVariants(sku);
      const colored = productVariants.filter((variant) => variant.wbColor);
      const expected = colored.length ? colored : productVariants;
      if (!expected.length) throw new AppError('CONFIG_INVALID', '产品没有可用于 WB 重新上品的变体');
      const now = new Date().toISOString();
      const binding = this.presets.createExecutionBinding(preset, now, selectedStore?.autoPublishActivatedAt || now);
      return this.repository.startCompatible({
        storeId,
        sku,
        preset: { id: binding.presetId, name: binding.presetName, rowVersion: binding.presetRowVersion, snapshot: binding.presetSnapshot },
        binding,
        materialPresetDefinitionHash: wbMaterialPresetDefinitionHash(binding),
        variantIds: expected.map((variant) => variant.variantId),
        baseRevision: listing.draftVersion
      });
    }, storeId);
    if (!locked.acquired) throw new AppError('TASK_LOCKED', '该 SKU 的自动上品任务正在推进，请稍后重试', { sku }, 409);
    void this.runWorkerNow();
    return locked.value!;
  }

  async reconcileNow(): Promise<void> {
    if (this.reconciliationPromise) return this.reconciliationPromise;
    const operation = this.reconcileOnce();
    this.reconciliationPromise = operation;
    try { await operation; } finally { if (this.reconciliationPromise === operation) this.reconciliationPromise = undefined; }
  }

  async runWorkerNow(): Promise<void> {
    if (this.workerPromise) return this.workerPromise;
    const operation = (async () => {
      try { await this.workerOnce(); }
      finally { await this.flushPendingNotifications(); }
    })();
    this.workerPromise = operation;
    try { await operation; } finally { if (this.workerPromise === operation) this.workerPromise = undefined; }
  }

  private async reconcileOnce(): Promise<void> {
    try {
      // Publication/runtime terminal projection must never wait behind a slow
      // historical media replay. In particular, cleaned source folders are no
      // longer available for hashing, while their submitted jobs still need to
      // reach SUCCEEDED/FAILED and release the cleanup gate.
      await this.synchronizeSubmittedJobs();
      const earliestOpenBindingAt = await this.repository.earliestOpenBindingAt();
      const cutoffInputs: Array<string | undefined> = [earliestOpenBindingAt];
      if (this.wbStores?.configured) {
        const [settings, stores] = await Promise.all([this.wbStores.getSettings(), this.wbStores.listStores()]);
        if (settings.enabled) {
          cutoffInputs.push(...stores.filter(isReadyAutoPublishStore).map((store) => store.autoPublishActivatedAt));
        }
      } else {
        const preset = await this.presets.getActiveAutoPreset();
        cutoffInputs.push(preset?.autoPublishActivatedAt);
      }
      const cutoffs = cutoffInputs.filter((value): value is string => Boolean(value)).map(Date.parse).filter(Number.isFinite);
      const cutoff = cutoffs.length ? Math.min(...cutoffs) : Number.POSITIVE_INFINITY;
      const deliveries = (this.options.historyReplay ? this.store.section('submissionHistory') : this.store.read().submissionHistory)
        .filter(isSuccessfulWbDelivery)
        .filter((record) => Date.parse(record.completedAt || record.startedAt) >= cutoff)
        .sort((left, right) => Date.parse(left.completedAt || left.startedAt) - Date.parse(right.completedAt || right.startedAt));
      const replayRecord = async (record: SubmissionRecord): Promise<boolean> => {
        try {
          const input = { sku: record.productSku!, stageId: record.sourceStageId as 'E004' | 'E005', submissionId: record.submissionId,
            ...(record.variantId ? { variantId: record.variantId } : {}), deliveredAt: record.completedAt || record.startedAt, replay: true };
          if (this.sourceMediaCleanup?.confirmsCleanedDelivery && await this.sourceMediaCleanup.confirmsCleanedDelivery(input)) return true;
          await this.onMediaDelivered(input);
          return true;
        } catch (error) {
          this.logger.warn({ err: error, sku: record.productSku, submissionId: record.submissionId }, 'WB 自动上品历史媒体投递补偿失败，保留原记录等待重试');
          return false;
        }
      };
      if (this.options.historyReplay) await this.options.historyReplay.run('WB', deliveries, stableHash(cutoffInputs), replayRecord);
      else for (const record of deliveries) await replayRecord(record);
      this.lastReconciledAt = new Date().toISOString();
    } catch (error) {
      this.logger.warn({ err: error }, 'WB 自动上品补偿检查失败');
    } finally {
      await this.flushPendingNotifications();
    }
  }

  private async flushPendingNotifications(): Promise<void> {
    let pending;
    try {
      pending = await this.repository.listPendingNotificationActions(100);
    } catch (error) {
      this.logger.warn({ err: error }, 'WB 自动上品通知待办读取失败，稍后重试');
      return;
    }
    for (const item of pending) {
      const failure = asObject(item.payload.failure);
      const resolution = asObject(item.payload.resolution);
      let notificationError: string | undefined;
      if (item.action === 'EMIT_FAILURE') {
        notificationError = await this.emitFailureSnapshot(failure);
      } else {
        // If the process crashed before the earlier EMIT was acknowledged, the
        // RESOLVE action still carries its immutable failure snapshot. Upsert it
        // first, then resolve it; both operations are idempotent.
        if (Object.keys(failure).length) notificationError = await this.emitFailureSnapshot(failure);
        if (!notificationError) {
          notificationError = await this.publishing.resolveAutoPublishFailure({
            ...(resolution.jobId ? { jobId: String(resolution.jobId) } : {}),
            ...(resolution.storeId ? { storeId: String(resolution.storeId) } : {}),
            ...(resolution.runId ? { runId: String(resolution.runId) } : {}),
            sku: String(resolution.sku || item.job.sku),
            jobCreatedAt: String(resolution.jobCreatedAt || item.job.createdAt),
            state: String(resolution.state || item.job.state)
          });
        }
      }
      if (notificationError) {
        this.logger.warn({ sku: item.job.sku, action: item.action, notificationError }, 'WB 自动上品通知动作失败，稍后重试');
        continue;
      }
      try {
        if (item.job.storeId && item.job.storeId !== '00000000-0000-4000-8000-000000000001') {
          await this.repository.completeNotificationAction(item.job.sku, item.action, item.payload, item.job.storeId);
        } else {
          await this.repository.completeNotificationAction(item.job.sku, item.action, item.payload);
        }
      } catch (error) {
        this.logger.warn({ err: error, sku: item.job.sku, action: item.action }, 'WB 自动上品通知动作确认失败，稍后重试');
      }
    }
  }

  private async emitFailureSnapshot(snapshot: JsonRecord): Promise<string | undefined> {
    return this.publishing.notifyAutoPublishFailure({
      ...(snapshot.jobId ? { jobId: String(snapshot.jobId) } : {}),
      ...(snapshot.storeId ? { storeId: String(snapshot.storeId) } : {}),
      sku: String(snapshot.sku || ''),
      state: String(snapshot.state || 'NEEDS_ATTENTION'),
      jobCreatedAt: String(snapshot.jobCreatedAt || ''),
      errorCode: String(snapshot.errorCode || 'AUTO_PUBLISH_FAILED'),
      errorMessage: String(snapshot.errorMessage || '自动上品任务执行失败'),
      ...(snapshot.runId ? { runId: String(snapshot.runId) } : {}),
      ...(snapshot.runNo ? { runNo: Number(snapshot.runNo) } : {}),
      operationMode: snapshot.operationMode === 'COMPATIBLE_UPSERT' ? 'COMPATIBLE_UPSERT' : 'CREATE_ONLY',
      ...(snapshot.presetName ? { presetName: String(snapshot.presetName) } : {}),
      ...(snapshot.taskId ? { taskId: String(snapshot.taskId) } : {})
    });
  }

  private async synchronizeSubmittedJobs(): Promise<void> {
    for (const job of await this.repository.listSubmitted()) {
      try {
        if (job.publicationId && this.wbStores) {
          const publication = await this.wbStores.syncPublication(job.publicationId);
          const target = publication.status === 'SUCCEEDED' ? 'SUCCEEDED'
            : publication.status === 'FAILED' ? 'FAILED'
              : publication.status === 'NEEDS_ATTENTION' ? 'NEEDS_ATTENTION'
                : publication.status === 'RUNNING' ? 'RUNNING' : 'QUEUED';
          if (job.state !== target || job.lastErrorCode !== publication.errorCode || job.lastErrorMessage !== publication.errorMessage) {
            await this.transitionJob(job, target, {
              eventType: 'PUBLICATION_STATUS_SYNCED',
              message: `店铺发布状态已同步为 ${publication.status}`,
              n8nTaskId: publication.taskId,
              nextAttemptAt: null,
              errorCode: publication.errorCode || null,
              errorMessage: publication.errorMessage || null
            });
            if (target === 'SUCCEEDED' || target === 'FAILED' || target === 'NEEDS_ATTENTION') {
              await this.repository.setListingLock(job.sku, false);
            }
          }
          continue;
        }
        // 必须直接回读 n8n，而不是只读取本地草稿状态。运维恢复同一个
        // n8n task 后，本地 FAILED 才能重新进入 QUEUED/RUNNING 并继续同步。
        const { listing, task, pollError } = await this.publishing.reconcileTaskStatus(job.sku);
        if (pollError) {
          const listingRecovery = asNetworkRecovery(asObject(listing).networkRecovery);
          if (listingRecovery) {
            const nextRecovery = { ...listingRecovery, resumeState: job.networkRecovery?.resumeState || job.state };
            const shouldRefreshWait = job.state !== 'WAITING_NETWORK'
              || job.nextAttemptAt !== listingRecovery.nextAttemptAt
              || job.networkRecovery?.attempt !== listingRecovery.attempt;
            if (shouldRefreshWait) {
              await this.transitionJob(job, 'WAITING_NETWORK', {
                eventType: 'LISTING_STATUS_NETWORK_WAIT',
                message: pollError,
                details: { taskId: job.n8nTaskId, networkAttempt: listingRecovery.attempt },
                nextAttemptAt: listingRecovery.nextAttemptAt,
                networkRecovery: nextRecovery,
                errorCode: listingRecovery.lastErrorCode,
                errorMessage: listingRecovery.lastErrorMessage
              });
            }
          }
          continue;
        }
        const target = listing.status === 'SUCCEEDED' ? 'SUCCEEDED' : listing.status === 'FAILED' || listing.status === 'BLOCKED' ? 'FAILED'
          : listing.status === 'NEEDS_ATTENTION' ? 'NEEDS_ATTENTION'
            : listing.status === 'RUNNING' ? 'RUNNING' : 'QUEUED';
        const failedListing = listing.status === 'FAILED' || listing.status === 'BLOCKED';
        const attentionListing = listing.status === 'NEEDS_ATTENTION';
        const taskError = failedListing ? wbTaskErrorDetails(listing, task) : attentionListing ? {
          errorCode: 'WB_WRITE_OUTCOME_AMBIGUOUS',
          errorMessage: listing.lastError || 'WB 写入结果持续无法确认，需要人工按原 taskId 重新检查'
        } : undefined;
        const shouldRefresh = job.state !== target
          || ((failedListing || attentionListing) && (job.lastErrorCode !== taskError?.errorCode
            || (job.lastErrorMessage || null) !== taskError?.errorMessage))
          || (!failedListing && !attentionListing && Boolean(job.lastErrorCode || job.lastErrorMessage));
        if (shouldRefresh) {
          await this.transitionJob(job, target, {
            eventType: 'LISTING_STATUS_SYNCED', message: `WB 任务状态已同步为 ${listing.status}`,
            n8nTaskId: listing.n8nTaskId, nextAttemptAt: null,
            errorCode: taskError?.errorCode || null,
            errorMessage: taskError?.errorMessage || null
          });
          if (target === 'SUCCEEDED' || target === 'FAILED' || target === 'NEEDS_ATTENTION') await this.repository.setListingLock(job.sku, false);
        }
      } catch (error) { this.logger.warn({ err: error, sku: job.sku }, '自动上品任务状态联动失败'); }
    }
  }

  private async workerOnce(): Promise<void> {
    if (!this.repository.configured) return;
    const jobs = await this.repository.claimDue(this.workerId, this.concurrency);
    await Promise.all(jobs.map(async (job) => {
      // Product material generation is shared by all stores. The global SKU
      // lock serializes draft/media/product.json mutation, while each store's
      // publication and runtime task remain independent after generation.
      const locked = await this.repository.withSkuLock(job.sku, async () => {
        const processingJob = resumeNetworkWaitingJob(job);
        await this.processJob(processingJob).catch((error) => this.handleJobError(job, error));
      });
      if (!locked.acquired) await this.repository.releaseLease(job.sku, job.storeId);
    }));
  }

  private async processJob(job: WbAutoPublishJob): Promise<void> {
    const publicationStore = this.wbStores ? await this.wbStores.getStore(job.storeId) : undefined;
    const publicationScoped = Boolean(publicationStore && this.wbStores);
    const binding = await this.bindingForJob(job);
    const materialPresetDefinitionHash = wbMaterialPresetDefinitionHash(binding);
    if (job.materialPresetDefinitionHash && job.materialPresetDefinitionHash !== materialPresetDefinitionHash) {
      throw new StopJob('PRESET_VERSION_MISMATCH', '自动任务的预设定义快照与已持久化摘要不一致', 'NEEDS_ATTENTION');
    }
    if (!job.presetBinding || !job.materialPresetDefinitionHash) {
      await this.repository.persistBinding(job.sku, binding, job.storeId, materialPresetDefinitionHash);
    }
    const context = await this.presets.resolveExecutionBinding(binding, false);
    const blocking = context.resolved.issues.filter((issue) => issue.severity === 'ERROR');
    if (blocking.length) throw new StopJob('PRESET_SNAPSHOT_INVALID', blocking.map((issue) => issue.message).join('；'), 'NEEDS_ATTENTION');

    if (publicationStore) {
      if (!job.publicationId) {
        const detached = await this.wbStores!.findAutomationMaterializedPublication({
          sku: job.sku,
          automationRunId: job.runId,
          storeId: job.storeId
        });
        if (detached) {
          assertAutomationPublicationForJob(detached, job, publicationStore, materialPresetDefinitionHash, true);
          await this.repository.linkPublication(job.sku, job.storeId, job.runId, detached.id);
          job = { ...job, publicationId: detached.id };
        }
      }
    }

    if (job.publicationId && publicationStore) {
      const persisted = await this.wbStores!.getPublication(job.publicationId);
      assertAutomationPublicationForJob(persisted, job, publicationStore, materialPresetDefinitionHash, false);
      const linked = await this.wbStores!.syncPublication(job.publicationId);
      assertAutomationPublicationForJob(linked, job, publicationStore, materialPresetDefinitionHash, false);
      if (['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PAUSED'].includes(linked.status)) {
        const target = linked.status === 'SUCCEEDED' ? 'SUCCEEDED'
          : linked.status === 'FAILED' ? 'FAILED'
            : linked.status === 'PAUSED' ? 'PAUSED'
              : linked.status === 'RUNNING' ? 'RUNNING' : 'QUEUED';
        await this.transitionJob(job, target, {
          eventType: 'LINKED_PUBLICATION_RESUMED',
          message: `已从独立店铺发布记录恢复为 ${linked.status}`,
          n8nTaskId: linked.taskId,
          nextAttemptAt: null,
          errorCode: linked.errorCode || null,
          errorMessage: linked.errorMessage || null
        });
        if (['SUCCEEDED', 'FAILED', 'PAUSED'].includes(target)) await this.repository.setListingLock(job.sku, false);
        return;
      }
      if (linked.status === 'PLANNED' || linked.status === 'DISPATCHING' || linked.status === 'NEEDS_ATTENTION') {
        await this.assertGeneratedVersionPreset(job, linked.generatedVersionId, materialPresetDefinitionHash);
        if (job.state !== 'SUBMITTING') {
          await this.transitionJob(job, 'SUBMITTING', {
            eventType: 'PUBLICATION_DISPATCH_RECOVERY_STARTED',
            message: '按确定性 taskId 回读独立店铺发布结果',
            clearLease: false
          });
        }
        const recovered = await this.dispatchStorePublication(job, {
          generatedVersionId: linked.generatedVersionId,
          revision: linked.revision
        }, publicationStore, {
          submissionMode: job.operationMode === 'COMPATIBLE_UPSERT' ? 'COMPATIBLE_UPSERT' : 'CREATE_ONLY',
          mediaTargetVendorCodes: job.mediaTargetVendorCodes,
          existingCardBaseline: Array.isArray(linked.configSnapshot.existingCardBaseline)
            ? linked.configSnapshot.existingCardBaseline as WbExistingCardBaseline[]
            : undefined,
          presetDefinitionHash: materialPresetDefinitionHash
        });
        await this.transitionJob(job, recovered.status === 'RUNNING' ? 'RUNNING' : 'QUEUED', {
          eventType: 'PUBLICATION_DISPATCH_RECOVERED',
          message: '独立店铺发布已通过 taskId 回读或明确未入队后恢复',
          n8nTaskId: recovered.taskId,
          nextAttemptAt: null,
          errorCode: null,
          errorMessage: null
        });
        return;
      }
    }
    let listing = await this.publishing.repository.getListing(job.sku).catch((error) => isMissingListing(error) ? undefined : Promise.reject(error));
    let rebuildForStorePreset = Boolean(publicationScoped && listing?.generatedVersionId)
      && !(await this.generatedVersionUsesPreset(String(listing!.generatedVersionId), materialPresetDefinitionHash));
    let rebuildForAutomationTakeover = false;
    if (listing && job.n8nTaskId && listing.n8nTaskId === job.n8nTaskId
      && (listing.status === 'SUBMITTING' || (listing.status === 'NEEDS_ATTENTION' && job.state === 'CHECKING'))) {
      const reconciled = await this.publishing.reconcileTaskStatus(job.sku);
      listing = reconciled.listing;
      if (reconciled.pollError) {
        const listingRecovery = asNetworkRecovery(asObject(listing).networkRecovery);
        const attentionRetry = listing.status === 'NEEDS_ATTENTION' ? nextWbNetworkRecovery({
          previous: job.networkRecovery || listingRecovery,
          phase: 'MANUAL_RECHECK_READBACK',
          resumeState: 'CHECKING',
          error: new AppError('VERIFY_FAILED', reconciled.pollError, { deliveryUnknown: true }, 502),
          checkpoint: `taskId:${job.n8nTaskId}`
        })?.recovery : undefined;
        const recovery = attentionRetry || listingRecovery;
        if (recovery) {
          await this.transitionJob(job, 'WAITING_NETWORK', {
            eventType: 'SUBMIT_OUTCOME_STILL_UNKNOWN',
            message: reconciled.pollError,
            details: { taskId: job.n8nTaskId, manualRecoveryAttempt: recovery.attempt },
            nextAttemptAt: recovery.nextAttemptAt,
            networkRecovery: { ...recovery, resumeState: listing.status === 'NEEDS_ATTENTION' ? 'CHECKING' : 'SUBMITTING' },
            errorCode: recovery.lastErrorCode,
            errorMessage: recovery.lastErrorMessage
          });
          return;
        }
        throw new RetryableJobError('WB_TASK_STATUS_PENDING', reconciled.pollError);
      }
    }
    if (listing && job.n8nTaskId && listing.n8nTaskId === job.n8nTaskId && listing.status === 'NEEDS_ATTENTION') {
      await this.transitionJob(job, 'NEEDS_ATTENTION', {
        eventType: 'SUBMIT_AMBIGUITY_NEEDS_ATTENTION',
        message: listing.lastError || 'WB 写入结果在平台恢复后仍无法确认，需要人工按原 taskId 继续检查',
        details: { taskId: job.n8nTaskId },
        nextAttemptAt: null,
        errorCode: 'WB_WRITE_OUTCOME_AMBIGUOUS',
        errorMessage: listing.lastError || 'WB 写入结果持续无法确认'
      });
      await this.repository.setListingLock(job.sku, false);
      return;
    }
    let listingAtRunStart = listing;
    let regenerateSubmittedListing = shouldRegenerateSubmittedListingAfterRecheck(job, listing);
    if (listing && job.n8nTaskId && listing.n8nTaskId === job.n8nTaskId && SUBMITTED_STATES.has(listing.status) && !regenerateSubmittedListing) {
      const target = listing.status === 'SUCCEEDED' ? 'SUCCEEDED' : listing.status === 'RUNNING' ? 'RUNNING' : listing.status === 'FAILED' || listing.status === 'BLOCKED' ? 'FAILED' : 'QUEUED';
      const failedListing = listing.status === 'FAILED' || listing.status === 'BLOCKED';
      const taskError = failedListing ? wbTaskErrorDetails(listing) : undefined;
      await this.transitionJob(job, target, {
        eventType: 'RESUMED_FROM_LISTING',
        n8nTaskId: listing.n8nTaskId,
        nextAttemptAt: null,
        errorCode: taskError?.errorCode || null,
        errorMessage: taskError?.errorMessage || null
      });
      if (target === 'SUCCEEDED' || target === 'FAILED') await this.repository.setListingLock(job.sku, false);
      return;
    }
    const submittedCreateOnlyRecovery = regenerateSubmittedListing && job.operationMode === 'CREATE_ONLY'
      && Boolean(job.n8nTaskId) && listing?.n8nTaskId === job.n8nTaskId;
    if (listing && job.operationMode === 'CREATE_ONLY' && !submittedCreateOnlyRecovery && !rebuildForStorePreset
      && listing.latestOperationSource !== 'AUTOMATION'
      && !listing.autoPublishLocked && !['INITIALIZING', 'GENERATING', 'SUBMITTING'].includes(job.state)) {
      throw new StopJob('EXISTING_LOCAL_LISTING', 'SKU 已存在人工创建的 WB 上品资料，自动流程已停止', 'NEEDS_ATTENTION', {
        ownershipSource: String(listing.latestOperationSource || 'MANUAL'),
        operationRef: listing.latestOperationRef || null,
        manualDraft: true
      });
    }
    let compatibleListingBelongsToRun = Boolean(listing?.autoPublishLocked && listing.draftVersion >= job.targetRevision);
    let staleAutomationDraft = Boolean(listing && job.operationMode === 'COMPATIBLE_UPSERT'
      && await isStaleAutomationDraft(listing, (sku) => this.publishing.repository.countListingVersions(sku)));
    if (listing && job.operationMode === 'COMPATIBLE_UPSERT' && !compatibleListingBelongsToRun && !rebuildForStorePreset
      && listing.latestOperationSource !== 'AUTOMATION'
      && !staleAutomationDraft && !['SUCCEEDED', 'FAILED', 'BLOCKED'].includes(listing.status)) {
      throw new StopJob('EXISTING_LOCAL_LISTING', 'SKU 正在人工编辑或提交，兼容更新不会覆盖现有草稿', 'NEEDS_ATTENTION', {
        ownershipSource: String(listing.latestOperationSource || 'MANUAL'),
        operationRef: listing.latestOperationRef || null,
        manualDraft: true
      });
    }

    const activation = binding.activationStartedAt;
    const category = asObject(context.resolved.dependencies.category);
    const mediaRules = { minImages: 1, maxImages: 30, videoAllowed: true, ...asObject(asObject(category.formConfig).media) };
    let productVariants = await this.publishing.productVariants(job.sku);
    let colored = productVariants.filter((variant) => variant.wbColor);
    let allExpectedVariants = colored.length ? colored : productVariants;
    const requestedTargetIds = new Set(job.mediaTargetVariantIds);
    let expectedVariants = job.operationMode === 'CREATE_ONLY' && requestedTargetIds.size
      ? allExpectedVariants.filter((variant) => requestedTargetIds.has(variant.variantId))
      : allExpectedVariants;
    if (!expectedVariants.length) throw new StopJob('PRODUCT_VARIANTS_MISSING', '产品没有可用于 WB 上品的变体', 'NEEDS_ATTENTION');
    const automaticCutoff = job.triggerType === 'MANUAL' ? new Date(0).toISOString() : activation;
    let mediaTargetVariants = job.operationMode === 'COMPATIBLE_UPSERT' && listingAtRunStart
      ? expectedVariants.filter((variant) => requestedTargetIds.has(variant.variantId))
      : expectedVariants;
    if (!mediaTargetVariants.length) throw new StopJob('MEDIA_TARGET_MISSING', '本轮没有可安全匹配的媒体目标变体', 'NEEDS_ATTENTION');
    let expectedVendorCodes = expectedVariants.map((_variant, index) => `${job.sku}-${String(index + 1).padStart(2, '0')}`);

    const readiness = await this.publishing.readiness(true);
    if (!readiness.complete) throw new RetryableJobError('WB_RUNTIME_NOT_READY', 'WB 根目录或 n8n 运行配置尚未就绪');
    if (regenerateSubmittedListing && job.n8nTaskId) {
      const restored = await this.publishing.restoreSubmittedMediaFromTask(job.sku, job.n8nTaskId);
      if (restored.restored) {
        await this.transitionJob(job, 'CHECKING', {
          eventType: 'SUBMITTED_MEDIA_RESTORED',
          message: '已从旧提交目录恢复媒体，准备重新生成 product.json',
          details: restored,
          clearLease: false
        });
      }
    }
    const manifestFile = path.join(readiness.rootDirectory, 'inbox', job.sku, 'variants', 'variant-media-manifest.json');
    const stableAfter = Date.parse(job.lastDeliveryAt || job.updatedAt) + this.stableWindowMs;
    if (Date.now() < stableAfter) {
      await this.transitionJob(job, 'WAITING_STABLE', { eventType: 'WAITING_STABLE_WINDOW', message: '等待媒体目录进入稳定窗口', nextAttemptAt: new Date(stableAfter).toISOString(), expectedVendorCodes });
      return;
    }
    const first = await inspectManifest(manifestFile, job.sku, mediaTargetVariants, automaticCutoff, mediaRules);
    if (this.stableProbeMs) await delay(this.stableProbeMs);
    let second = await inspectManifest(manifestFile, job.sku, mediaTargetVariants, automaticCutoff, mediaRules);
    if (first.signature !== second.signature) {
      await this.transitionJob(job, 'WAITING_STABLE', { eventType: 'MEDIA_CHANGED_DURING_PROBE', message: '媒体目录在稳定检查期间发生变化', nextAttemptAt: new Date(Date.now() + this.stableWindowMs).toISOString() });
      return;
    }
    if (second.issues.length) {
      await this.transitionJob(job, 'WAITING_MEDIA', { eventType: 'MEDIA_INCOMPLETE', message: second.issues.join('；'), details: { issues: second.issues }, nextAttemptAt: null, mediaSignature: second.signature, expectedVendorCodes });
      return;
    }

    const generationLease = await this.repository.claimGenerationLease(job);
    if (!generationLease.acquired) {
      await this.transitionJob(job, 'WAITING_GENERATION_TURN', {
        eventType: 'WAITING_GENERATION_TURN',
        message: '等待同一 SKU 的另一店完成共享版本冻结',
        details: {
          ownerJobId: generationLease.ownerJobId,
          ownerRunId: generationLease.ownerRunId,
          ownerStoreId: generationLease.ownerStoreId,
          ownerPhase: generationLease.phase,
          leaseUntil: generationLease.leaseUntil
        },
        nextAttemptAt: new Date(Date.now() + 5_000).toISOString(),
        errorCode: null,
        errorMessage: null
      });
      return;
    }
    const generationGuard = new WbGenerationLeaseGuard(this.repository, job, generationLease);
    let generationLeaseHeld = true;
    const releaseGenerationTurn = async () => {
      if (!generationLeaseHeld) return;
      await generationGuard.release();
      generationLeaseHeld = false;
    };
    try {
      await generationGuard.fence('REFRESHING_SHARED_LISTING');
      // The shared draft may have changed while this store waited for another
      // store to freeze its immutable publication. Decisions made before the
      // lease are advisory only; all ownership, preset, identity, and media
      // targets are recomputed from this fenced snapshot.
      listing = await this.publishing.repository.getListing(job.sku)
        .catch((error) => isMissingListing(error) ? undefined : Promise.reject(error));
      listingAtRunStart = listing;
      rebuildForStorePreset = Boolean(publicationScoped && listing?.generatedVersionId)
        && !(await this.generatedVersionUsesPreset(String(listing!.generatedVersionId), materialPresetDefinitionHash));
      rebuildForAutomationTakeover = false;
      regenerateSubmittedListing = shouldRegenerateSubmittedListingAfterRecheck(job, listing);
      staleAutomationDraft = Boolean(listing && job.operationMode === 'COMPATIBLE_UPSERT'
        && await isStaleAutomationDraft(listing, (sku) => this.publishing.repository.countListingVersions(sku)));

      let frozenAutomationSource = false;
      if (listing) {
        const ownershipSource = String(listing.latestOperationSource || 'MANUAL');
        if (ownershipSource !== 'AUTOMATION') {
          if (!['SUCCEEDED', 'FAILED', 'BLOCKED'].includes(String(listing.status))) {
            throw new StopJob('EXISTING_LOCAL_LISTING',
              job.operationMode === 'CREATE_ONLY'
                ? 'SKU 已存在人工创建的 WB 上品资料，自动流程已停止'
                : 'SKU 正在人工编辑或提交，兼容更新不会覆盖现有草稿',
              'NEEDS_ATTENTION', {
                ownershipSource,
                operationRef: listing.latestOperationRef || null,
                manualDraft: true
              });
          }
        } else {
          const ownerRunId = automationRunIdFromOperationRef(String(listing.latestOperationRef || ''));
          const owner = ownerRunId ? await this.repository.findGenerationOwner(job.sku, ownerRunId) : undefined;
          if (!ownerRunId || !owner) {
            throw new AppError('OWNERSHIP_AMBIGUOUS', '自动草稿的 operationRef 无法映射到同一 SKU 的自动任务，已停止覆盖', {
              sku: job.sku,
              status: listing.status,
              ownershipSource,
              operationRef: listing.latestOperationRef || null,
              manualDraft: false
            }, 409);
          }
          if (ownerRunId !== job.runId && listing.generatedVersionId && this.wbStores) {
            frozenAutomationSource = await this.wbStores.hasFrozenAutomationPublicationForSource({
              sku: job.sku,
              sourceGeneratedVersionId: String(listing.generatedVersionId),
              automationRunId: ownerRunId,
              storeId: owner.storeId
            });
          }
          if (ownerRunId !== job.runId && !frozenAutomationSource) rebuildForAutomationTakeover = true;
          compatibleListingBelongsToRun = Boolean(listing.autoPublishLocked
            && listing.draftVersion >= job.targetRevision
            && (ownerRunId === job.runId || frozenAutomationSource));
        }
      } else {
        compatibleListingBelongsToRun = false;
      }

      productVariants = await this.publishing.productVariants(job.sku);
      colored = productVariants.filter((variant) => variant.wbColor);
      allExpectedVariants = colored.length ? colored : productVariants;
      expectedVariants = job.operationMode === 'CREATE_ONLY' && requestedTargetIds.size
        ? allExpectedVariants.filter((variant) => requestedTargetIds.has(variant.variantId))
        : allExpectedVariants;
      if (!expectedVariants.length) {
        throw new StopJob('PRODUCT_VARIANTS_MISSING', '产品没有可用于 WB 上品的变体', 'NEEDS_ATTENTION');
      }
      mediaTargetVariants = job.operationMode === 'COMPATIBLE_UPSERT' && listingAtRunStart
        ? expectedVariants.filter((variant) => requestedTargetIds.has(variant.variantId))
        : expectedVariants;
      if (!mediaTargetVariants.length) {
        throw new StopJob('MEDIA_TARGET_MISSING', '本轮没有可安全匹配的媒体目标变体', 'NEEDS_ATTENTION');
      }
      expectedVendorCodes = expectedVariants.map((_variant, index) => `${job.sku}-${String(index + 1).padStart(2, '0')}`);
      const fencedFirst = await inspectManifest(manifestFile, job.sku, mediaTargetVariants, automaticCutoff, mediaRules);
      if (this.stableProbeMs) await delay(this.stableProbeMs);
      second = await inspectManifest(manifestFile, job.sku, mediaTargetVariants, automaticCutoff, mediaRules);
      if (fencedFirst.signature !== second.signature) {
        await this.transitionJob(job, 'WAITING_STABLE', {
          eventType: 'MEDIA_CHANGED_AFTER_GENERATION_TURN',
          message: '取得生成轮次后媒体目录发生变化，将重新确认',
          nextAttemptAt: new Date(Date.now() + this.stableWindowMs).toISOString()
        });
        return;
      }
      if (second.issues.length) {
        await this.transitionJob(job, 'WAITING_MEDIA', {
          eventType: 'MEDIA_INCOMPLETE_AFTER_GENERATION_TURN',
          message: second.issues.join('；'),
          details: { issues: second.issues },
          nextAttemptAt: null,
          mediaSignature: second.signature,
          expectedVendorCodes
        });
        return;
      }
      await this.transitionJob(job, 'CHECKING', {
        eventType: job.state === 'WAITING_GENERATION_TURN' ? 'GENERATION_TURN_ACQUIRED' : 'PRECHECK_STARTED',
        message: job.state === 'WAITING_GENERATION_TURN' ? '已取得同一 SKU 的生成轮次，继续冻结本店版本' : undefined,
        mediaSignature: second.signature, expectedVendorCodes, nextAttemptAt: null,
        errorCode: null, errorMessage: null, clearLease: false
      });
    if (!listing) {
      const existing = await this.checkVendorCodesForJob(job, expectedVendorCodes, publicationStore, 'initial');
      if (existing.matches.length) throw new ExistingCardError(existing.matches);
      await this.transitionJob(job, 'INITIALIZING', { eventType: 'INITIALIZATION_STARTED', clearLease: false });
      await generationGuard.fence('INITIALIZING_SHARED_LISTING');
      listing = await this.publishing.initializeListing(job.sku, () => this.presets.createListing(job.sku, {
        automatic: true,
        presetBinding: binding,
        productVariantIds: expectedVariants.map((variant) => variant.variantId),
        operationRef: `automation:${job.runId}`
      }));
    } else if (rebuildForStorePreset || rebuildForAutomationTakeover) {
      await this.transitionJob(job, 'INITIALIZING', {
        eventType: rebuildForStorePreset ? 'STORE_PRESET_VERSION_REBUILD_STARTED' : 'ORPHANED_AUTOMATION_REBUILD_STARTED',
        message: rebuildForStorePreset
          ? '当前共享版本已由另一店铺冻结，正在按本店预设生成独立 product.json 版本'
          : '上一生成所有者未冻结发布版本，已按当前 fencing token 安全接管',
        clearLease: false
      });
      const fence = await generationGuard.fence('REBUILDING_SHARED_LISTING');
      listing = await this.presets.rebuildListing(job.sku, binding, `automation:${job.runId}`, rebuildForStorePreset, {
        jobId: job.id,
        runId: job.runId,
        rowVersion: fence.rowVersion
      });
    } else if (job.operationMode === 'COMPATIBLE_UPSERT' && !compatibleListingBelongsToRun) {
      await this.transitionJob(job, 'INITIALIZING', {
        eventType: staleAutomationDraft ? 'STALE_AUTOMATION_DRAFT_RECLAIMED' : 'COMPATIBLE_REBUILD_STARTED',
        message: staleAutomationDraft ? '已接管自动流程残留空草稿，按本轮绑定预设重建受管商品资料' : '按本轮绑定预设重建受管商品资料',
        clearLease: false
      });
      const fence = await generationGuard.fence('REBUILDING_SHARED_LISTING');
      listing = await this.presets.rebuildListing(job.sku, binding, `automation:${job.runId}`, false, {
        jobId: job.id,
        runId: job.runId,
        rowVersion: fence.rowVersion
      });
    }

    expectedVendorCodes = listing.variants.map((variant: JsonRecord) => String(variant.vendorCode || '')).filter(Boolean);
    const targetVariantSet = new Set(mediaTargetVariants.map((variant) => variant.variantId));
    const mediaTargetVendorCodes = listing.variants
      .filter((variant: JsonRecord) => targetVariantSet.has(String(variant.productVariantId || '')))
      .map((variant: JsonRecord) => String(variant.vendorCode || '')).filter(Boolean);
    const previousVendorCodes = new Set((Array.isArray(listingAtRunStart?.variants) ? listingAtRunStart.variants : [])
      .map((variant: JsonRecord) => String(variant.vendorCode || '')).filter(Boolean));
    const compatibilityWarnings = (Array.isArray((listing as JsonRecord).initializationIssues) ? (listing as JsonRecord).initializationIssues : [])
      .filter((candidate: unknown) => String(asObject(candidate).code || '') === 'UNMANAGED_EXISTING_VARIANT_PRESERVED')
      .map((candidate: unknown) => asObject(candidate));
    const variantSummary = {
      created: expectedVendorCodes.filter((vendorCode) => !previousVendorCodes.has(vendorCode)).length,
      updated: expectedVendorCodes.filter((vendorCode) => previousVendorCodes.has(vendorCode)).length,
      preserved: compatibilityWarnings.length
    };
    await this.transitionJob(job, 'CHECKING', {
      eventType: 'COMPATIBILITY_PRECHECK', expectedVendorCodes, mediaTargetVendorCodes,
      warnings: compatibilityWarnings, variantSummary, clearLease: false
    });
    const checked = await this.checkVendorCodesForJob(job, expectedVendorCodes, publicationStore, 'post-initialize');
    if (job.operationMode === 'CREATE_ONLY') {
      const classification = classifyCreateOnlyMatches(expectedVendorCodes, checked.matches, listing, job);
      if (classification.kind === 'SELF_OWNED') {
        await this.recoverSelfOwnedPartialCreate(job, classification.matches);
        return;
      }
      if (classification.kind === 'BLOCKED') {
        const message = classification.reason === 'trash_match'
          ? '回收站中存在相同卖家商品编码，CREATE_ONLY 自动上品已阻止'
          : undefined;
        throw new ExistingCardError(classification.matches, message);
      }
    } else {
      const trashMatches = checked.matches.filter((match) => match.location === 'TRASH');
      if (trashMatches.length) throw new ExistingCardError(trashMatches, '回收站中存在相同卖家商品编码，兼容更新已停止');
    }
    if (job.operationMode === 'COMPATIBLE_UPSERT' && !listingAtRunStart && checked.matches.some((match) => match.location === 'ACTIVE')) {
      throw new ExistingCardError(checked.matches, 'WB 存在商品卡，但 MerchRoute 没有可验证的历史上品资料，已拒绝自动接管');
    }

    if (listing.status !== 'GENERATED') {
      let initializationIssues = (listing as JsonRecord).initializationIssues;
      if (Array.isArray(initializationIssues) && initializationIssues.some(isBlockingInitializationIssue)) {
        const errors = initializationIssues.filter(isBlockingInitializationIssue);
        if (errors.every((issue: any) => issue?.retryable === true)
          && Number(job.retryCounters.INITIALIZATION || 0) < NON_NETWORK_RETRY_DELAYS_MS.length) {
          await generationGuard.fence('INITIALIZING_MISSING_FIELDS');
          listing = await this.presets.initializeMissing(job.sku, listing.draftVersion, {
            automatic: true,
            operationRef: `automation:${job.runId}`
          });
          initializationIssues = (listing as JsonRecord).initializationIssues;
        }
        if (Array.isArray(initializationIssues) && initializationIssues.some(isBlockingInitializationIssue)) {
          const remaining = initializationIssues.filter(isBlockingInitializationIssue);
          const messages = remaining.map((issue: any) => String(issue.message));
          if (remaining.every((issue: any) => issue?.retryable === true)) {
            throw new RetryableJobError('INITIALIZATION_INCOMPLETE', messages.join('；'));
          }
          throw new StopJob('INITIALIZATION_INCOMPLETE', messages.join('；'), 'NEEDS_ATTENTION');
        }
      }

      await generationGuard.fence('SCANNING_SHARED_MEDIA');
      listing = await this.publishing.scanMedia(job.sku, { automatic: true });
      const assignments = buildAutomaticAssignments(listing, expectedVariants, automaticCutoff, mediaRules, targetVariantSet);
      await generationGuard.fence('ASSIGNING_SHARED_MEDIA');
      listing = await this.publishing.updateListing(job.sku, {
        draftVersion: listing.draftVersion,
        variants: listing.variants,
        variantMedia: assignments
      }, { automatic: true, operationRef: `automation:${job.runId}` });
      await this.transitionJob(job, 'GENERATING', { eventType: 'GENERATION_STARTED', clearLease: false });
      await generationGuard.fence('GENERATING_SHARED_LISTING');
      listing = (await this.publishing.generate(job.sku, listing.draftVersion, {
        automatic: true,
        operationRef: `automation:${job.runId}`
      })).listing;
    }

    if (publicationScoped && listing.generatedVersionId) {
      await this.assertGeneratedVersionPreset(job, String(listing.generatedVersionId), materialPresetDefinitionHash);
      await generationGuard.fence('MATERIALIZING_STORE_PUBLICATION', String(listing.generatedVersionId));
    }

    const existingBeforeSubmit = await this.checkVendorCodesForJob(job, expectedVendorCodes, publicationStore, 'before-submit');
    if (job.operationMode === 'CREATE_ONLY') {
      const classification = classifyCreateOnlyMatches(expectedVendorCodes, existingBeforeSubmit.matches, listing, job);
      if (classification.kind === 'SELF_OWNED') {
        await this.recoverSelfOwnedPartialCreate(job, classification.matches);
        return;
      }
      if (classification.kind === 'BLOCKED') {
        const message = classification.reason === 'trash_match'
          ? '提交前发现回收站商品卡，CREATE_ONLY 自动上品已阻止'
          : undefined;
        throw new ExistingCardError(classification.matches, message);
      }
    } else {
      const trashBeforeSubmit = existingBeforeSubmit.matches.filter((match) => match.location === 'TRASH');
      if (trashBeforeSubmit.length) throw new ExistingCardError(trashBeforeSubmit, '提交前发现回收站商品卡，兼容更新已停止');
    }
    const submissionMode = job.operationMode === 'COMPATIBLE_UPSERT' ? 'COMPATIBLE_UPSERT' : 'CREATE_ONLY';
    await this.transitionJob(job, 'SUBMITTING', { eventType: `${submissionMode}_SUBMIT_STARTED`, clearLease: false });
    if (publicationScoped && publicationStore) {
      const publication = await this.dispatchStorePublication(job, listing, publicationStore, {
        submissionMode,
        mediaTargetVendorCodes,
        existingCardBaseline: job.operationMode === 'COMPATIBLE_UPSERT'
          ? activeCardBaseline(existingBeforeSubmit.matches)
          : undefined,
        presetDefinitionHash: materialPresetDefinitionHash,
        onMaterialized: releaseGenerationTurn
      });
      await this.transitionJob(job, publication.status === 'RUNNING' ? 'RUNNING' : 'QUEUED', {
        eventType: `${submissionMode}_SUBMITTED`,
        message: '自动上品已按店铺发布记录提交到 n8n',
        n8nTaskId: publication.taskId,
        nextAttemptAt: null,
        errorCode: null,
        errorMessage: null
      });
      return;
    }
    await releaseGenerationTurn();
    const submitted = await this.publishing.submit(job.sku, listing.draftVersion, {
      automatic: true, submissionMode,
      mediaPolicy: job.operationMode === 'COMPATIBLE_UPSERT' ? 'REPLACE_SELECTED' : 'MISSING_ONLY',
      mediaTargetVendorCodes, automationRunId: job.runId, automationRunNo: job.runNo,
      existingCardBaseline: job.operationMode === 'COMPATIBLE_UPSERT'
        ? activeCardBaseline(existingBeforeSubmit.matches)
        : undefined,
      operationRef: `automation:${job.runId}`
    });
    await this.transitionJob(job, 'QUEUED', {
      eventType: `${submissionMode}_SUBMITTED`, message: job.operationMode === 'COMPATIBLE_UPSERT' ? '兼容重新上品任务已提交到 n8n' : '自动创建任务已提交到 n8n', n8nTaskId: submitted.listing.n8nTaskId,
      nextAttemptAt: null, errorCode: null, errorMessage: null
    });
    } catch (error) {
      if (error instanceof AppError && ['AUTOMATION_BUSY', 'AUTOMATION_GENERATION_LEASE_LOST'].includes(error.code)) {
        await this.transitionJob(job, 'WAITING_GENERATION_TURN', {
          eventType: 'WAITING_GENERATION_TURN',
          message: error.message,
          details: asObject(error.details),
          nextAttemptAt: new Date(Date.now() + 5_000).toISOString(),
          errorCode: null,
          errorMessage: null
        });
        return;
      }
      throw error;
    } finally {
      if (generationLeaseHeld) {
        await releaseGenerationTurn().catch((error) => {
          this.logger.warn({ error, sku: job.sku, jobId: job.id, runId: job.runId }, 'WB 自动生成租约释放失败，等待过期接管');
        });
      }
    }
  }

  private async bindingForJob(job: WbAutoPublishJob): Promise<WbPresetExecutionBinding> {
    try {
      return job.presetBinding
        ? this.presets.parseExecutionBinding(job.presetBinding)
        : this.presets.legacyExecutionBinding(job);
    } catch (error) {
      throw new StopJob(
        'PRESET_SNAPSHOT_INVALID',
        error instanceof Error ? error.message : '自动上品任务的预设绑定快照无效',
        'NEEDS_ATTENTION'
      );
    }
  }

  private transitionJob(
    job: WbAutoPublishJob,
    state: WbAutoPublishState,
    input: Parameters<WbAutoPublishRepository['transition']>[2] = {}
  ) {
    return job.storeId && job.storeId !== '00000000-0000-4000-8000-000000000001'
      ? this.repository.transition(job.sku, state, input, job.storeId)
      : this.repository.transition(job.sku, state, input);
  }

  private checkVendorCodesForJob(
    job: WbAutoPublishJob,
    vendorCodes: string[],
    store: WbStore | undefined,
    checkpoint: string
  ) {
    const vaultScoped = store?.credential.state === 'ACTIVE' && Boolean(store.credential.activeVersionId);
    return this.publishing.n8n.checkVendorCodes(vendorCodes, vaultScoped ? {
      storeId: store.id,
      storeAlias: store.storeAlias,
      requestRef: `vendor-check:${job.runId}:${checkpoint}`
    } : undefined);
  }

  private async assertGeneratedVersionPreset(
    job: WbAutoPublishJob,
    generatedVersionId: string,
    presetDefinitionHash: string
  ): Promise<void> {
    try {
      await this.wbStores!.assertGeneratedVersionPreset(generatedVersionId, presetDefinitionHash);
    } catch (error) {
      if (error instanceof AppError && error.code === 'PRESET_VERSION_MISMATCH') {
        throw new StopJob(
          'PRESET_VERSION_MISMATCH',
          `店铺 ${job.storeId} 的预设与当前 product.json 生成预设不一致，已阻止该店铺继续发布`,
          'NEEDS_ATTENTION'
        );
      }
      throw error;
    }
  }

  private async generatedVersionUsesPreset(
    generatedVersionId: string,
    presetDefinitionHash: string
  ): Promise<boolean> {
    try {
      await this.wbStores!.assertGeneratedVersionPreset(generatedVersionId, presetDefinitionHash);
      return true;
    } catch (error) {
      if (error instanceof AppError && error.code === 'PRESET_VERSION_MISMATCH') return false;
      throw error;
    }
  }

  private async dispatchStorePublication(
    job: WbAutoPublishJob,
    listing: JsonRecord,
    store: WbStore,
    input: {
      submissionMode: 'CREATE_ONLY' | 'COMPATIBLE_UPSERT';
      mediaTargetVendorCodes: string[];
      existingCardBaseline?: WbExistingCardBaseline[];
      presetDefinitionHash: string;
      onMaterialized?: () => Promise<void>;
    }
  ) {
    if (!this.wbStores || !listing.generatedVersionId || !Number(listing.revision)) {
      throw new AppError('WB_STORE_NOT_READY', '店铺发布缺少凭据或已生成版本快照', { storeId: store.id, sku: job.sku }, 409);
    }
    const sourceGeneratedVersionId = String(listing.generatedVersionId);
    let publication: WbStorePublication;
    if (job.publicationId) {
      // Deployment-before-upgrade publications (including in-flight 0000124)
      // keep their original LISTING version and task identity. Never migrate
      // or fan them out while recovering an already-linked write.
      publication = await this.wbStores.getPublication(job.publicationId);
    } else {
      const legacyDefault = store.storeAlias === 'default' && store.credential.state === 'LEGACY_EXTERNAL';
      if (!legacyDefault && !store.credential.activeVersionId) {
        throw new AppError('WB_STORE_NOT_READY', '店铺发布缺少冻结的凭据版本', { storeId: store.id, sku: job.sku }, 409);
      }
      if (!job.presetId) {
        throw new AppError('PRESET_SNAPSHOT_INVALID', '自动上品任务缺少冻结的店铺默认预设 ID', {
          sku: job.sku,
          storeId: store.id,
          automationRunId: job.runId
        }, 409);
      }
      publication = await this.wbStores.createAutomationMaterializedPublication({
        sku: job.sku,
        sourceGeneratedVersionId,
        storeId: store.id,
        storeAlias: store.storeAlias,
        storeRowVersion: store.rowVersion,
        storeConfigVersion: store.configVersion,
        warehouseId: store.warehouseId,
        ...(store.credential.activeVersionId ? { credentialVersionId: store.credential.activeVersionId } : {}),
        presetId: job.presetId,
        ...(job.presetSnapshot ? { presetSnapshot: job.presetSnapshot } : {}),
        presetDefinitionHash: input.presetDefinitionHash,
        automationRunId: job.runId,
        automationRunNo: job.runNo,
        operationMode: input.submissionMode,
        mediaTargetVendorCodes: input.mediaTargetVendorCodes,
        ...(input.existingCardBaseline ? { existingCardBaseline: input.existingCardBaseline as unknown as JsonRecord[] } : {})
      });
    }
    assertAutomationPublicationForJob(
      publication,
      job,
      store,
      input.presetDefinitionHash,
      !job.publicationId
    );
    const materializedPublication = Boolean(
      publication.materializationHash
      && publication.configSnapshot.sourceGeneratedVersionId
    );
    const frozenMaterializationHash = materializedPublication
      ? String(publication.materializationHash)
      : undefined;
    const legacyPublication = !materializedPublication;
    const legacyDefault = publication.storeAlias === 'default' && !publication.credentialVersionId;
    const revision = Number(publication.revision);
    const taskId = `${publication.storeAlias}__${job.sku}__r${revision}`;
    if (!publication || publication.source !== 'AUTOMATION' || publication.storeId !== store.id
      || (job.publicationId && publication.generatedVersionId !== sourceGeneratedVersionId)
      || publication.taskId !== taskId
      || String(publication.presetDefinitionHash || '') !== input.presetDefinitionHash
      || String(publication.configSnapshot.automationRunId || '') !== job.runId
      || (!job.publicationId && materializedPublication && publication.generatedVersionId === sourceGeneratedVersionId)) {
      throw new AppError('VERSION_CONFLICT', '已生成版本已绑定到不一致的店铺发布记录', {
        sku: job.sku,
        storeId: store.id,
        sourceGeneratedVersionId,
        publicationId: publication?.id,
        publicationGeneratedVersionId: publication?.generatedVersionId
      }, 409);
    }
    const snapshotStoreConfigVersion = Number(publication.configSnapshot.storeConfigVersion || 0);
    const snapshotWarehouseId = String(publication.configSnapshot.warehouseId || '');
    const snapshotCredentialVersionId = publication.credentialVersionId
      || String(publication.configSnapshot.credentialVersionId || '')
      || undefined;
    const snapshotSubmissionMode = String(
      publication.configSnapshot.operationMode
      || publication.configSnapshot.autoPublishMode
      || input.submissionMode
    );
    const snapshotAutomationRunId = String(publication.configSnapshot.automationRunId || job.runId);
    const snapshotMediaTargetVendorCodes = Array.isArray(publication.configSnapshot.mediaTargetVendorCodes)
      ? publication.configSnapshot.mediaTargetVendorCodes.map(String)
      : input.mediaTargetVendorCodes;
    const snapshotExistingCardBaseline = Array.isArray(publication.configSnapshot.existingCardBaseline)
      ? publication.configSnapshot.existingCardBaseline as WbExistingCardBaseline[]
      : input.existingCardBaseline;
    if (!snapshotStoreConfigVersion || !snapshotWarehouseId || (!legacyDefault && !snapshotCredentialVersionId)
      || !['CREATE_ONLY', 'COMPATIBLE_UPSERT'].includes(snapshotSubmissionMode)
      || snapshotSubmissionMode !== input.submissionMode
      || (materializedPublication && !/^sha256:[a-f0-9]{64}$/.test(String(publication.materializationHash)))
      || (legacyPublication && publication.packageRelPath && publication.packageRelPath !== `inbox/${job.sku}`)) {
      throw new AppError('VERIFY_FAILED', '店铺发布记录缺少不可变凭据、配置或仓库快照', {
        publicationId: publication.id, storeId: store.id
      }, 409);
    }
    await this.repository.linkPublication(job.sku, job.storeId, job.runId, publication.id);
    await input.onMaterialized?.();
    if (['QUEUED', 'RUNNING', 'SUCCEEDED'].includes(publication.status)) return publication;
    if (['FAILED', 'PAUSED'].includes(publication.status)) {
      throw new AppError('WB_PUBLICATION_FAILED', publication.errorMessage || '店铺发布记录已终止', {
        publicationId: publication.id, status: publication.status
      }, 409);
    }

    const mediaPolicy = snapshotSubmissionMode === 'COMPATIBLE_UPSERT' ? 'REPLACE_SELECTED' : 'MISSING_ONLY';
    const idempotencyKey = `${publication.storeAlias}|${job.sku}|${revision}|${snapshotAutomationRunId}`;
    const packageInput = {
      sku: job.sku,
      generatedVersionId: publication.generatedVersionId,
      revision,
      publicationId: publication.id,
      taskId,
      idempotencyKey,
      storeId: publication.storeId,
      storeAlias: publication.storeAlias,
      ...(snapshotCredentialVersionId ? { credentialVersionId: snapshotCredentialVersionId } : {}),
      storeConfigVersion: snapshotStoreConfigVersion,
      warehouseId: snapshotWarehouseId,
      submissionMode: snapshotSubmissionMode as 'CREATE_ONLY' | 'COMPATIBLE_UPSERT',
      mediaPolicy,
      mediaTargetVendorCodes: snapshotMediaTargetVendorCodes,
      automationRunId: snapshotAutomationRunId,
      existingCardBaseline: snapshotExistingCardBaseline,
      ...(frozenMaterializationHash ? { materializationHash: frozenMaterializationHash } : {})
    } as const;
    const cleanupPackage = async () => {
      if (materializedPublication) return;
      await this.publishing.cleanupStorePublicationPackage(packageInput).catch((error) => {
        this.logger.warn({ error, sku: job.sku, publicationId: publication.id, taskId }, 'WB 店铺发布就绪凭证清理失败');
      });
    };
    let dispatching = publication;
    if (publication.status === 'DISPATCHING') {
      try {
        const raw = await this.publishing.n8n.getJob(taskId);
        const queued = await this.wbStores.markPublicationQueued(publication.id, taskId, raw);
        await cleanupPackage();
        return queued;
      } catch (error) {
        if (!(error instanceof AppError && error.code === 'JOB_NOT_FOUND' && error.details?.deliveryUnknown === false)) {
          const unknown = unknownDispatchReadbackError(publication, error);
          await this.wbStores.markPublicationDispatchUnknown(
            publication.id, taskId, unknown.code, unknown.message
          );
          throw unknown.error;
        }
      }
    }
    if (publication.status === 'NEEDS_ATTENTION') {
      try {
        const raw = await this.publishing.n8n.getJob(taskId);
        dispatching = await this.wbStores.markPublicationDispatching(publication.id);
        const queued = await this.wbStores.markPublicationQueued(publication.id, taskId, raw);
        await cleanupPackage();
        return queued;
      } catch (error) {
        if (!(error instanceof AppError && error.code === 'JOB_NOT_FOUND' && error.details?.deliveryUnknown === false)) throw error;
      }
    }
    let prepared;
    try {
      prepared = await this.publishing.prepareStorePublicationPackage(packageInput);
      if (materializedPublication) {
        const completeStoredPackage = Boolean(
          publication.packageRelPath && publication.packageSignature && publication.materializationHash
        );
        if (completeStoredPackage && (
          publication.packageRelPath !== prepared.packageRelPath
          || publication.packageSignature !== prepared.packageSignature
          || publication.materializationHash !== packageInput.materializationHash
        )) {
          throw new AppError('STORE_PACKAGE_IDENTITY_MISMATCH', '已冻结的 WB 自动发布包身份或签名不一致', {
            publicationId: publication.id,
            deliveryUnknown: false
          }, 409);
        }
        if (!completeStoredPackage) {
          publication = await this.wbStores.recordPublicationPackage(publication.id, {
            packageRelPath: prepared.packageRelPath,
            packageSignature: prepared.packageSignature,
            materializationHash: frozenMaterializationHash!
          });
          if (publication.packageRelPath !== prepared.packageRelPath
            || publication.packageSignature !== prepared.packageSignature
          || publication.materializationHash !== frozenMaterializationHash) {
            throw new AppError('STORE_PACKAGE_IDENTITY_MISMATCH', 'WB 自动发布包持久化回读不一致', {
              publicationId: publication.id,
              deliveryUnknown: false
            }, 409);
          }
        }
      }
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'STORE_PACKAGE_PREPARATION_FAILED';
      const message = error instanceof Error ? error.message : 'WB 店铺发布目录准备失败';
      await this.wbStores.markPublicationFailed(publication.id, code, message);
      throw new StopJob(code, message, 'NEEDS_ATTENTION');
    }
    if (dispatching.status !== 'DISPATCHING') dispatching = await this.wbStores.markPublicationDispatching(publication.id);
    try {
      const task = await this.publishing.n8n.submitListing({
        folderName: job.sku,
        revision,
        generatedVersionId: publication.generatedVersionId,
        submissionMode: snapshotSubmissionMode as 'CREATE_ONLY' | 'COMPATIBLE_UPSERT',
        mediaPolicy,
        mediaTargetVendorCodes: snapshotMediaTargetVendorCodes,
        automationRunId: snapshotAutomationRunId,
        existingCardBaseline: snapshotExistingCardBaseline,
        storeId: publication.storeId,
        storeAlias: publication.storeAlias,
        publicationId: publication.id,
        ...(snapshotCredentialVersionId ? { credentialVersionId: snapshotCredentialVersionId } : {}),
        storeConfigVersion: snapshotStoreConfigVersion,
        warehouseId: snapshotWarehouseId,
        idempotencyKey,
        ...(materializedPublication ? {
          packageRelPath: prepared.packageRelPath,
          packageSignature: prepared.packageSignature,
          materializationHash: frozenMaterializationHash
        } : {})
      });
      const queued = await this.wbStores.markPublicationQueued(publication.id, task.taskId, task.raw);
      await cleanupPackage();
      return queued;
    } catch (error) {
      const classified = classifyWbPublicationDispatchError(error, { publicationId: publication.id, taskId });
      if (classified.kind === 'REJECTED') {
        await this.wbStores.markPublicationFailed(publication.id, classified.code, classified.message);
        await cleanupPackage();
        throw new StopJob(classified.code, classified.message, 'NEEDS_ATTENTION');
      }
      await this.wbStores.markPublicationDispatchUnknown(
        publication.id, taskId, classified.code, classified.message
      );
      throw classified.error;
    }
  }

  private async recoverSelfOwnedPartialCreate(job: WbAutoPublishJob, matches: WbVendorCodeMatch[]): Promise<void> {
    if (!job.n8nTaskId) throw new ExistingCardError(matches);
    await this.transitionJob(job, 'CHECKING', {
      eventType: 'SELF_OWNED_CREATE_ONLY_CARDS_CONFIRMED',
      message: '已确认 WB 既有 ACTIVE 商品卡属于当前 CREATE_ONLY partial-create 任务，准备恢复 n8n 任务',
      details: { n8nTaskId: job.n8nTaskId, matches },
      errorCode: null,
      errorMessage: null,
      clearLease: false
    });
    const recovered = await this.publishing.n8n.recoverPartialCreate(job.n8nTaskId);
    await this.repository.setListingLock(job.sku, true);
    await this.transitionJob(job, 'RUNNING', {
      eventType: 'PARTIAL_CREATE_RECOVERY_STARTED',
      message: 'n8n partial-create 任务已恢复，继续同步库存和最终状态',
      details: { n8nTaskId: recovered.taskId, state: recovered.state, resumedState: recovered.resumedState },
      n8nTaskId: recovered.taskId,
      nextAttemptAt: null,
      errorCode: null,
      errorMessage: null
    });
  }

  private async recoverCompatibleForJob(job: WbAutoPublishJob, runtimeJob: JsonRecord) {
    if (job.operationMode !== 'COMPATIBLE_UPSERT' || !job.n8nTaskId) {
      throw new AppError('COMPATIBLE_RECOVERY_UNSAFE', '自动任务不是可恢复的 COMPATIBLE_UPSERT 任务', { sku: job.sku }, 409);
    }
    const runtime = runtimeResult(runtimeJob);
    const automationRunId = String(runtime.automationRunId || '').trim();
    if (!automationRunId || automationRunId !== job.runId) {
      throw new AppError('COMPATIBLE_RECOVERY_UNSAFE', 'runtime task 与自动任务的 automationRunId 不一致', {
        sku: job.sku, taskId: job.n8nTaskId
      }, 409);
    }
    const product = asObject(runtime.product);
    const variants = Array.isArray(product.variants) ? product.variants.map(asObject) : [];
    const expectedVendorCodes = variants.map((variant) => String(variant.vendorCode || '').trim()).filter(Boolean);
    if (!expectedVendorCodes.length || new Set(expectedVendorCodes).size !== expectedVendorCodes.length) {
      throw new AppError('COMPATIBLE_RECOVERY_UNSAFE', 'runtime product 缺少唯一的 vendorCode 列表', {
        sku: job.sku, taskId: job.n8nTaskId
      }, 409);
    }
    const ownership = await this.publishing.repository.getListingTaskOwnership(job.n8nTaskId);
    const ownershipRunId = String(ownership.automationContext.runId || '').trim();
    const ownershipMode = String(ownership.automationContext.operationMode || '').toUpperCase();
    const expectedSubjectId = Number(runtime.expectedSubjectId ?? asObject(product.category).subjectId);
    if (ownership.sku !== job.sku || ownership.taskId !== job.n8nTaskId
      || ownershipRunId !== job.runId || ownershipMode !== 'COMPATIBLE_UPSERT'
      || !Number.isInteger(expectedSubjectId) || expectedSubjectId < 1
      || ownership.subjectId !== expectedSubjectId) {
      throw new AppError('COMPATIBLE_RECOVERY_UNSAFE', 'listing、类目或自动轮次归属无法与 runtime task 精确对应', {
        sku: job.sku, taskId: job.n8nTaskId, ownershipRunId, expectedSubjectId, listingSubjectId: ownership.subjectId
      }, 409);
    }
    const recoveryStore = this.wbStores ? await this.wbStores.getStore(job.storeId) : undefined;
    const checked = await this.checkVendorCodesForJob(job, expectedVendorCodes, recoveryStore, 'compatible-recovery');
    const matches = dedupeVendorCodeMatches(checked.matches);
    const recoveredRuntimeJob = await this.publishing.repository.recoverCompatibleRuntimeJob(job.n8nTaskId, {
      automationRunId: job.runId,
      matches: matches as WbRuntimeCardMatch[]
    });
    await this.repository.setListingLock(job.sku, true);
    const automationJob = await this.transitionJob(job, 'RUNNING', {
      eventType: 'COMPATIBLE_RECOVERY_STARTED',
      message: '已确认同一自动轮次的 WB 商品卡，原 n8n task 将从安全阶段继续执行',
      details: {
        n8nTaskId: job.n8nTaskId,
        resumedState: recoveredRuntimeJob.resumedState || recoveredRuntimeJob.state,
        originTaskId: recoveredRuntimeJob.originTaskId,
        existingCardBaseline: runtimeResult(recoveredRuntimeJob).existingCardBaseline
      },
      n8nTaskId: job.n8nTaskId,
      nextAttemptAt: null,
      errorCode: null,
      errorMessage: null
    });
    return { runtimeJob: recoveredRuntimeJob, automationJob };
  }

  private async handleJobError(job: WbAutoPublishJob, error: unknown): Promise<void> {
    this.logger.warn({ err: error, sku: job.sku }, 'WB 自动上品任务推进失败');
    if (error instanceof ExistingCardError) {
      await this.transitionJob(job, 'BLOCKED_EXISTING_CARD', { eventType: 'EXISTING_CARD_BLOCKED', message: error.message, details: { matches: error.matches }, nextAttemptAt: null, errorCode: error.code, errorMessage: error.message });
      await this.repository.setListingLock(job.sku, false);
      return;
    }
    if (error instanceof StopJob) {
      await this.transitionJob(job, error.state, {
        eventType: 'AUTOMATION_STOPPED', message: error.message, details: error.details,
        nextAttemptAt: null, errorCode: error.code, errorMessage: error.message
      });
      await this.repository.setListingLock(job.sku, false);
      return;
    }
    const message = error instanceof Error ? error.message : '自动上品任务执行失败';
    const networkFailure = classifyWbNetworkError(error);
    const networkPlan = networkFailure ? nextWbNetworkRecovery({
      previous: job.networkRecovery,
      phase: job.networkRecovery?.phase || job.state,
      resumeState: job.networkRecovery?.resumeState || job.state,
      error,
      checkpoint: job.n8nTaskId ? `taskId:${job.n8nTaskId}` : `runId:${job.runId}`
    }) : undefined;
    if (networkPlan) {
      const retryKey = retryCategory(error, networkFailure?.httpStatus || 0);
      await this.transitionJob(job, 'WAITING_NETWORK', {
        eventType: networkFailure?.httpStatus === 429 ? 'RATE_LIMIT_WAIT_SCHEDULED' : 'NETWORK_WAIT_SCHEDULED',
        message: '网络或 WB 服务暂不可用；保留原任务并在网络恢复后自动继续',
        details: {
          httpStatus: networkFailure?.httpStatus,
          retryDelayMs: networkPlan.delayMs,
          retryKey,
          networkAttempt: networkPlan.recovery.attempt,
          deliveryState: networkPlan.recovery.deliveryState
        },
        nextAttemptAt: networkPlan.recovery.nextAttemptAt,
        incrementAttempt: true,
        incrementRetryKey: retryKey,
        networkRecovery: networkPlan.recovery,
        errorCode: networkPlan.recovery.lastErrorCode,
        errorMessage: networkPlan.recovery.lastErrorMessage
      });
      return;
    }
    const code = error instanceof AppError ? error.code : error instanceof RetryableJobError ? error.code : 'AUTO_PUBLISH_FAILED';
    const httpStatus = error instanceof AppError ? Number(error.details?.httpStatus || 0) : 0;
    if (httpStatus === 401 || httpStatus === 403) {
      await this.transitionJob(job, 'PAUSED', {
        eventType: 'AUTHENTICATION_FAILED', message: 'WB 或 n8n 鉴权失败，自动上品已立即暂停',
        details: { httpStatus }, nextAttemptAt: null, errorCode: 'WB_AUTH_FAILED', errorMessage: message
      });
      await this.repository.setListingLock(job.sku, false);
      return;
    }
    const retryable = error instanceof RetryableJobError
      || (error instanceof AppError && (error.code === 'DATABASE_UNAVAILABLE'
        || error.code === 'WB_TASK_NOT_REGISTERED'
        || (error.code === 'VERIFY_FAILED' && (httpStatus === 0 || httpStatus === 429 || httpStatus >= 500))));
    const retryKey = retryCategory(error, httpStatus);
    const retryCount = Math.max(0, Number(job.retryCounters[retryKey] || 0));
    const retryDelayMs = NON_NETWORK_RETRY_DELAYS_MS[retryCount];
    const nextAttempt = retryCount < NON_NETWORK_RETRY_DELAYS_MS.length && retryDelayMs !== undefined
      ? new Date(Date.now() + retryDelayMs).toISOString()
      : undefined;
    if (retryable && nextAttempt) {
      await this.transitionJob(job, 'FAILED', {
        eventType: httpStatus === 429 ? 'RATE_LIMIT_RETRY_SCHEDULED' : 'RETRY_SCHEDULED', message,
        details: httpStatus ? { httpStatus, retryDelayMs, retryKey, retryCount: retryCount + 1 } : { retryDelayMs, retryKey, retryCount: retryCount + 1 },
        nextAttemptAt: nextAttempt, incrementAttempt: true, incrementRetryKey: retryKey, errorCode: code, errorMessage: message
      });
      return;
    }
    await this.transitionJob(job, 'NEEDS_ATTENTION', {
      eventType: 'AUTOMATION_FAILED',
      message,
      details: {
        retryKey, retryCount,
        ...(error instanceof AppError ? asObject(error.details) : {})
      },
      nextAttemptAt: null,
      incrementAttempt: true,
      incrementRetryKey: retryable ? retryKey : undefined,
      errorCode: code,
      errorMessage: message
    });
    await this.repository.setListingLock(job.sku, false);
  }
}

function isSuccessfulWbDelivery(record: SubmissionRecord): boolean {
  return record.status === 'SUCCESS' && record.deliveryType === 'WB_MEDIA' && Boolean(record.productSku)
    && (record.sourceStageId === 'E004' || record.sourceStageId === 'E005');
}

function retryCategory(error: unknown, httpStatus: number): string {
  const networkCode = transientNetworkErrorCode(error);
  if (networkCode) return `WB_NETWORK_${networkCode}`;
  if (error instanceof RetryableJobError) {
    if (error.code === 'INITIALIZATION_INCOMPLETE') return 'INITIALIZATION';
    if (error.code === 'WB_RUNTIME_NOT_READY') return 'RUNTIME';
    return `RETRYABLE_${error.code}`;
  }
  if (error instanceof AppError) {
    if (error.code === 'DATABASE_UNAVAILABLE') return 'DATABASE';
    if (error.code === 'WB_TASK_NOT_REGISTERED') return 'WB_TASK_REGISTRATION';
    if (error.code === 'VERIFY_FAILED') {
      if (httpStatus === 429) return 'WB_RATE_LIMIT';
      if (httpStatus >= 500) return 'WB_SERVER';
      return 'WB_READ';
    }
    return `APP_${error.code}`;
  }
  return 'UNKNOWN';
}

async function inspectManifest(
  manifestFile: string,
  sku: string,
  variants: Array<{ variantId: string; name: string; wbColor?: { colorKey: string } }>,
  activation: string,
  rules: { minImages: number; maxImages: number; videoAllowed: boolean }
): Promise<{ signature: string; issues: string[] }> {
  let parsed: JsonRecord;
  try { parsed = JSON.parse(await readFile(manifestFile, 'utf8')) as JsonRecord; }
  catch (error: any) {
    if (error?.code === 'ENOENT') return { signature: '', issues: ['媒体清单尚未生成'] };
    throw new StopJob('MEDIA_MANIFEST_INVALID', '媒体清单无法解析', 'NEEDS_ATTENTION');
  }
  if (Number(parsed.schemaVersion) !== 2 || parsed.SKU !== sku || !Array.isArray(parsed.assets)) {
    throw new StopJob('MEDIA_MANIFEST_INVALID', '自动上品只接受与 SKU 一致的 schemaVersion 2 媒体清单', 'NEEDS_ATTENTION');
  }
  const assets = parsed.assets.map((item: unknown) => asObject(item) as ManifestAsset);
  const activationMs = Date.parse(activation);
  const selected: ManifestAsset[] = [];
  const issues: string[] = [];
  for (const variant of variants) {
    const candidates = assets.filter((asset) => manifestAssetMatchesVariant(asset, variant) && Date.parse(String(asset.deliveredAt || '')) >= activationMs);
    const images = orderedLatestImages(
      latestBatch(candidates.filter((asset) => asset.sourceStageId === 'E005' && asset.kind === 'image')),
      variant.name
    );
    const videos = latestBatch(candidates.filter((asset) => asset.sourceStageId === 'E004' && asset.kind === 'video'));
    if (images.length < Number(rules.minImages) || images.length > Number(rules.maxImages)) issues.push(`${variant.name}：E005 图片需要 ${rules.minImages}-${rules.maxImages} 张，当前 ${images.length} 张`);
    if (rules.videoAllowed && videos.length !== 1) issues.push(`${variant.name}：最新 E004 批次必须恰好包含 1 个视频，当前 ${videos.length} 个`);
    selected.push(...images, ...(rules.videoAllowed ? videos : []));
  }
  const fileSnapshots = await Promise.all(selected.map(async (asset) => {
    const relative = String(asset.relativePath || '');
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new StopJob('MEDIA_PATH_INVALID', '媒体清单包含不安全路径', 'NEEDS_ATTENTION');
    const full = path.resolve(path.dirname(path.dirname(manifestFile)), relative);
    const productRoot = path.dirname(path.dirname(manifestFile));
    if (!full.startsWith(`${productRoot}${path.sep}`)) throw new StopJob('MEDIA_PATH_INVALID', '媒体路径超出商品目录', 'NEEDS_ATTENTION');
    const info = await stat(full).catch(() => undefined);
    if (!info?.isFile() || info.size !== Number(asset.sizeBytes)) issues.push(`${relative}：文件缺失或大小已变化`);
    return { relativePath: relative, size: info?.size || 0, mtimeMs: info?.mtimeMs || 0, sha256: asset.sha256 || '' };
  }));
  return { signature: createHash('sha256').update(stableJson(fileSnapshots)).digest('hex'), issues };
}

export function buildAutomaticAssignments(
  listing: JsonRecord,
  variants: Array<{ variantId: string; name: string; wbColor?: { colorKey: string } }>,
  activation: string,
  rules: { minImages: number; maxImages: number; videoAllowed: boolean },
  mediaTargetVariantIds = new Set(variants.map((variant) => variant.variantId))
) {
  const activationMs = Date.parse(activation);
  const assets = (Array.isArray(listing.mediaAssets) ? listing.mediaAssets : []) as WbMediaAsset[];
  const productById = new Map(variants.map((variant) => [variant.variantId, variant]));
  return (Array.isArray(listing.variants) ? listing.variants : []).map((wbVariant: JsonRecord) => {
    const product = productById.get(String(wbVariant.productVariantId || ''));
    if (!product) throw new StopJob('MEDIA_VARIANT_MISMATCH', `${wbVariant.vendorCode || '变体'} 无法按 productVariantId 匹配媒体`, 'NEEDS_ATTENTION');
    const cutoff = mediaTargetVariantIds.has(product.variantId) ? activationMs : 0;
    const candidates = assets.filter((asset) => asset.validationStatus === 'VALID' && wbMediaMatchesVariant(asset, product) && Date.parse(asset.deliveredAt || '') >= cutoff);
    const images = orderedLatestImages(
      latestWbMediaDeliveryBatch(candidates.filter((asset) => asset.kind === 'image' && asset.sourceStageId === 'E005')),
      product.name
    );
    const videos = latestWbMediaDeliveryBatch(candidates.filter((asset) => asset.kind === 'video' && asset.sourceStageId === 'E004'));
    if (images.length < Number(rules.minImages) || images.length > Number(rules.maxImages)) throw new StopJob('MEDIA_INCOMPLETE', `${product.name} 图片数量不符合类目要求`, 'NEEDS_ATTENTION');
    if (rules.videoAllowed && videos.length !== 1) throw new StopJob('MEDIA_INCOMPLETE', `${product.name} 必须有且只有一个最新视频`, 'NEEDS_ATTENTION');
    return { variantId: wbVariant.variantId, imageAssetIds: images.map((asset) => asset.assetId), ...(rules.videoAllowed ? { videoAssetId: videos[0]!.assetId } : {}) };
  });
}

function latestBatch(assets: ManifestAsset[]): ManifestAsset[] {
  if (!assets.length) return [];
  const groups = new Map<string, ManifestAsset[]>();
  for (const asset of assets) groups.set(String(asset.submissionId || ''), [...(groups.get(String(asset.submissionId || '')) || []), asset]);
  return [...groups.entries()]
    .sort((left, right) => manifestBatchSortValue(right).localeCompare(manifestBatchSortValue(left)))[0]?.[1] || [];
}

function orderedLatestImages<T extends { relativePath?: string; sortOrder?: unknown }>(assets: T[], variantName: string): T[] {
  const ordering = resolveManifestMediaOrder(assets.map((asset) => ({
    ...asset,
    relativePath: String(asset.relativePath || '')
  })));
  if (!ordering.ok) {
    throw new StopJob(
      'MEDIA_MANIFEST_INVALID',
      `${variantName}：${ordering.message}`,
      'NEEDS_ATTENTION'
    );
  }
  return ordering.assets as T[];
}

function manifestAssetMatchesVariant(asset: ManifestAsset, variant: { variantId: string; wbColor?: { colorKey: string } }): boolean {
  if (asset.variantId) return asset.variantId === variant.variantId;
  return Boolean(asset.variantColor?.colorKey && variant.wbColor?.colorKey && asset.variantColor.colorKey === variant.wbColor.colorKey);
}

function manifestBatchSortValue(entry: [string, ManifestAsset[]]): string {
  const deliveredAt = entry[1].map((asset) => String(asset.deliveredAt || '')).sort().at(-1) || '';
  return `${deliveredAt}\0${entry[0]}`;
}
function asObject(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function isReadyAutoPublishStore(store: WbStore): boolean {
  return Boolean(store.enabled && store.autoPublishEnabled && store.autoPublishActivatedAt
    && (store.readiness.ready || (store.storeAlias === 'default' && store.credential.state === 'LEGACY_EXTERNAL')));
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as JsonRecord).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function isMissingListing(error: unknown): boolean { return error instanceof AppError && error.code === 'NOT_FOUND' && error.message.includes('草稿'); }
export async function isStaleAutomationDraft(listing: unknown, countVersions: (sku: string) => Promise<number>): Promise<boolean> {
  const candidate = asObject(listing);
  const sku = String(candidate.sku || '').trim();
  if (!sku) return false;
  if (candidate.status !== 'DRAFT') return false;
  if (candidate.latestOperationSource !== 'AUTOMATION') return false;
  if (String(candidate.n8nTaskId || '').trim()) return false;
  if (Array.isArray(candidate.nmIds) && candidate.nmIds.length > 0) return false;
  if (Array.isArray(candidate.productUrls) && candidate.productUrls.length > 0) return false;
  if (Array.isArray(candidate.mediaAssets) && candidate.mediaAssets.length > 0) return false;
  if (Array.isArray(candidate.variantMedia) && candidate.variantMedia.length > 0) return false;
  return (await countVersions(sku)) === 0;
}

export function isBlockingInitializationIssue(issue: unknown): boolean {
  const candidate = asObject(issue);
  if (candidate.severity !== 'ERROR') return false;
  return !['E003_DESCRIPTION_MISSING', 'E003_DESCRIPTION_AMBIGUOUS', 'E003_DESCRIPTION_FALLBACK'].includes(String(candidate.code || ''));
}
export function shouldRegenerateSubmittedListingAfterRecheck(job: Pick<WbAutoPublishJob, 'state' | 'n8nTaskId' | 'lastErrorCode'>, listing: unknown): boolean {
  const candidate = asObject(listing);
  return job.state === 'CHECKING'
    && Boolean(job.n8nTaskId)
    && !job.lastErrorCode
    && candidate.n8nTaskId === job.n8nTaskId
    && (candidate.status === 'FAILED' || candidate.status === 'BLOCKED');
}

export type CreateOnlyMatchClassification = {
  kind: 'CLEAR' | 'SELF_OWNED' | 'BLOCKED';
  matches: WbVendorCodeMatch[];
  reason?: string;
};

export function classifyCreateOnlyMatches(
  expectedVendorCodes: string[],
  matches: WbVendorCodeMatch[],
  listing: unknown,
  job: Pick<WbAutoPublishJob, 'operationMode' | 'n8nTaskId'>
): CreateOnlyMatchClassification {
  const uniqueMatches = dedupeVendorCodeMatches(matches);
  if (!uniqueMatches.length) return { kind: 'CLEAR', matches: [] };
  const trashMatches = uniqueMatches.filter((match) => match.location === 'TRASH');
  if (trashMatches.length) return { kind: 'BLOCKED', matches: trashMatches, reason: 'trash_match' };
  if (job.operationMode !== 'CREATE_ONLY' || !job.n8nTaskId) {
    return { kind: 'BLOCKED', matches: uniqueMatches, reason: 'not_create_only_recovery' };
  }
  const listingRecord = asObject(listing);
  if (String(listingRecord.n8nTaskId || '') !== job.n8nTaskId) {
    return { kind: 'BLOCKED', matches: uniqueMatches, reason: 'task_mismatch' };
  }
  const expected = new Set(expectedVendorCodes.map((vendorCode) => vendorCode.trim()).filter(Boolean));
  if (!expected.size) return { kind: 'BLOCKED', matches: uniqueMatches, reason: 'expected_vendor_codes_missing' };
  const activeMatches = uniqueMatches.filter((match) => match.location === 'ACTIVE');
  const variants = Array.isArray(asObject(listingRecord.task).variants) ? asObject(listingRecord.task).variants : [];
  const owned = new Map<string, number>();
  for (const item of variants) {
    const variant = asObject(item);
    const vendorCode = String(variant.vendorCode || '').trim();
    const nmId = Number(variant.nmID ?? variant.nmId);
    if (vendorCode && Number.isInteger(nmId) && nmId > 0) owned.set(vendorCode, nmId);
  }
  if (!owned.size) return { kind: 'BLOCKED', matches: uniqueMatches, reason: 'task_variants_missing' };
  const activeVendorCodes = new Set<string>();
  for (const match of activeMatches) {
    activeVendorCodes.add(match.vendorCode);
    if (!expected.has(match.vendorCode)) return { kind: 'BLOCKED', matches: uniqueMatches, reason: 'unexpected_vendor_code' };
    if (!Number.isInteger(match.nmId) || !owned.has(match.vendorCode) || owned.get(match.vendorCode) !== match.nmId) {
      return { kind: 'BLOCKED', matches: uniqueMatches, reason: 'nm_id_mismatch' };
    }
  }
  for (const vendorCode of expected) {
    if (!activeVendorCodes.has(vendorCode)) return { kind: 'BLOCKED', matches: uniqueMatches, reason: 'partial_self_owned_match' };
    if (!owned.has(vendorCode)) return { kind: 'BLOCKED', matches: uniqueMatches, reason: 'task_variant_missing' };
  }
  return { kind: 'SELF_OWNED', matches: activeMatches, reason: 'exact_self_owned_match' };
}

function dedupeVendorCodeMatches(matches: WbVendorCodeMatch[]): WbVendorCodeMatch[] {
  const seen = new Set<string>();
  const output: WbVendorCodeMatch[] = [];
  for (const match of matches) {
    const key = `${match.location}|${match.vendorCode}|${match.nmId || ''}|${match.imtId || ''}|${match.subjectId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(match);
  }
  return output;
}
function activeCardBaseline(matches: WbVendorCodeMatch[]) {
  const byVendor = new Map<string, { vendorCode: string; nmID: string }>();
  for (const match of dedupeVendorCodeMatches(matches)) {
    if (match.location !== 'ACTIVE' || !Number.isInteger(match.nmId) || Number(match.nmId) < 1) continue;
    const current = byVendor.get(match.vendorCode);
    const next = { vendorCode: match.vendorCode, nmID: String(match.nmId) };
    if (current && current.nmID !== next.nmID) {
      throw new AppError('COMPATIBLE_RECOVERY_UNSAFE', '同一卖家商品编码匹配到多个 WB 商品编码', {
        vendorCode: match.vendorCode
      }, 409);
    }
    byVendor.set(match.vendorCode, next);
  }
  return [...byVendor.values()].sort((left, right) => left.vendorCode.localeCompare(right.vendorCode));
}
function runtimeResult(job: JsonRecord): JsonRecord {
  if (job.result && typeof job.result === 'object' && !Array.isArray(job.result)) return asObject(job.result);
  const raw = job.result_json;
  if (typeof raw !== 'string') return asObject(raw);
  try { return asObject(JSON.parse(raw)); }
  catch { return {}; }
}
export function isCompatibleRuntimeRecoveryCandidate(job: JsonRecord): boolean {
  const runtime = runtimeResult(job);
  return String(job.state || job.status || '').toUpperCase() === 'FAILED'
    && (job.partial_effects === true || job.partialEffects === true)
    && String(runtime.submissionMode || '').toUpperCase() === 'COMPATIBLE_UPSERT';
}
export function listingTaskErrorCode(listing: unknown, runtimeTask?: unknown): string {
  return wbTaskErrorDetails(listing, runtimeTask).errorCode;
}
export function listingTaskErrorMessage(listing: unknown, runtimeTask?: unknown): string | null {
  return wbTaskErrorDetails(listing, runtimeTask).errorMessage;
}
export function transientNetworkErrorCode(error: unknown): string | undefined {
  return transportErrorCode(error);
}
function sum(counts: Record<string, number>, states: string[]): number { return states.reduce((total, state) => total + (counts[state] || 0), 0); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function resumeNetworkWaitingJob(job: WbAutoPublishJob): WbAutoPublishJob {
  if (job.state !== 'WAITING_NETWORK' || !job.networkRecovery?.resumeState) return job;
  return { ...job, state: job.networkRecovery.resumeState as WbAutoPublishState };
}

function asNetworkRecovery(value: unknown): WbNetworkRecovery | undefined {
  const recovery = asObject(value);
  const attempt = Number(recovery.attempt);
  const nextAttemptAt = String(recovery.nextAttemptAt || '');
  if (!Number.isInteger(attempt) || attempt < 1 || !Number.isFinite(Date.parse(nextAttemptAt))) return undefined;
  return recovery as WbNetworkRecovery;
}

class WbGenerationLeaseGuard {
  private current: WbAutoGenerationLeaseClaim;
  private phase: string;
  private sourceVersionId?: string;
  private heartbeatTail: Promise<void> = Promise.resolve();
  private failure?: unknown;
  private released = false;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly repository: WbAutoPublishRepository,
    private readonly job: Pick<WbAutoPublishJob, 'id' | 'sku' | 'runId'>,
    initial: WbAutoGenerationLeaseClaim
  ) {
    this.current = initial;
    this.phase = initial.phase;
    this.sourceVersionId = initial.sourceVersionId;
    this.timer = setInterval(() => {
      void this.fence(this.phase, this.sourceVersionId).catch(() => undefined);
    }, 30_000);
    this.timer.unref?.();
  }

  async fence(phase: string, sourceVersionId?: string): Promise<WbAutoGenerationLeaseClaim> {
    if (this.released) {
      throw new AppError('AUTOMATION_GENERATION_LEASE_LOST', '自动生成租约已释放，禁止继续修改共享资料', {
        sku: this.job.sku, jobId: this.job.id, runId: this.job.runId
      }, 409);
    }
    if (this.failure) throw this.failure;
    this.phase = phase;
    if (sourceVersionId) this.sourceVersionId = sourceVersionId;
    let resolved!: WbAutoGenerationLeaseClaim;
    const operation = this.heartbeatTail.then(async () => {
      if (this.failure) throw this.failure;
      resolved = await this.repository.heartbeatGenerationLease(this.job, {
        phase: this.phase,
        ...(this.sourceVersionId ? { sourceVersionId: this.sourceVersionId } : {}),
        expectedRowVersion: this.current.rowVersion
      });
      this.current = resolved;
    });
    this.heartbeatTail = operation.catch((error) => {
      this.failure ||= error;
    });
    await operation;
    return resolved;
  }

  async release(): Promise<boolean> {
    if (this.released) return false;
    this.released = true;
    clearInterval(this.timer);
    await this.heartbeatTail.catch(() => undefined);
    return this.repository.releaseGenerationLease(this.job, this.current.rowVersion);
  }
}

function automationRunIdFromOperationRef(operationRef: string): string | undefined {
  return operationRef.match(/^automation:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i)?.[1]?.toLowerCase();
}

function assertAutomationPublicationForJob(
  publication: WbStorePublication,
  job: WbAutoPublishJob,
  store: WbStore,
  presetDefinitionHash: string,
  requireMaterialized: boolean
): void {
  const snapshot = asObject(publication.configSnapshot);
  const sourceGeneratedVersionId = String(snapshot.sourceGeneratedVersionId || '');
  const presetId = String(publication.presetId || snapshot.presetId || '');
  const invalid = publication.source !== 'AUTOMATION'
    || publication.sku !== job.sku
    || publication.storeId !== job.storeId
    || publication.storeId !== store.id
    || String(snapshot.automationRunId || '') !== job.runId
    || !job.presetId
    || presetId !== job.presetId
    || String(publication.presetDefinitionHash || '') !== presetDefinitionHash
    || (requireMaterialized && (
      !sourceGeneratedVersionId
      || publication.generatedVersionId === sourceGeneratedVersionId
      || !/^sha256:[a-f0-9]{64}$/.test(String(publication.materializationHash || ''))
    ));
  if (invalid) {
    throw new AppError('VERSION_CONFLICT', '自动任务已链接到不一致或不可验证的店铺发布记录', {
      sku: job.sku,
      storeId: job.storeId,
      automationRunId: job.runId,
      presetId: job.presetId || null,
      publicationId: publication.id,
      publicationSource: publication.source,
      publicationStoreId: publication.storeId,
      publicationAutomationRunId: snapshot.automationRunId || null,
      publicationPresetId: presetId || null,
      sourceGeneratedVersionId: sourceGeneratedVersionId || null,
      materializationHash: publication.materializationHash || null
    }, 409);
  }
}

class RetryableJobError extends Error { constructor(readonly code: string, message: string) { super(message); } }
class StopJob extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly state: 'PAUSED' | 'NEEDS_ATTENTION',
    readonly details: JsonRecord = {}
  ) { super(message); }
}
class ExistingCardError extends Error {
  readonly code = 'WB_CARD_ALREADY_EXISTS';
  constructor(readonly matches: unknown[], message = 'WB 普通商品卡或回收站中已存在相同卖家商品编码，CREATE_ONLY 自动上品已阻止') { super(message); }
}
