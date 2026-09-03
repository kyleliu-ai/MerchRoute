import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import {
  AppError,
  OZON_CONTENT_POLICY_V2,
  OZON_CONTENT_POLICY_VERSION,
  ozonPreparationRecheckInputSchema,
  ozonPreparationRecheckPlanInputSchema,
  projectOzonPresetRequiredAttributeCoverage,
  validateOzonDescription,
  validateOzonTitle,
  type OzonAttributeValueInput,
  type OzonCategoryAttribute,
  type OzonListingDraft,
  type OzonMediaAsset,
  type OzonPreparationRecoveryCapability,
  type OzonPreset,
  type OzonPublishJob,
  type PricingCalculationItem,
  type ProductVariant
} from '@n8n-media-review/shared';
import type { DeliveryReplayService } from '../delivery-replay.js';
import { stableHash } from '../review-operations.js';
import type { StateStore } from '../../repositories/store.js';
import type {
  OzonAutomaticPreparationReplanTarget,
  OzonRepository
} from '../../repositories/ozon.js';
import type { OzonEligibleAutoStore, OzonStoreRepository } from '../../repositories/ozon-stores.js';
import type { PurchaseRepository } from '../../repositories/purchases.js';
import type { PricingRepository } from '../../repositories/pricing.js';
import type { E003DescriptionSourceService, E003VariantDescriptionsResult } from '../wb-presets/e003-description.js';
import {
  deriveOzonStorePresetOfferIds,
  selectOzonListingProductVariants,
  type OzonPublishingService
} from './index.js';
import { nextOzonNetworkRecovery, normalizeOzonNetworkError } from './network-recovery.js';
import type { OzonTitleTranslator } from './title-translation.js';
import {
  createOzonCompatibleIdentityPlan,
  normalizeOzonNoBrandForPlatform,
  prepareOzonManagedSharedAttributes
} from './material-preparation.js';
import { resolveManifestMediaOrder } from '../manifest-media-order.js';
import {
  stableMaterial,
  stablePresetMaterial,
  type OzonAutomaticDeliveryIdentity,
  type OzonStoreService
} from '../ozon-stores/index.js';
import type { OzonStoreGatewayService } from '../ozon-stores/gateway.js';
import { validOzonPrePlanAbsenceOperations } from '../../ozon-preplan-absence.js';

type JsonRecord = Record<string, any>;
function deterministicPreparationRequestId(jobId: string, planHash: string): string {
  const hex = createHash('sha256').update(`ozon-preparation-recheck\u0000${jobId}\u0000${planHash}`).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
type OzonAutoMode = 'CREATE_ONLY' | 'COMPATIBLE_UPSERT';
type DeliveryNotification = {
  sku: string;
  stageId: 'E004' | 'E005';
  submissionId: string;
  variantId?: string;
  deliveredAt: string;
  resolvedOutputRoot?: string;
  selectedRelativePaths?: string[];
};
type ManifestAsset = {
  assetId: string;
  submissionId: string;
  sourceStageId: 'E004' | 'E005';
  kind: 'image' | 'video';
  variantId: string;
  variantName: string;
  variantColor?: { colorKey?: string; nameRu?: string; nameZh?: string };
  relativePath: string;
  deliveredAt: string;
  sizeBytes: number;
  sha256?: string;
  sortOrder?: unknown;
};
export type OzonMediaVariant = {
  variantId: string;
  variantName: string;
  colorNameRu?: string;
  images: ManifestAsset[];
  videos: ManifestAsset[];
};
export type OzonMediaInspection = {
  productRoot: string;
  signature: string;
  issues: string[];
  variants: OzonMediaVariant[];
};

type OzonVariantPublicationScope = {
  mode: 'INITIAL_FULL' | 'APPEND_MISSING' | 'REFRESH_EXISTING' | 'NO_OP';
  publicationVariants: ProductVariant[];
  representedVariantIds: string[];
  requiredVariantIds: string[];
};

type CoordinatorOptions = { historyReplay?: DeliveryReplayService; workerIntervalMs?: number; reconciliationIntervalMs?: number; stableProbeMs?: number; concurrency?: number };
type OzonMultistoreAutoDependencies = {
  storeRepository: Pick<OzonStoreRepository,
    'completeFanoutPreparation' | 'finalizeMediaFanoutBatch' | 'freezePreparationFanoutPlan' | 'getStore' | 'isFleetCapabilityReady' | 'listEligibleAutoStores' | 'listStores'>;
  storeService: Pick<OzonStoreService,
    'automaticPublicationPlan' | 'createAutomaticPublications' | 'createAutomaticPublicationsFromFrozenPlan'>;
  /** Narrow, read-only dependency used only by PRE_PLAN recovery evidence. */
  storeGateway?: Pick<OzonStoreGatewayService, 'proveStoreOfferAbsence' | 'proveExactNoBrandDictionaryValue'>;
};
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
export class OzonAutoPublishingCoordinator {
  private stopped = true;
  private workerTimer?: NodeJS.Timeout;
  private reconciliationTimer?: NodeJS.Timeout;
  private workerPromise?: Promise<void>;
  private reconciliationPromise?: Promise<void>;
  private readonly runningJobs = new Set<string>();
  private readonly reconciledDeliveries = new Set<string>();
  private lastReconciledAt?: string;
  private readonly workerIntervalMs: number;
  private readonly reconciliationIntervalMs: number;
  private readonly stableProbeMs: number;
  private readonly concurrency: number;

  constructor(
    readonly repository: OzonRepository,
    private readonly publishing: OzonPublishingService,
    private readonly purchases: PurchaseRepository,
    private readonly pricing: PricingRepository,
    private readonly descriptions: Pick<E003DescriptionSourceService, 'resolveVariants'>,
    private readonly titleTranslator: OzonTitleTranslator,
    private readonly store: StateStore,
    private readonly logger: FastifyBaseLogger,
    private readonly options: CoordinatorOptions = {},
    private readonly multistore?: OzonMultistoreAutoDependencies
  ) {
    this.workerIntervalMs = Math.max(1_000, options.workerIntervalMs ?? 10_000);
    this.reconciliationIntervalMs = Math.max(5_000, options.reconciliationIntervalMs ?? 60_000);
    this.stableProbeMs = Math.max(0, options.stableProbeMs ?? 1_000);
    this.concurrency = Math.min(4, Math.max(1, options.concurrency ?? 2));
  }

  start(): void {
    if (!this.repository.configured || !this.purchases.configured || !this.pricing.configured || this.stopped === false) return;
    this.stopped = false;
    this.workerTimer = setInterval(() => { void this.runWorkerNow(); }, this.workerIntervalMs);
    this.reconciliationTimer = setInterval(() => { void this.reconcileNow(); }, this.reconciliationIntervalMs);
    this.workerTimer.unref();
    this.reconciliationTimer.unref();
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

  async status() {
    const [readiness, counts, businessCounts, remoteJobs, stores] = await Promise.all([
      this.publishing.readiness(false),
      this.repository.stats('AUTO'),
      this.repository.stats('AUTO', true),
      this.repository.listJobs({ page: 1, pageSize: 1, remoteOnly: true, activeOnly: true }),
      this.multistore?.storeRepository.listStores?.(false) || Promise.resolve([])
    ]);
    const multistoreFleetReady = !this.multistore
      || this.multistore.storeRepository.isFleetCapabilityReady?.() !== false;
    const capabilityBlockers = multistoreFleetReady ? [] : [{
      code: 'OZON_MULTISTORE_FLEET_CAPABILITY_DISABLED',
      message: 'OZON 多店铺调度 capability 尚未受控开启'
    }];
    const autoStores = stores.filter((store) => store.enabled && store.autoPublishEnabled);
    const eligibleAutoStores = autoStores.filter((store) => Boolean(
      store.autoPublishActivatedAt
      && store.defaultPresetId
      && store.readiness.ready
    ));
    const acceptingNewJobs = Boolean(
      readiness.settings.enabled
      && readiness.databaseReady
      && readiness.rootReady
      && readiness.workflowReady
      && readiness.mediaReady
      && readiness.videoUploadReady
      && multistoreFleetReady
      && eligibleAutoStores.length > 0
    );
    return {
      readiness,
      counts,
      businessCounts,
      managementEnabled: readiness.settings.enabled,
      acceptingNewJobs,
      continuingBoundJobs: remoteJobs.total,
      eligibleAutoStoreCount: eligibleAutoStores.length,
      blockedAutoStoreCount: Math.max(0, autoStores.length - eligibleAutoStores.length),
      capability: { multistoreFleetReady, blockers: capabilityBlockers },
      worker: { running: !this.stopped, ...(this.lastReconciledAt ? { lastReconciledAt: this.lastReconciledAt } : {}) }
    };
  }

  async onMediaDelivered(input: DeliveryNotification): Promise<OzonPublishJob | undefined> {
    const result = await this.handleMediaDelivered(input);
    return result?.job;
  }

  private async handleMediaDelivered(input: DeliveryNotification, kickWorker = true) {
    if (!this.repository.configured) return undefined;
    const media = {
      sourceStageId: input.stageId,
      submissionId: input.submissionId,
      variantId: input.variantId || '',
      deliveredAt: input.deliveredAt,
      resolvedOutputRoot: input.resolvedOutputRoot || '',
      selectedRelativePaths: input.selectedRelativePaths || []
    };
    if (this.multistore && this.multistore.storeRepository.isFleetCapabilityReady?.() === false) {
      return this.repository.deferAutomaticMediaDeliveryForCapability({ sku: input.sku, media });
    }
    const mediaReady = await this.inspectDeliveredMediaReadiness(input.sku);
    let multistoreAdmission: { storeId: string; presetId: string; activatedAt: string; autoPublishMode: OzonAutoMode } | undefined;
    if (this.multistore) {
      const eligible = await this.filterStoresByExactNoBrandDictionary(
        await this.multistore.storeRepository.listEligibleAutoStores(input.deliveredAt),
        'ENQUEUE'
      );
      const admissionCarrier = eligible[0];
      if (admissionCarrier?.defaultPresetId && admissionCarrier.autoPublishActivatedAt) {
        multistoreAdmission = {
          storeId: admissionCarrier.id,
          presetId: admissionCarrier.defaultPresetId,
          activatedAt: admissionCarrier.autoPublishActivatedAt,
          autoPublishMode: admissionCarrier.autoPublishMode
        };
      } else {
        return undefined;
      }
    }
    const result = await this.repository.enqueueAutomaticJob({
      sku: input.sku,
      mediaReady,
      media,
      ...(multistoreAdmission ? { multistoreAdmission } : {})
    });
    if (result.becameRunnable && kickWorker) void this.runWorkerNow();
    return result;
  }

  private async filterStoresByExactNoBrandDictionary(
    stores: OzonEligibleAutoStore[],
    phase: 'ENQUEUE' | 'REPLAN' | 'FREEZE'
  ): Promise<OzonEligibleAutoStore[]> {
    return (await Promise.all(stores.map(async (store) => {
      const requirement = store.noBrandDictionaryRequirement;
      if (!requirement) return store;
      const credentialVersionId = store.credential?.activeVersionId;
      const gateway = this.multistore?.storeGateway;
      if (!gateway || !credentialVersionId || !store.presetRowVersion) {
        this.logger.warn({
          storeId: store.id,
          storeAlias: store.storeAlias,
          phase,
          attributeId: requirement.attributeId,
          code: 'OZON_NO_BRAND_DICTIONARY_GATE_UNAVAILABLE'
        }, 'OZON 无品牌字典硬门不可用，店铺不进入自动上品任务');
        return undefined;
      }
      try {
        await gateway.proveExactNoBrandDictionaryValue({
          storeId: store.id,
          expectedStoreConfigVersion: store.configVersion,
          expectedCredentialVersionId: credentialVersionId,
          categoryVersionId: requirement.categoryVersionId,
          presetRowVersion: store.presetRowVersion,
          descriptionCategoryId: requirement.descriptionCategoryId,
          typeId: requirement.typeId,
          attributeId: requirement.attributeId,
          dictionaryId: requirement.dictionaryId
        });
        return store;
      } catch (error) {
        this.logger.warn({
          storeId: store.id,
          storeAlias: store.storeAlias,
          phase,
          attributeId: requirement.attributeId,
          code: error instanceof AppError ? error.code : 'OZON_NO_BRAND_DICTIONARY_GATE_FAILED',
          message: error instanceof Error ? error.message : String(error)
        }, 'OZON 无品牌字典唯一性未通过，店铺不进入自动上品任务');
        return undefined;
      }
    }))).filter((store): store is OzonEligibleAutoStore => Boolean(store));
  }

  private async inspectDeliveredMediaReadiness(sku: string): Promise<boolean> {
    const identity = await this.purchases.getProductIdentityBySku(sku);
    if (!identity || identity.sku !== sku || !identity.variants.length) {
      this.logger.warn({ sku }, 'OZON 媒体投递未匹配到完整 PostgreSQL 产品身份，保持 WAITING_MEDIA');
      return false;
    }
    const settings = await this.repository.getSettings();
    if (!settings.rootDirectory) {
      this.logger.warn({ sku }, 'OZON 媒体投递检查缺少根目录配置，保持 WAITING_MEDIA');
      return false;
    }
    const manifestPath = path.join(settings.rootDirectory, 'inbox', identity.sku, 'variants', 'variant-media-manifest.json');
    try {
      const listing = await this.repository.getListing(identity.sku).catch((error) => (
        isMissingListing(error) ? undefined : Promise.reject(error)
      ));
      const scope = resolveOzonVariantPublicationScope(identity.variants, listing);
      const requiredVariantIds = scope.mode === 'NO_OP'
        ? scope.publicationVariants.map((variant) => variant.variantId)
        : scope.requiredVariantIds;
      const inspection = await inspectOzonMediaManifest(
        manifestPath,
        identity.sku,
        identity.productName,
        scope.publicationVariants,
        requiredVariantIds
      );
      return Boolean(inspection.signature)
        && inspection.issues.length === 0;
    } catch (error) {
      this.logger.warn({ err: error, sku, manifestPath }, 'OZON 媒体清单尚不能证明媒体齐全，保持 WAITING_MEDIA');
      return false;
    }
  }

  async recheck(id: string, expectedRowVersion?: number): Promise<OzonPublishJob> {
    // The only storeless AUTO recheck route admitted by the store repository
    // is an exact pre-platform multistore preparation. Reset it through the
    // local CAS path; it must never enter the legacy n8n redispatch branch.
    const rebound = expectedRowVersion === undefined
      ? undefined
      : await this.repository.rebindAutomaticPreparationAfterMediaRescan({
          jobId: id,
          expectedJobRowVersion: expectedRowVersion
        });
    const job = rebound || await this.repository.recheck(id, 'AUTO', expectedRowVersion);
    void this.runWorkerNow();
    return job;
  }

  cancel(id: string) { return this.publishing.cancelJob(id, 'AUTO'); }
  list(input: Parameters<OzonRepository['listJobs']>[0]) { return this.repository.listJobs({ ...input, source: 'AUTO' }); }
  get(id: string) { return this.repository.getJob(id, 'AUTO'); }

  async preparationTaskDetail(id: string) {
    const job = await this.repository.getJob(id, 'AUTO');
    if (job.taskKind !== 'SHARED_PREPARATION') {
      throw new AppError('CONFIG_INVALID', '任务不是 OZON 共享准备协调任务', { id, taskKind: job.taskKind }, 409);
    }
    const fanoutPlan = asJsonRecord(job.payload?.fanoutPlan);
    const supersession = asJsonRecord(job.payload?.replanReplacement);
    const recovery = String(supersession.replacementPreparationJobId || '')
      ? {
          canRecheck: false,
          canManualTakeover: false,
          recoveryMode: 'NONE' as const,
          blockedReason: 'SUPERSEDED_BY_REPLAN_WITH_CURRENT_PRESET'
        }
      : Object.keys(fanoutPlan).length
      ? frozenFanoutRequiresCurrentPresetReplan(fanoutPlan)
        ? {
            canRecheck: false,
            canManualTakeover: false,
            recoveryMode: 'REPLAN_WITH_CURRENT_PRESET' as const,
            blockedReason: 'REPLAN_DRY_RUN_REQUIRED'
          }
        : preparationRecoveryCapability(job, true)
      : (await this.buildPrePlanRecoveryEvidence(job, { proveRemote: false })).capability;
    const fanoutSummary = job.fanoutSummary || asJsonRecord(job.payload?.fanoutSummary);
    return {
      job,
      events: job.events || [],
      fanoutSummary: Object.keys(fanoutSummary).length ? {
        ...fanoutSummary,
        ...(String(supersession.replacementPreparationJobId || '') ? recovery : {})
      } : {
        phase: 'NOT_STARTED',
        targetStoreCount: 0,
        publicationCount: 0,
        failureCount: ['NEEDS_ATTENTION', 'FAILED', 'CANCELLED'].includes(job.state) ? 1 : 0,
        ...recovery
      },
      frozenContract: fanoutPlan,
      recovery,
      ...(String(supersession.replacementPreparationJobId || '') ? { supersession } : {})
    };
  }

  async preparationMaterialSnapshot(id: string) {
    const job = await this.repository.getJob(id, 'AUTO');
    if (job.taskKind !== 'SHARED_PREPARATION') throw new AppError('CONFIG_INVALID', '任务不是 OZON 共享准备任务', { id }, 409);
    const listing = await this.repository.getListing(job.sku);
    const prepared = asJsonRecord(job.payload?.sharedMaterialPreparation);
    if (String(job.payload?.generatedVersionId || '') !== String(listing.generatedVersionId || '')
      || String(job.payload?.materialHash || '') !== String(listing.materialHash || '')
      || Number(prepared.listingRevision || 0) !== listing.revision) {
      throw new AppError('VERSION_CONFLICT', '共享准备任务的稳定素材身份已偏离', { id }, 409);
    }
    return {
      generatedVersionId: listing.generatedVersionId,
      materialRevision: listing.materialRevision,
      materialHash: listing.materialHash,
      materialHashVersion: listing.materialHashVersion,
      contentPolicyVersion: listing.contentPolicyVersion,
      sku: listing.sku,
      productName: listing.productName,
      data: listing.data
    };
  }

  async preparationRecheckPlan(id: string, input: unknown) {
    const parsed = ozonPreparationRecheckPlanInputSchema.safeParse(input);
    if (!parsed.success) throw new AppError('CONFIG_INVALID', 'OZON 共享准备重检缺少 rowVersion', { issues: parsed.error.issues }, 400);
    const job = await this.repository.getJob(id, 'AUTO');
    if (job.rowVersion !== parsed.data.rowVersion || job.taskKind !== 'SHARED_PREPARATION') {
      throw new AppError('TASK_LOCKED', 'OZON 共享准备任务已变化', { id }, 409);
    }
    const frozen = asJsonRecord(job.payload?.fanoutPlan);
    const supersession = asJsonRecord(job.payload?.replanReplacement);
    if (String(supersession.replacementPreparationJobId || '')) {
      const planHash = String(supersession.planHash || '');
      const requestId = String(supersession.requestId || '');
      if (!/^sha256:[a-f0-9]{64}$/.test(planHash) || !/^[0-9a-f-]{36}$/i.test(requestId)) {
        throw new AppError('VERSION_CONFLICT', 'OZON 旧任务的替代标记不完整', {
          id,
          replacementPreparationJobId: supersession.replacementPreparationJobId
        }, 409);
      }
      return {
        plan: {
          rowVersion: job.rowVersion,
          planHash,
          requestId,
          frozen,
          canRecheck: false,
          canManualTakeover: false,
          recoveryMode: 'NONE' as const,
          blockedReason: 'SUPERSEDED_BY_REPLAN_WITH_CURRENT_PRESET',
          supersession
        }
      };
    }
    if (!Object.keys(frozen).length) {
      const prePlan = await this.buildPrePlanRecoveryEvidence(job);
      return {
        plan: {
          rowVersion: job.rowVersion,
          planHash: prePlan.planHash,
          requestId: deterministicPreparationRequestId(id, prePlan.planHash),
          frozen: prePlan.frozen,
          ...prePlan.capability
        }
      };
    }
    if (frozenFanoutRequiresCurrentPresetReplan(frozen)) {
      const replan = await this.buildFrozenFanoutReplanEvidence(job, frozen);
      return {
        plan: {
          rowVersion: job.rowVersion,
          planHash: replan.planHash,
          requestId: deterministicPreparationRequestId(id, replan.planHash),
          frozen: replan.frozen,
          ...replan.capability
        }
      };
    }
    const planHash = String(frozen.planHash || '');
    if (!/^sha256:[a-f0-9]{64}$/.test(planHash)) {
      throw new AppError('VERSION_CONFLICT', '共享准备任务的冻结 fan-out 计划签名无效', { id }, 409);
    }
    const capability = preparationRecoveryCapability(job, true);
    return {
      plan: {
        rowVersion: job.rowVersion,
        planHash,
        requestId: deterministicPreparationRequestId(id, planHash),
        frozen,
        ...capability
      }
    };
  }

  async recheckPreparation(id: string, input: unknown) {
    const parsed = ozonPreparationRecheckInputSchema.safeParse(input);
    if (!parsed.success) throw new AppError('CONFIG_INVALID', 'OZON 共享准备重检合同无效', { issues: parsed.error.issues }, 400);
    const job = await this.repository.getJob(id, 'AUTO');
    const priorReplacement = asJsonRecord(job.payload?.replanReplacement);
    if (String(priorReplacement.requestId || '') === parsed.data.requestId
      && String(priorReplacement.planHash || '') === parsed.data.planHash
      && String(priorReplacement.replacementPreparationJobId || '')) {
      const replacement = await this.repository.getJob(String(priorReplacement.replacementPreparationJobId), 'AUTO');
      return {
        job: replacement,
        supersededJob: job,
        requestId: parsed.data.requestId,
        recoveryMode: 'REPLAN_WITH_CURRENT_PRESET' as const,
        idempotent: true
      };
    }
    const frozen = asJsonRecord(job.payload?.fanoutPlan);
    if (!Object.keys(frozen).length) {
      if (job.taskKind !== 'SHARED_PREPARATION' || job.rowVersion !== parsed.data.rowVersion) {
        throw new AppError('VERSION_CONFLICT', 'OZON PRE_PLAN 任务身份或行版本已变化', { id }, 409);
      }
      const prePlan = await this.buildPrePlanRecoveryEvidence(job);
      if (prePlan.planHash !== parsed.data.planHash
        || deterministicPreparationRequestId(id, prePlan.planHash) !== parsed.data.requestId) {
        throw new AppError('VERSION_CONFLICT', 'OZON PRE_PLAN 重检证据已变化，请重新 dry-run', { id }, 409);
      }
      if (!prePlan.capability.canRecheck || prePlan.capability.recoveryMode !== 'RECHECK') {
        const code = String(prePlan.capability.blockedReason || '').startsWith('REMOTE_OFFER_PRESENT')
          ? 'OZON_REMOTE_STATE_PRESENT'
          : 'OZON_REMOTE_STATE_UNPROVEN';
        throw new AppError(code, 'PRE_PLAN 未取得全部目标店铺的确定 Offer 不存在证明，禁止 apply', {
          id,
          requestId: parsed.data.requestId,
          checks: prePlan.frozen.checks,
          blockedReason: prePlan.capability.blockedReason,
          recoveryMode: prePlan.capability.recoveryMode
        }, 409);
      }
      const checks = asJsonRecord(prePlan.frozen.checks);
      const stableMaterial = asJsonRecord(checks.stableMaterial);
      const productIdentity = asJsonRecord(checks.productIdentity);
      const media = asJsonRecord(checks.media);
      const manifest = asJsonRecord(media.manifest);
      const mediaEvidence = Array.isArray(media.evidence) ? media.evidence.map(asJsonRecord) : [];
      const stores = asJsonRecord(checks.stores);
      const storeItems = Array.isArray(stores.items) ? stores.items.map(asJsonRecord) : [];
      const expectedListingRowVersion = Number(stableMaterial.currentRowVersion);
      const expectedListingRevision = Number(stableMaterial.currentRevision);
      const expectedManifestSignature = String(manifest.signature || '');
      if (!Number.isSafeInteger(expectedListingRowVersion) || expectedListingRowVersion < 1
        || !Number.isSafeInteger(expectedListingRevision) || expectedListingRevision < 1
        || !/^sha256:[a-f0-9]{64}$/.test(expectedManifestSignature)
        || !String(productIdentity.sku || '')
        || !String(productIdentity.productName || '')
        || !Array.isArray(productIdentity.variants)
        || !mediaEvidence.length || !storeItems.length) {
        throw new AppError('VERSION_CONFLICT', 'OZON PRE_PLAN 原子恢复证据合同不完整', { id }, 409);
      }
      const currentListing = await this.repository.getListing(job.sku);
      if (matchesPreparedSharedMaterial(job, currentListing)) {
        if (!this.multistore) {
          throw new AppError('CONFIG_INVALID', 'OZON 逐店 publication 服务未初始化', { id }, 409);
        }
        const plan = await this.multistore.storeService.automaticPublicationPlan(
          currentListing.sku,
          currentListing.rowVersion,
          storeItems.map((entry) => String(entry.id || '')).filter(Boolean)
        );
        assertPrePlanFanoutTargets(plan, storeItems);
        await this.multistore.storeRepository.freezePreparationFanoutPlan(job.id, job.rowVersion, plan);
        const next = await this.repository.getJob(job.id, 'AUTO');
        void this.runWorkerNow();
        return { job: next, requestId: parsed.data.requestId };
      }
      const next = await this.repository.rearmAutomaticPrePlanRecovery({
        jobId: id,
        expectedJobRowVersion: job.rowVersion,
        sku: job.sku,
        requestId: parsed.data.requestId,
        planHash: prePlan.planHash,
        expectedListingRowVersion,
        expectedListingRevision,
        expectedProductIdentity: {
          sku: String(productIdentity.sku),
          productName: String(productIdentity.productName),
          variants: productIdentity.variants as ProductVariant[]
        },
        expectedManifestSignature,
        expectedEligibilityAt: mediaEvidence
          .map((entry) => String(entry.deliveredAt || ''))
          .filter(Boolean)
          .sort()
          .at(-1)!,
        expectedMediaDeliveries: mediaEvidence.map((entry) => ({
          sourceStageId: String(entry.sourceStageId || ''),
          submissionId: String(entry.submissionId || ''),
          ...(String(entry.variantId || '') ? { variantId: String(entry.variantId) } : {}),
          jobId: String(entry.jobId || ''),
          deliveredAt: String(entry.deliveredAt || ''),
          payloadHash: String(entry.payloadHash || ''),
          updatedAt: String(entry.updatedAt || '')
        })),
        targetStores: storeItems.map((entry) => ({
          id: String(entry.id || ''),
          rowVersion: Number(entry.rowVersion),
          configVersion: Number(entry.configVersion),
          credentialVersionId: String(entry.credentialVersionId || ''),
          presetId: String(entry.presetId || ''),
          presetRowVersion: Number(entry.presetRowVersion),
          presetDefinitionHash: String(entry.presetDefinitionHash || ''),
          presetSnapshotHash: String(entry.presetSnapshotHash || ''),
          publicationMode: String(entry.publicationMode) as 'CREATE_ONLY' | 'COMPATIBLE_UPSERT',
          warehouseId: String(entry.warehouseId || ''),
          fulfillmentMode: String(entry.fulfillmentMode) as 'FBS' | 'RFBS',
          accountCurrency: String(entry.accountCurrency) as 'RUB' | 'CNY',
          expectedOfferIds: Array.isArray(entry.expectedOfferIds)
            ? entry.expectedOfferIds.map((offerId) => String(offerId || '')).filter(Boolean)
            : []
        })),
        recoveryEvidence: prePlan.frozen
      });
      void this.runWorkerNow();
      return { job: next, requestId: parsed.data.requestId };
    }
    if (frozenFanoutRequiresCurrentPresetReplan(frozen)) {
      if (job.taskKind !== 'SHARED_PREPARATION' || job.rowVersion !== parsed.data.rowVersion) {
        throw new AppError('VERSION_CONFLICT', 'OZON 当前预设重建任务身份或行版本已变化', { id }, 409);
      }
      const replan = await this.buildFrozenFanoutReplanEvidence(job, frozen);
      if (replan.planHash !== parsed.data.planHash
        || deterministicPreparationRequestId(id, replan.planHash) !== parsed.data.requestId) {
        throw new AppError('VERSION_CONFLICT', 'OZON 当前预设重建证据已变化，请重新 dry-run', { id }, 409);
      }
      if (!replan.capability.canRecheck
        || replan.capability.recoveryMode !== 'REPLAN_WITH_CURRENT_PRESET') {
        throw new AppError('OZON_READBACK_REQUIRED', 'OZON 当前预设重建未通过纯本地证据校验', {
          id,
          blockedReason: replan.capability.blockedReason,
          evidence: replan.frozen.evidence,
          preview: replan.frozen.preview
        }, 409);
      }
      const applied = await this.repository.replaceAutomaticPreparationWithCurrentPreset({
        jobId: id,
        expectedJobRowVersion: job.rowVersion,
        requestId: parsed.data.requestId,
        planHash: replan.planHash,
        expectedEvidenceHash: String(asJsonRecord(replan.frozen.evidence).evidenceHash || ''),
        expectedFanoutPlanHash: String(frozen.planHash || ''),
        expectedListingRowVersion: Number(replan.frozen.currentListingRowVersion),
        expectedListingRevision: Number(replan.frozen.currentListingRevision),
        expectedGeneratedVersionId: String(replan.frozen.currentGeneratedVersionId || ''),
        expectedMaterialHash: String(replan.frozen.currentMaterialHash || ''),
        expectedDataSignature: String(replan.frozen.currentDataSignature || ''),
        expectedCurrentPlanHash: String(replan.frozen.currentPlanHash || ''),
        expectedPlanContractHash: String(replan.frozen.currentPlanContractHash || ''),
        expectedSettingsRowVersion: Number(replan.frozen.settingsRowVersion),
        expectedRootDirectoryHash: String(replan.frozen.rootDirectoryHash || ''),
        expectedVariantColorAuthorityHash: String(replan.frozen.variantColorAuthorityHash || ''),
        targetStores: replan.targets
      });
      void this.runWorkerNow();
      return {
        ...applied,
        requestId: parsed.data.requestId,
        recoveryMode: 'REPLAN_WITH_CURRENT_PRESET' as const
      };
    }
    if (job.taskKind !== 'SHARED_PREPARATION'
      || job.rowVersion !== parsed.data.rowVersion
      || String(frozen.planHash || '') !== parsed.data.planHash
      || deterministicPreparationRequestId(id, parsed.data.planHash) !== parsed.data.requestId) {
      throw new AppError('VERSION_CONFLICT', 'OZON 共享准备重检与冻结计划不一致', { id }, 409);
    }
    if (job.payload?.networkRecovery
      || job.payload?.platformWriteAttempted === true
      || job.importTaskId
      || job.ozonProductId
      || ['PROCESSING', 'SUCCESS'].includes(String(job.directoryStage || '').toUpperCase())) {
      throw new AppError('OZON_READBACK_REQUIRED', '共享准备任务已有远程证据，禁止重放', { id }, 409);
    }
    if (isErroneousEmptyFanoutMediaFinalization(job)) {
      await this.repository.repairErroneousEmptyFanoutMediaBatch({
        jobId: job.id,
        expectedJobRowVersion: job.rowVersion,
        planHash: parsed.data.planHash
      });
    }
    const next = await this.repository.recheck(id, 'AUTO', job.rowVersion);
    void this.runWorkerNow();
    return { job: next, requestId: parsed.data.requestId };
  }

  private async buildFrozenFanoutReplanEvidence(
    job: OzonPublishJob,
    originalFrozenPlan: JsonRecord
  ): Promise<{
    planHash: string;
    frozen: JsonRecord;
    targets: OzonAutomaticPreparationReplanTarget[];
    capability: OzonPreparationRecoveryCapability;
  }> {
    const blockers: string[] = [];
    const evidence = await this.repository.getAutomaticPreparationReplanEvidence(job.id);
    blockers.push(...evidence.blockers);
    if (!this.multistore) blockers.push('MULTISTORE_SERVICE_UNAVAILABLE');
    const originalStoreIds = frozenFanoutStoreIds(originalFrozenPlan);
    if (!originalStoreIds.length) blockers.push('FROZEN_FANOUT_STORE_SET_MISSING');
    if (evidence.storeIds.length
      && stableJson([...evidence.storeIds].sort()) !== stableJson([...originalStoreIds].sort())) {
      blockers.push('LOCAL_VALIDATION_STORE_SET_DRIFT');
    }

    const listing = await this.repository.getListing(job.sku);
    const currentDataSignature = sharedMaterialDataSignature(listing);
    if (!listing.generatedVersionId || !listing.materialHash || !currentDataSignature) {
      blockers.push('CURRENT_SHARED_MATERIAL_CONTRACT_INCOMPLETE');
    }
    let freshPlan: JsonRecord = {};
    let targetStoresPassedAdmission = false;
    if (this.multistore && originalStoreIds.length) {
      const deliveredAt = automaticDeliveryIdentities(job).map((delivery) => delivery.deliveredAt).sort().at(-1);
      try {
        if (!deliveredAt) {
          blockers.push('CURRENT_PRESET_TARGET_DELIVERY_TIME_MISSING');
        } else {
          const targetIds = new Set(originalStoreIds);
          const eligibleTargets = (await this.multistore.storeRepository.listEligibleAutoStores(deliveredAt))
            .filter((store) => targetIds.has(store.id));
          if (eligibleTargets.length !== originalStoreIds.length
            || stableJson(eligibleTargets.map((store) => store.id).sort()) !== stableJson([...originalStoreIds].sort())) {
            blockers.push('CURRENT_PRESET_TARGET_STORE_NOT_ELIGIBLE');
          } else {
            const dictionaryVerified = await this.filterStoresByExactNoBrandDictionary(eligibleTargets, 'REPLAN');
            if (dictionaryVerified.length !== originalStoreIds.length
              || stableJson(dictionaryVerified.map((store) => store.id).sort()) !== stableJson([...originalStoreIds].sort())) {
              blockers.push('CURRENT_PRESET_NO_BRAND_DICTIONARY_UNPROVEN');
            } else {
              targetStoresPassedAdmission = true;
            }
          }
        }
      } catch (error) {
        blockers.push(`CURRENT_PRESET_STORE_ADMISSION_FAILED:${error instanceof AppError ? error.code : 'UNKNOWN'}`);
      }
    }
    if (this.multistore && originalStoreIds.length && targetStoresPassedAdmission) {
      try {
        freshPlan = asJsonRecord(await this.multistore.storeService.automaticPublicationPlan(
          listing.sku,
          listing.rowVersion,
          originalStoreIds,
          { prepareSharedSource: false, readOnly: true }
        ));
      } catch (error) {
        blockers.push(`CURRENT_PRESET_PLAN_FAILED:${error instanceof AppError ? error.code : 'UNKNOWN'}`);
      }
    }

    const planItems = Array.isArray(freshPlan.items) ? freshPlan.items.map(asJsonRecord) : [];
    const planStores = Array.isArray(freshPlan.stores) ? freshPlan.stores.map(asJsonRecord) : [];
    if (planItems.length !== originalStoreIds.length || planStores.length !== originalStoreIds.length) {
      blockers.push('CURRENT_PRESET_PLAN_STORE_SET_INCOMPLETE');
    }
    for (const item of planItems) {
      if (item.ready !== true) {
        const itemBlockers = Array.isArray(item.blockers) ? item.blockers.map(String).filter(Boolean) : [];
        blockers.push(`CURRENT_PRESET_STORE_NOT_READY:${String(item.storeAlias || item.storeId || 'unknown')}:${itemBlockers.join('|')}`);
      }
      const offerIds = Array.isArray(item.offerIds) ? item.offerIds.map(String).filter(Boolean) : [];
      if (!offerIds.length || new Set(offerIds).size !== offerIds.length) {
        blockers.push(`CURRENT_PRESET_OFFER_SET_INVALID:${String(item.storeAlias || item.storeId || 'unknown')}`);
      }
    }

    const categoryKeys = [...new Set(planStores.map((storeEntry) => {
      const storeSnapshot = asJsonRecord(storeEntry.storeSnapshot);
      return String(asJsonRecord(storeSnapshot.presetSnapshot).categoryKey || '');
    }).filter(Boolean))];
    const publishedCategories = new Map(await Promise.all(categoryKeys.map(async (categoryKey) => {
      const category = await this.repository.getCategory(categoryKey).catch(() => undefined);
      return [categoryKey, category?.publishedVersion] as const;
    })));
    const coverageByStore = planStores.map((storeEntry) => {
      const storeId = String(storeEntry.storeId || '');
      const storeSnapshot = asJsonRecord(storeEntry.storeSnapshot);
      const preset = asJsonRecord(storeSnapshot.presetSnapshot);
      const categoryKey = String(preset.categoryKey || '');
      const categoryVersion = publishedCategories.get(categoryKey);
      const product = asJsonRecord(storeEntry.productSnapshot);
      const offers = Array.isArray(product.offers) ? product.offers.map(asJsonRecord) : [];
      const sharedKeys = new Set((Array.isArray(product.sharedAttributes) ? product.sharedAttributes : [])
        .map(asJsonRecord)
        .map((attribute) => `${Number(attribute.attributeId)}:${Number(attribute.complexId)}`));
      const offerKeys = offers.map((offer) => new Set((Array.isArray(offer.attributes) ? offer.attributes : [])
        .map(asJsonRecord)
        .map((attribute) => `${Number(attribute.attributeId)}:${Number(attribute.complexId)}`)));
      let attributes: Array<Record<string, unknown>> = [];
      if (categoryVersion) {
        try {
          attributes = projectOzonPresetRequiredAttributeCoverage(categoryVersion.snapshot, preset as any).map((attribute) => {
            const materialized = sharedKeys.has(attribute.attributeKey)
              || (offerKeys.length > 0 && offerKeys.every((keys) => keys.has(attribute.attributeKey)));
            if (!materialized) {
              blockers.push(`REQUIRED_ATTRIBUTE_NOT_MATERIALIZED:${storeId}:${attribute.attributeId}:${attribute.complexId}`);
            }
            return { ...attribute, materialized };
          });
        } catch {
          blockers.push(`REQUIRED_ATTRIBUTE_COVERAGE_INVALID:${storeId}`);
        }
      } else {
        blockers.push(`PUBLISHED_CATEGORY_SNAPSHOT_MISSING:${storeId}:${categoryKey || 'missing'}`);
      }
      return {
        storeId,
        storeAlias: String(storeSnapshot.storeAlias || ''),
        categoryKey,
        publishedCategoryVersionId: categoryVersion?.id || '',
        complete: Boolean(categoryVersion)
          && attributes.every((attribute) => attribute.covered === true && attribute.materialized === true),
        attributes
      };
    });
    if (coverageByStore.some((coverage) => !coverage.complete)) blockers.push('REQUIRED_ATTRIBUTE_COVERAGE_INCOMPLETE');

    const targets: OzonAutomaticPreparationReplanTarget[] = planItems.flatMap((item) => {
      const storeEntry = planStores.find((entry) => String(entry.storeId || '') === String(item.storeId || ''));
      const storeSnapshot = asJsonRecord(storeEntry?.storeSnapshot);
      const presetSnapshot = asJsonRecord(storeSnapshot.presetSnapshot);
      const coverage = coverageByStore.find((entry) => entry.storeId === String(item.storeId || ''));
      const modeEvidence = asJsonRecord(storeEntry?.modeEvidence);
      const target = {
        id: String(item.storeId || ''),
        rowVersion: Number(item.storeRowVersion),
        configVersion: Number(item.storeConfigVersion),
        credentialVersionId: String(item.credentialVersionId || ''),
        presetId: String(item.presetId || ''),
        presetRowVersion: Number(item.presetRowVersion),
        presetDefinitionHash: String(item.presetDefinitionHash || ''),
        presetSnapshotHash: Object.keys(presetSnapshot).length
          ? `sha256:${createHash('sha256').update(stableJson(presetSnapshot)).digest('hex')}`
          : '',
        publicationMode: String(item.publicationMode || '') as OzonAutomaticPreparationReplanTarget['publicationMode'],
        warehouseId: String(item.warehouseId || ''),
        fulfillmentMode: String(item.fulfillmentMode || '') as OzonAutomaticPreparationReplanTarget['fulfillmentMode'],
        accountCurrency: String(item.accountCurrency || '') as OzonAutomaticPreparationReplanTarget['accountCurrency'],
        expectedOfferIds: Array.isArray(item.offerIds) ? item.offerIds.map(String).filter(Boolean) : [],
        categoryKey: String(coverage?.categoryKey || ''),
        expectedPublishedCategoryVersionId: String(coverage?.publishedCategoryVersionId || ''),
        expectedProductSnapshotHash: String(storeEntry?.productSnapshotHash || ''),
        expectedProductContractHash: replacementIdentityNeutralHash(storeEntry?.productSnapshot),
        expectedModeEvidenceHash: String(modeEvidence.evidenceHash || '')
      };
      return target.id ? [target] : [];
    }).sort((left, right) => left.id.localeCompare(right.id));
    if (targets.length !== originalStoreIds.length) blockers.push('CURRENT_PRESET_TARGET_CONTRACT_INCOMPLETE');

    const offerPreview = planStores.flatMap((storeEntry) => {
      const product = asJsonRecord(storeEntry.productSnapshot);
      return (Array.isArray(product.offers) ? product.offers : []).map(asJsonRecord).map((offer) => ({
        storeId: String(storeEntry.storeId || ''),
        offerId: String(offer.offerId || ''),
        stock: Number(offer.stock),
        attributeKeys: [
          ...(Array.isArray(product.sharedAttributes) ? product.sharedAttributes : []),
          ...(Array.isArray(offer.attributes) ? offer.attributes : [])
        ].map(asJsonRecord).map((attribute) => `${Number(attribute.attributeId)}:${Number(attribute.complexId)}`)
          .filter((value, index, values) => values.indexOf(value) === index)
      }));
    });
    if (!offerPreview.length || offerPreview.some((offer) => !offer.offerId || !Number.isInteger(offer.stock) || offer.stock < 0)) {
      blockers.push('CURRENT_PRESET_OFFER_PREVIEW_INVALID');
    }
    let planContract = {
      hash: '',
      settingsRowVersion: 0,
      rootDirectoryHash: '',
      variantColorAuthorityHash: ''
    };
    try {
      planContract = currentPresetReplanPlanContract(freshPlan, targets);
    } catch (error) {
      blockers.push(`CURRENT_PRESET_PLAN_CONTRACT_INVALID:${error instanceof AppError ? error.code : 'UNKNOWN'}`);
    }
    const currentPlanHash = String(freshPlan.planHash || '');
    if (!/^sha256:[a-f0-9]{64}$/.test(currentPlanHash)) blockers.push('CURRENT_PRESET_PLAN_HASH_INVALID');
    const canonical = {
      schemaVersion: 1,
      recoveryMode: 'REPLAN_WITH_CURRENT_PRESET',
      originalJobId: job.id,
      originalJobRowVersion: job.rowVersion,
      originalFanoutPlanHash: String(originalFrozenPlan.planHash || ''),
      evidenceHash: evidence.evidenceHash,
      listing: {
        sku: listing.sku,
        rowVersion: listing.rowVersion,
        revision: listing.revision,
        generatedVersionId: listing.generatedVersionId || '',
        materialHash: listing.materialHash || '',
        dataSignature: currentDataSignature
      },
      currentPlanHash,
      currentPlanContractHash: planContract.hash,
      settingsRowVersion: planContract.settingsRowVersion,
      rootDirectoryHash: planContract.rootDirectoryHash,
      variantColorAuthorityHash: planContract.variantColorAuthorityHash,
      targets,
      requiredAttributeCoverage: coverageByStore,
      offerPreview,
      blockers: [...new Set(blockers)].sort()
    };
    const planHash = `sha256:${createHash('sha256').update(stableJson(canonical)).digest('hex')}`;
    const uniqueBlockers = [...new Set(blockers)];
    return {
      planHash,
      targets,
      frozen: {
        ...canonical,
        checkedAt: new Date().toISOString(),
        currentListingRowVersion: listing.rowVersion,
        currentListingRevision: listing.revision,
        currentGeneratedVersionId: listing.generatedVersionId || '',
        currentMaterialHash: listing.materialHash || '',
        currentDataSignature,
        evidence,
        preview: {
          storeCount: planStores.length,
          offerCount: offerPreview.length,
          offers: offerPreview,
          requiredAttributeCoverage: coverageByStore
        }
      },
      capability: {
        canRecheck: uniqueBlockers.length === 0,
        canManualTakeover: false,
        recoveryMode: 'REPLAN_WITH_CURRENT_PRESET',
        ...(uniqueBlockers.length ? { blockedReason: uniqueBlockers.join(',') } : {})
      }
    };
  }

  private async buildPrePlanRecoveryEvidence(
    job: OzonPublishJob,
    options: { proveRemote?: boolean } = {}
  ): Promise<{
    planHash: string;
    frozen: JsonRecord;
    capability: OzonPreparationRecoveryCapability;
  }> {
    const checkedAt = new Date().toISOString();
    const blockers: string[] = [];
    if (job.taskKind !== 'SHARED_PREPARATION') blockers.push('TASK_KIND_NOT_SHARED_PREPARATION');
    if (!['NEEDS_ATTENTION', 'FAILED'].includes(job.state)) blockers.push('JOB_STATE_NOT_RECOVERABLE');
    const imitationFailureOnly = job.lastErrorCode === 'CONFIG_INVALID'
      && /IMITATION_CLAIM/.test(String(job.lastErrorMessage || ''));
    const authorizedExpiredProofRefresh = validExpiredPrePlanRecoveryRefresh(job);
    if (!imitationFailureOnly && !authorizedExpiredProofRefresh) blockers.push('PRE_PLAN_GENERIC_RECOVERY_NOT_ALLOWED');
    const database = await this.repository.getAutomaticPreparationRecoveryEvidence(job.id);
    const noPlatformEvidence = database.publicationCount === 0
      && database.mappingCount === 0
      && database.gatewayRequestCount === 0
      && database.productLinkCount === 0
      && !database.importIntentPresent
      && !database.platformWriteAttempted
      && !database.activeLease
      && !database.activeSlot
      && !database.activeStatusRefresh
      && !job.payload?.networkRecovery
      && !job.directorySignature
      && !prePlanPayloadHasWriteCheckpoint(job.payload)
      && !job.importTaskId
      && !job.ozonProductId
      && !['PROCESSING', 'SUCCESS'].includes(String(job.directoryStage || '').toUpperCase());
    if (!noPlatformEvidence) blockers.push('LOCAL_OR_PLATFORM_EVIDENCE_PRESENT');

    const identity = await this.purchases.getProductIdentityBySku(job.sku);
    if (!identity) blockers.push('PRODUCT_IDENTITY_MISSING');
    const listing = await this.repository.getListing(job.sku).catch((error) => isMissingListing(error) ? undefined : Promise.reject(error));
    if (!listing) blockers.push('SHARED_DRAFT_MISSING');
    if (listing && (listing.managementSource !== 'AUTO' || listing.sku !== job.sku)) {
      blockers.push('SHARED_DRAFT_IDENTITY_DRIFT');
    }
    const deliveryIdentities = automaticDeliveryIdentities(job);
    const deliveryEvidence = deliveryIdentities.length
      ? await this.repository.resolveAutomaticMediaDeliveryEvidence({ sku: job.sku, identities: deliveryIdentities })
      : [];
    const mediaOwnershipValid = deliveryIdentities.length > 0
      && deliveryEvidence.length === deliveryIdentities.length
      && deliveryEvidence.every((delivery) => delivery.jobId === job.id);
    if (!mediaOwnershipValid) blockers.push('MEDIA_LEDGER_OWNERSHIP_DRIFT');

    let manifest: JsonRecord = { valid: false, signature: '', issues: ['无法读取媒体清单'] };
    if (identity) {
      const variants = selectOzonListingProductVariants(identity.variants);
      const manifestPath = String(job.payload?.mediaManifestPath || '').trim()
        || path.join((await this.repository.getSettings()).rootDirectory, 'inbox', job.sku, 'variants', 'variant-media-manifest.json');
      try {
        const inspected = await inspectOzonMediaManifest(
          manifestPath,
          identity.sku,
          identity.productName,
          variants,
          variants.map((variant) => variant.variantId)
        );
        const expectedSignature = String(job.payload?.mediaSignature || '').replace(/^sha256:/, '');
        const signatureMatches = Boolean(inspected.signature) && (!expectedSignature || expectedSignature === inspected.signature);
        manifest = {
          path: manifestPath,
          signature: inspected.signature ? `sha256:${inspected.signature}` : '',
          expectedSignature: expectedSignature ? `sha256:${expectedSignature}` : '',
          signatureMatches,
          issueCount: inspected.issues.length,
          issues: inspected.issues,
          variantCount: inspected.variants.length,
          valid: signatureMatches && inspected.issues.length === 0
        };
        if (manifest.valid !== true) blockers.push('MEDIA_MANIFEST_DRIFT');
      } catch (error) {
        manifest = { valid: false, error: error instanceof Error ? error.message : String(error) };
        blockers.push('MEDIA_MANIFEST_INVALID');
      }
    }

    const policyFields = listing ? [
      { field: 'titleRu', kind: 'TITLE' as const, value: String(listing.data.titleRu || '') },
      { field: 'descriptionRu', kind: 'DESCRIPTION' as const, value: String(listing.data.descriptionRu || '') },
      ...listing.data.offers.map((offer, index) => ({
        field: `offers[${index}].descriptionRu`,
        kind: 'DESCRIPTION' as const,
        value: String(offer.descriptionRu || '')
      }))
    ].filter((entry) => entry.value.trim()) : [];
    const evaluatePolicy = (version: typeof OZON_CONTENT_POLICY_V2 | typeof OZON_CONTENT_POLICY_VERSION) => policyFields.map((entry) => {
      const result = entry.kind === 'TITLE'
        ? validateOzonTitle(entry.value, version)
        : validateOzonDescription(entry.value, version);
      return { field: entry.field, valid: result.valid, issues: result.issues };
    });
    const v2 = evaluatePolicy(OZON_CONTENT_POLICY_V2);
    const v3 = evaluatePolicy(OZON_CONTENT_POLICY_VERSION);
    const v2Issues = v2.flatMap((entry) => entry.issues);
    const contentPolicyValid = v2Issues.length > 0
      && v2Issues.every((issue) => issue === 'IMITATION_CLAIM')
      && v3.every((entry) => entry.valid);
    if (!contentPolicyValid) blockers.push('CONTENT_POLICY_RECOVERY_NOT_PROVEN');

    const deliveredAt = [...deliveryEvidence].map((entry) => entry.deliveredAt).sort().at(-1);
    const eligibleStores = deliveredAt && this.multistore
      ? await this.multistore.storeRepository.listEligibleAutoStores(deliveredAt)
      : [];
    const storeItems = eligibleStores.map((store) => {
      let storeOfferIds: string[] = [];
      try {
        if (!listing || !store.presetSnapshot) throw new Error('missing listing or preset');
        storeOfferIds = deriveOzonStorePresetOfferIds(listing, store.presetSnapshot);
        if (!storeOfferIds.length) throw new Error('empty Offer identity set');
      } catch {
        blockers.push(`EXPECTED_OFFER_IDENTITIES_INVALID:${store.storeAlias}`);
      }
      return {
        id: store.id,
        storeAlias: store.storeAlias,
        rowVersion: store.rowVersion,
        configVersion: store.configVersion,
        credentialVersionId: store.credential?.activeVersionId || null,
        credentialBindingMode: store.credential?.bindingMode || null,
        presetId: store.defaultPresetId,
        presetRowVersion: store.presetRowVersion,
        presetDefinitionHash: store.presetSnapshot
          ? `sha256:${createHash('sha256').update(stableJson(stablePresetMaterial(store.presetSnapshot))).digest('hex')}`
          : null,
        presetSnapshotHash: store.presetSnapshot
          ? `sha256:${createHash('sha256').update(stableJson(store.presetSnapshot)).digest('hex')}`
          : null,
        publicationMode: store.autoPublishMode,
        warehouseId: store.warehouseId,
        fulfillmentMode: store.fulfillmentMode,
        accountCurrency: store.accountCurrency,
        expectedOfferIds: storeOfferIds
      };
    }).sort((left, right) => left.id.localeCompare(right.id));
    const expectedOfferIds = [...new Set(storeItems.flatMap((store) => store.expectedOfferIds))].sort();
    const storesReady = storeItems.length > 0 && eligibleStores.every((store) => Boolean(
      store.readiness.ready
      && store.defaultPresetId
      && Number.isSafeInteger(store.configVersion)
      && store.configVersion > 0
      && store.credential?.bindingMode === 'VAULT'
      && store.credential.activeVersionId
      && store.presetSnapshot
      && store.presetRowVersion
    ));
    if (!storesReady) blockers.push('AUTO_STORES_NOT_READY');

    const localEvidenceHash = prePlanLocalEvidenceHash({
      job,
      database,
      identity,
      listing,
      deliveryEvidence,
      manifest,
      storeItems,
      expectedOfferIds
    });

    const remoteEvidence: JsonRecord[] = [];
    if (!blockers.length && options.proveRemote !== false) {
      if (!this.multistore?.storeGateway) {
        for (const store of storeItems) {
          remoteEvidence.push({
            status: 'UNPROVEN',
            storeId: store.id,
            storeAlias: store.storeAlias,
            storeConfigVersion: store.configVersion,
            credentialVersionId: store.credentialVersionId,
            offerIds: store.expectedOfferIds,
            errorCode: 'OZON_REMOTE_ABSENCE_GATEWAY_UNAVAILABLE'
          });
        }
      } else {
        const proofResults = await Promise.all(storeItems.map(async (store): Promise<JsonRecord> => {
          try {
            const proof = await this.multistore!.storeGateway!.proveStoreOfferAbsence({
              storeId: store.id,
              expectedStoreConfigVersion: store.configVersion,
              expectedCredentialVersionId: String(store.credentialVersionId || ''),
              offerIds: store.expectedOfferIds
            });
            return { ...proof, storeAlias: store.storeAlias };
          } catch (error) {
            const appError = error instanceof AppError
              ? error
              : new AppError('OZON_REMOTE_STATE_UNPROVEN', error instanceof Error ? error.message : '逐店 Offer 回读失败', undefined, 409);
            const details = asJsonRecord(appError.details);
            return {
              status: appError.code === 'OZON_REMOTE_STATE_PRESENT'
                ? 'PRESENT'
                : String(details.outcome || '').toUpperCase() === 'UNKNOWN' ? 'UNKNOWN' : 'UNPROVEN',
              storeId: store.id,
              storeAlias: store.storeAlias,
              storeConfigVersion: store.configVersion,
              credentialVersionId: store.credentialVersionId,
              offerIds: store.expectedOfferIds,
              errorCode: appError.code,
              errorMessage: appError.message,
              ...(details.outcome ? { outcome: details.outcome } : {}),
              ...(details.statusCode ? { statusCode: details.statusCode } : {})
            };
          }
        }));
        remoteEvidence.push(...proofResults);
      }
    }

    const allStoresConfirmedAbsent = !blockers.length
      && remoteEvidence.length === storeItems.length
      && remoteEvidence.every((evidence) => {
        const store = storeItems.find((item) => item.id === evidence.storeId);
        return Boolean(store && validPrePlanAbsenceProof(evidence, store, checkedAt));
      });
    if (allStoresConfirmedAbsent) {
      try {
        const currentLocalEvidenceHash = await this.currentPrePlanLocalEvidenceHash(job, deliveryIdentities, deliveredAt!);
        if (currentLocalEvidenceHash !== localEvidenceHash) blockers.push('LOCAL_EVIDENCE_DRIFT_DURING_REMOTE_READBACK');
      } catch {
        blockers.push('LOCAL_EVIDENCE_DRIFT_DURING_REMOTE_READBACK');
      }
    }

    const remoteStatus = blockers.length
      ? (remoteEvidence.length ? 'INVALIDATED' : 'NOT_CHECKED')
      : remoteEvidence.some((entry) => entry.status === 'PRESENT')
        ? 'PRESENT'
        : remoteEvidence.some((entry) => entry.status === 'UNKNOWN')
          ? 'UNKNOWN'
          : allStoresConfirmedAbsent
            ? 'CONFIRMED_ABSENT'
            : 'UNPROVEN';

    const checks = {
      checkedAt,
      job: {
        id: job.id,
        sku: job.sku,
        rowVersion: job.rowVersion,
        taskKind: job.taskKind,
        state: job.state,
        lastErrorCode: job.lastErrorCode || null,
        lastErrorMessage: job.lastErrorMessage || null,
        imitationFailureOnly,
        authorizedExpiredProofRefresh
      },
      productIdentity: identity ? structuredClone(identity) : null,
      database,
      noPlatformEvidence,
      media: {
        ownershipValid: mediaOwnershipValid,
        identities: deliveryIdentities,
        evidence: deliveryEvidence,
        manifest
      },
      contentPolicy: {
        from: OZON_CONTENT_POLICY_V2,
        to: OZON_CONTENT_POLICY_VERSION,
        v2,
        v3,
        valid: contentPolicyValid
      },
      stableMaterial: {
        currentRevision: listing?.revision,
        currentRowVersion: listing?.rowVersion,
        generatedVersionId: listing?.generatedVersionId || null,
        nextRealRevision: listing ? listing.revision + 1 : 1,
        data: listing?.data || null,
        expectedOfferIds
      },
      stores: {
        ready: storesReady,
        count: storeItems.length,
        items: storeItems
      },
      remoteOfferAbsence: {
        status: remoteStatus,
        requiredPerStore: true,
        expectedOfferIds,
        evidence: remoteEvidence
      },
      localEvidenceHash,
      localBlockers: blockers
    };
    const canonical = {
      schemaVersion: 2,
      recoveryMode: 'PRE_PLAN',
      jobId: job.id,
      sku: job.sku,
      rowVersion: job.rowVersion,
      checks: prePlanChecksForHash(checks)
    };
    const planHash = `sha256:${createHash('sha256').update(stableJson(canonical)).digest('hex')}`;
    const canRecheck = blockers.length === 0 && remoteStatus === 'CONFIRMED_ABSENT';
    const remoteBlockedStores = remoteEvidence
      .filter((entry) => entry.status !== 'CONFIRMED_ABSENT')
      .map((entry) => String(entry.storeAlias || entry.storeId || 'unknown'));
    const blockedReason = blockers.length
      ? `PRE_PLAN_LOCAL_EVIDENCE_FAILED:${blockers.join(',')}`
      : remoteStatus === 'PRESENT'
        ? `REMOTE_OFFER_PRESENT:${remoteBlockedStores.join(',')}`
        : remoteStatus === 'UNKNOWN'
          ? `REMOTE_OFFER_ABSENCE_UNKNOWN:${remoteBlockedStores.join(',')}`
          : remoteEvidence.some((entry) => entry.errorCode === 'OZON_REMOTE_ABSENCE_GATEWAY_UNAVAILABLE')
            ? 'REMOTE_OFFER_ABSENCE_GATEWAY_UNAVAILABLE'
            : canRecheck ? undefined : `REMOTE_OFFER_ABSENCE_UNPROVEN:${remoteBlockedStores.join(',')}`;
    return {
      planHash,
      frozen: { ...canonical, checkedAt, checks },
      capability: {
        canRecheck,
        canManualTakeover: ['NEEDS_ATTENTION', 'FAILED', 'CANCELLED'].includes(job.state),
        recoveryMode: canRecheck ? 'RECHECK' : 'READBACK_REQUIRED',
        ...(blockedReason ? { blockedReason } : {})
      }
    };
  }

  private async currentPrePlanLocalEvidenceHash(
    originalJob: OzonPublishJob,
    deliveryIdentities: OzonAutomaticDeliveryIdentity[],
    deliveredAt: string
  ): Promise<string> {
    const [job, database, identity, listing, deliveryEvidence, eligibleStores] = await Promise.all([
      this.repository.getJob(originalJob.id, 'AUTO'),
      this.repository.getAutomaticPreparationRecoveryEvidence(originalJob.id),
      this.purchases.getProductIdentityBySku(originalJob.sku),
      this.repository.getListing(originalJob.sku),
      this.repository.resolveAutomaticMediaDeliveryEvidence({ sku: originalJob.sku, identities: deliveryIdentities }),
      this.multistore?.storeRepository.listEligibleAutoStores(deliveredAt) || Promise.resolve([])
    ]);
    if (!identity) throw new AppError('VERSION_CONFLICT', 'OZON PRE_PLAN 产品身份已消失', { sku: originalJob.sku }, 409);
    const variants = selectOzonListingProductVariants(identity.variants);
    const manifestPath = String(job.payload?.mediaManifestPath || '').trim()
      || path.join((await this.repository.getSettings()).rootDirectory, 'inbox', job.sku, 'variants', 'variant-media-manifest.json');
    const inspected = await inspectOzonMediaManifest(
      manifestPath,
      identity.sku,
      identity.productName,
      variants,
      variants.map((variant) => variant.variantId)
    );
    const expectedSignature = String(job.payload?.mediaSignature || '').replace(/^sha256:/, '');
    const manifest = {
      path: manifestPath,
      signature: inspected.signature ? `sha256:${inspected.signature}` : '',
      expectedSignature: expectedSignature ? `sha256:${expectedSignature}` : '',
      signatureMatches: Boolean(inspected.signature) && (!expectedSignature || expectedSignature === inspected.signature),
      issueCount: inspected.issues.length,
      issues: inspected.issues,
      variantCount: inspected.variants.length,
      valid: Boolean(inspected.signature) && (!expectedSignature || expectedSignature === inspected.signature)
        && inspected.issues.length === 0
    };
    const storeItems = eligibleStores.map((store) => ({
      id: store.id,
      storeAlias: store.storeAlias,
      rowVersion: store.rowVersion,
      configVersion: store.configVersion,
      credentialVersionId: store.credential?.activeVersionId || null,
      credentialBindingMode: store.credential?.bindingMode || null,
      presetId: store.defaultPresetId,
      presetRowVersion: store.presetRowVersion,
      presetDefinitionHash: store.presetSnapshot
        ? `sha256:${createHash('sha256').update(stableJson(stablePresetMaterial(store.presetSnapshot))).digest('hex')}`
        : null,
      presetSnapshotHash: store.presetSnapshot
        ? `sha256:${createHash('sha256').update(stableJson(store.presetSnapshot)).digest('hex')}`
        : null,
      publicationMode: store.autoPublishMode,
      warehouseId: store.warehouseId,
      fulfillmentMode: store.fulfillmentMode,
      accountCurrency: store.accountCurrency,
      expectedOfferIds: deriveOzonStorePresetOfferIds(listing, store.presetSnapshot)
    })).sort((left, right) => left.id.localeCompare(right.id));
    const expectedOfferIds = [...new Set(storeItems.flatMap((store) => store.expectedOfferIds))].sort();
    return prePlanLocalEvidenceHash({
      job,
      database,
      identity,
      listing,
      deliveryEvidence,
      manifest,
      storeItems,
      expectedOfferIds
    });
  }

  async runWorkerNow(): Promise<void> {
    if (this.workerPromise) return this.workerPromise;
    const operation = this.workerOnce();
    this.workerPromise = operation;
    try { await operation; }
    finally { if (this.workerPromise === operation) this.workerPromise = undefined; }
  }

  async reconcileNow(): Promise<void> {
    if (this.reconciliationPromise) return this.reconciliationPromise;
    const operation = this.reconcileOnce();
    this.reconciliationPromise = operation;
    try { await operation; }
    finally { if (this.reconciliationPromise === operation) this.reconciliationPromise = undefined; }
  }

  private async reconcileOnce(): Promise<void> {
    try {
      const durableDeliveries = await this.repository.listDeferredAutomaticMediaDeliveries();
      const deliveryByKey = new Map<string, DeliveryNotification>();
      const durableKeys = new Set<string>();
      for (const delivery of durableDeliveries) {
        const payload = delivery.payload;
        const deliveredAt = String(payload.deliveredAt || payload.autoPublishDeferredAt || '').trim();
        if (!delivery.sku || !delivery.submissionId || !deliveredAt) continue;
        const selectedRelativePaths = Array.isArray(payload.selectedRelativePaths)
          ? payload.selectedRelativePaths.map((value) => String(value || '').trim()).filter(Boolean)
          : [];
        const notification: DeliveryNotification = {
          sku: delivery.sku,
          stageId: delivery.sourceStageId,
          submissionId: delivery.submissionId,
          ...(delivery.variantId ? { variantId: delivery.variantId } : {}),
          deliveredAt,
          ...(String(payload.resolvedOutputRoot || '').trim()
            ? { resolvedOutputRoot: String(payload.resolvedOutputRoot).trim() }
            : {}),
          ...(selectedRelativePaths.length ? { selectedRelativePaths } : {})
        };
        const key = mediaReconciliationKey(notification);
        durableKeys.add(key);
        deliveryByKey.set(key, notification);
      }
      const historyDeliveries = (this.options.historyReplay ? this.store.section('submissionHistory') : this.store.read().submissionHistory)
        .filter((record) => record.status === 'SUCCESS' && record.deliveryType === 'OZON_MEDIA' && Boolean(record.productSku)
          && (record.sourceStageId === 'E004' || record.sourceStageId === 'E005'))
        .sort((left, right) => Date.parse(left.completedAt || left.startedAt) - Date.parse(right.completedAt || right.startedAt));
      const historyNotification = (record: (typeof historyDeliveries)[number]): DeliveryNotification => ({
        sku: record.productSku!, stageId: record.sourceStageId as 'E004' | 'E005', submissionId: record.submissionId, variantId: record.variantId, deliveredAt: record.completedAt || record.startedAt, resolvedOutputRoot: record.resolvedOutputRoot, selectedRelativePaths: record.selectedRelativePaths
      });
      for (const record of this.options.historyReplay ? [] : historyDeliveries) {
        const notification: DeliveryNotification = {
          sku: record.productSku!,
          stageId: record.sourceStageId as 'E004' | 'E005',
          submissionId: record.submissionId,
          ...(record.variantId ? { variantId: record.variantId } : {}),
          deliveredAt: record.completedAt || record.startedAt,
          ...(record.resolvedOutputRoot ? { resolvedOutputRoot: record.resolvedOutputRoot } : {}),
          ...(record.selectedRelativePaths ? { selectedRelativePaths: record.selectedRelativePaths } : {})
        };
        const key = mediaReconciliationKey(notification);
        if (!deliveryByKey.has(key)) deliveryByKey.set(key, notification);
      }
      let shouldKickWorker = false;
      for (const [key, notification] of deliveryByKey) {
        // A durable row may be legitimately rebound or moved back to ACCEPTED/
        // DEFERRED by a repository CAS after this process cached an older
        // terminal decision. Durable database state is authoritative and must
        // always invalidate the in-memory history cache for the same identity.
        if (this.reconciledDeliveries.has(key) && !durableKeys.has(key)) continue;
        const result = await this.handleMediaDelivered(notification, false);
        if (result?.becameRunnable) shouldKickWorker = true;
        // A delivery attached to a mutable round must be reconsidered after that
        // round freezes or finishes. Cache only terminal no-job decisions.
        if (!result?.deferred && !result?.job) this.reconciledDeliveries.add(key);
      }
      if (this.options.historyReplay) {
        const epoch = stableHash(await this.repository.getSettings());
        await this.options.historyReplay.run('OZON', historyDeliveries, epoch, async (record) => {
          const notification = historyNotification(record);
          const key = mediaReconciliationKey(notification);
          if (durableKeys.has(key)) return false;
          const result = await this.handleMediaDelivered(notification, false);
          if (result?.becameRunnable) shouldKickWorker = true;
          return !result?.deferred && !result?.job;
        });
      }
      if (shouldKickWorker) void this.runWorkerNow();
      this.lastReconciledAt = new Date().toISOString();
    } catch (error) {
      this.logger.warn({ err: error }, 'OZON 自动上品补偿检查失败');
    }
  }

  private async workerOnce(): Promise<void> {
    if (this.stopped || !this.repository.configured) return;
    const settings = await this.repository.getSettings();
    if (!settings.enabled || (!settings.credentialReady && !this.multistore)) return;
    const candidates = await this.repository.listRunnableAutomaticJobs(
      settings.credentialReady ? this.concurrency : Math.min(20, this.concurrency * 5)
    );
    const preparationCandidates = candidates.filter((job) => job.payload?.mode !== 'MULTISTORE_PUBLICATION');
    const jobs = settings.credentialReady
      ? preparationCandidates.slice(0, this.concurrency)
      : preparationCandidates.filter((job) => job.payload?.multistorePreparation === true).slice(0, this.concurrency);
    await Promise.all(jobs.map(async (job) => {
      if (this.runningJobs.has(job.id)) return;
      this.runningJobs.add(job.id);
      try { await this.processJob(job); }
      catch (error) { await this.handleJobError(job.id, error); }
      finally { this.runningJobs.delete(job.id); }
    }));
  }

  private async processJob(jobInput: OzonPublishJob): Promise<void> {
    const job = await this.repository.getJob(jobInput.id);
    if (!['WAITING_MEDIA', 'READY'].includes(job.state)) return;
    const settings = await this.repository.getSettings();
    if (!settings.enabled) return;
    const multistorePreparation = job.payload?.multistorePreparation === true;
    const targetedRecoveryContract = readTargetedRecoveryContract(job);
    if (targetedRecoveryContract) {
      throw new StopAutoJob('OZON_LEGACY_TASK_READ_ONLY', '定向恢复任务属于全局默认预设时期的冻结历史，禁止继续写入');
    }
    if (!multistorePreparation) {
      throw new StopAutoJob('OZON_LEGACY_TASK_READ_ONLY', '全局默认预设时期的自动准备任务已冻结，只允许从原快照继续平台回读');
    }
    const identity = await this.purchases.getProductIdentityBySku(job.sku);
    if (!identity) throw new StopAutoJob('PRODUCT_NOT_FOUND', 'PostgreSQL 中不存在该 SKU 的产品身份');
    assertPrePlanWorkerProductIdentity(job, identity);
    const listing = await this.repository.getListing(identity.sku).catch((error) => isMissingListing(error) ? undefined : Promise.reject(error));
    const activeManualJobs = await this.repository.listManualJobsForSku(identity.sku, {
      page: 1,
      pageSize: 1,
      activeOnly: true
    });
    if (activeManualJobs.total > 0) {
      throw new StopAutoJob('OZON_MANUAL_DRAFT_PRESENT', 'SKU 存在活动中的手动 OZON 上品任务，自动流程已停止');
    }
    await this.prepareAndFanOutSharedMaterial(job, identity, listing, settings);
    return;
  }

  private async dispatchPreparedListing(
    job: OzonPublishJob,
    listing: OzonListingDraft,
    dispatchMetadata: JsonRecord,
    settings: Awaited<ReturnType<OzonRepository['getSettings']>>
  ): Promise<void> {
    if (job.payload?.multistorePreparation !== true || !this.multistore) {
      await this.publishing.dispatchAutomaticJob(job, listing.sku, listing.rowVersion, dispatchMetadata, settings);
      return;
    }

    const materialDeliveries = frozenPublicationDeliveryIdentities(job, listing);
    const deliveryEvidence = await this.repository.resolveAutomaticMediaDeliveryEvidence({
      sku: listing.sku,
      identities: materialDeliveries
    });
    assertPrePlanWorkerMediaEvidence(job, deliveryEvidence);
    const evidenceByKey = new Map(deliveryEvidence.map((delivery) => [automaticDeliveryIdentityKey(delivery), delivery]));
    const triggeringKeys = new Set(automaticDeliveryIdentities(job).map(automaticDeliveryIdentityKey));
    for (const key of triggeringKeys) {
      const evidence = evidenceByKey.get(key);
      if (!evidence || evidence.jobId !== job.id) {
        throw new StopAutoJob(
          'OZON_MEDIA_DELIVERY_IDENTITY_DRIFT',
          '准备任务的媒体投递账本归属已变化'
        );
      }
    }
    const deliveries = materialDeliveries.map((delivery) => ({
      ...delivery,
      deliveredAt: evidenceByKey.get(automaticDeliveryIdentityKey(delivery))!.deliveredAt
    }));
    if (!deliveries.length) {
      throw new StopAutoJob('OZON_MEDIA_DELIVERY_IDENTITY_MISSING', '多店铺共享准备任务缺少冻结媒体投递身份');
    }

    const publicationIds = new Set<string>();
    const storeIds = new Set<string>();
    const failures: Array<Record<string, unknown>> = [];
    const completionDelivery = [...deliveries].sort((left, right) => left.deliveredAt.localeCompare(right.deliveredAt)).at(-1)!;
    const existingFanoutPlan = asJsonRecord(job.payload?.fanoutPlan);
    let eligibleStoreIds = frozenFanoutStoreIds(existingFanoutPlan);
    if (!eligibleStoreIds.length) {
      const prePlanTargets = prePlanRecoveryTargets(job);
      const currentPresetReplanTargets = replanRecoveryTargets(job);
      if (prePlanTargets.length) {
        eligibleStoreIds = prePlanTargets.map((store) => String(store.id || '')).filter(Boolean);
        const currentEligible = await this.filterStoresByExactNoBrandDictionary(
          await this.multistore.storeRepository.listEligibleAutoStores(completionDelivery.deliveredAt),
          'FREEZE'
        );
        assertPrePlanCurrentStores(currentEligible, prePlanTargets);
      } else if (currentPresetReplanTargets.length) {
        eligibleStoreIds = currentPresetReplanTargets.map((store) => String(store.id || '')).filter(Boolean);
        const targetIds = new Set(eligibleStoreIds);
        const currentEligible = await this.filterStoresByExactNoBrandDictionary(
          await this.multistore.storeRepository.listEligibleAutoStores(completionDelivery.deliveredAt),
          'FREEZE'
        );
        assertPrePlanCurrentStores(
          currentEligible.filter((store) => targetIds.has(store.id)),
          currentPresetReplanTargets
        );
      } else {
        const eligibleStores = await this.filterStoresByExactNoBrandDictionary(
          await this.multistore.storeRepository.listEligibleAutoStores(completionDelivery.deliveredAt),
          'FREEZE'
        );
        eligibleStoreIds = eligibleStores.map((store) => store.id);
      }
      if (eligibleStoreIds.length) {
        const plan = await this.multistore.storeService.automaticPublicationPlan(
          listing.sku,
          listing.rowVersion,
          eligibleStoreIds
        );
        const frozenRecoveryTargets = prePlanTargets.length ? prePlanTargets : currentPresetReplanTargets;
        if (frozenRecoveryTargets.length) assertPrePlanFanoutTargets(plan, frozenRecoveryTargets);
        if (currentPresetReplanTargets.length) {
          await assertCurrentPresetReplanCategoryVersions(this.repository, currentPresetReplanTargets);
          assertCurrentPresetReplanPlanContract(job, plan, currentPresetReplanTargets);
        }
        const frozen = await this.multistore.storeRepository.freezePreparationFanoutPlan(job.id, job.rowVersion, plan);
        eligibleStoreIds = frozenFanoutStoreIds(frozen);
      }
    }
    eligibleStoreIds.forEach((storeId) => storeIds.add(storeId));
    if (!eligibleStoreIds.length) {
      failures.push({
        code: 'OZON_NO_ELIGIBLE_AUTO_STORE',
        message: '公共素材准备完成时没有仍处于启用且预检有效状态的 OZON 店铺',
        deliveryIdentities: deliveries
      });
    } else {
      try {
        // The full image/video set is one shared material revision. Materialize
        // each eligible store exactly once, then close every contributing media
        // ledger identity against the same immutable publication set.
        const frozenPlan = Object.keys(existingFanoutPlan).length
          ? existingFanoutPlan
          : asJsonRecord((await this.repository.getJob(job.id, 'AUTO')).payload?.fanoutPlan);
        const result = await this.multistore.storeService.createAutomaticPublicationsFromFrozenPlan(
          frozenPlan,
          completionDelivery,
          job.id
        );
        result.publications.forEach((publication) => publicationIds.add(publication.id));
        failures.push(...result.failures.map((failure) => ({
          ...failure,
          deliveryIdentities: deliveries
        })));
        const completePublicationSet = result.failures.length === 0
          && result.failed === 0
          && result.accepted === eligibleStoreIds.length
          && result.publications.length === eligibleStoreIds.length
          && new Set(result.publications.map((publication) => publication.id)).size === eligibleStoreIds.length;
        if (completePublicationSet) {
          await this.multistore.storeRepository.finalizeMediaFanoutBatch({
            jobId: job.id,
            sku: listing.sku,
            deliveries: deliveries.map((delivery) => ({
              sourceStageId: delivery.sourceStageId,
              submissionId: delivery.submissionId,
              ...(delivery.variantId ? { variantId: delivery.variantId } : {})
            })),
            publicationIds: result.publications.map((publication) => publication.id),
            storeIds: eligibleStoreIds
          });
        }
      } catch (error) {
        failures.push({
          code: error instanceof AppError ? error.code : 'OZON_AUTOMATIC_FANOUT_FAILED',
          message: error instanceof Error ? error.message : 'OZON 自动多店铺 fan-out 失败',
          deliveryIdentities: deliveries
        });
      }
    }

    await this.multistore.storeRepository.completeFanoutPreparation(job.id, {
      publicationIds: [...publicationIds],
      storeIds: [...storeIds],
      ...(failures.length ? { failures } : {})
    });
  }

  private async prepareAndFanOutSharedMaterial(
    inputJob: OzonPublishJob,
    identity: NonNullable<Awaited<ReturnType<PurchaseRepository['getProductIdentityBySku']>>>,
    currentListing: OzonListingDraft | undefined,
    settings: Awaited<ReturnType<OzonRepository['getSettings']>>
  ): Promise<void> {
    let job = inputJob;
    let listing = currentListing;
    if (listing && matchesPreparedSharedMaterial(job, listing)) {
      await this.dispatchPreparedListing(job, listing, {}, settings);
      return;
    }
    if (listing?.managementSource === 'MANUAL') {
      throw new StopAutoJob('OZON_MANUAL_DRAFT_PRESENT', 'SKU 已有人工维护的 OZON 公共素材，自动流程不会覆盖');
    }
    const allPublicationVariants = selectOzonListingProductVariants(identity.variants);
    if (!allPublicationVariants.length) {
      throw new StopAutoJob('PRODUCT_VARIANTS_MISSING', 'PostgreSQL 产品身份缺少可用于 OZON 的稳定产品变体');
    }
    const scope = resolveOzonVariantPublicationScope(allPublicationVariants, listing);
    const publicationVariants = scope.publicationVariants;
    const requiredVariantIds = scope.mode === 'NO_OP'
      ? allPublicationVariants.map((variant) => variant.variantId)
      : scope.requiredVariantIds;
    const manifestPath = path.join(settings.rootDirectory, 'inbox', job.sku, 'variants', 'variant-media-manifest.json');
    const first = await inspectOzonMediaManifest(
      manifestPath,
      identity.sku,
      identity.productName,
      publicationVariants,
      requiredVariantIds
    );
    if (this.stableProbeMs) await delay(this.stableProbeMs);
    const second = await inspectOzonMediaManifest(
      manifestPath,
      identity.sku,
      identity.productName,
      publicationVariants,
      requiredVariantIds
    );
    assertPrePlanWorkerManifest(job, second.signature);
    if (first.signature && first.signature !== second.signature) {
      await this.waitForMedia(job, '媒体目录在稳定性检查期间发生变化', second);
      return;
    }
    if (second.issues.length) {
      await this.waitForMedia(job, second.issues.join('；'), second);
      return;
    }
    job = await this.repository.transitionJob(job.id, {
      rowVersion: job.rowVersion,
      state: 'READY',
      eventType: 'AUTO_SHARED_MATERIAL_PRECHECK_PASSED',
      message: '公共图片、视频与稳定产品变体身份校验通过',
      jobPayload: { mediaManifestPath: manifestPath, mediaSignature: second.signature },
      stageStates: { images: 'LOCAL_READY', video: 'LOCAL_READY' },
      errorCode: undefined,
      errorMessage: undefined,
      nextAttemptAt: null
    });
    const selectedVariants = matchProductVariants(publicationVariants, second.variants);
    const descriptions = await this.descriptions.resolveVariants(identity.sku, identity.productName, selectedVariants);
    const descriptionRu = requireDescription(descriptions);
    const descriptionsByVariant = new Map(descriptions.variantSources
      .filter((entry) => entry.content)
      .map((entry) => [entry.productVariantId, entry]));
    const freshMediaAssets = uniqueManifestAssets(second.variants.flatMap((variant) => [...variant.images, ...variant.videos]));
    const mediaAssets = [...new Map([
      ...(listing?.data.mediaAssets || []),
      ...freshMediaAssets
    ].map((asset) => [asset.assetId, asset])).values()];
    const identities = buildOzonVariantIdentities(
      allPublicationVariants.map((variant) => variant.variantId),
      listing?.data.offers || [],
      identity.sku
    );
    const mediaByVariantId = new Map(second.variants.map((variant) => [variant.variantId, variant]));
    const existingByProductVariantId = new Map((listing?.data.offers || []).map((offer) => [
      String(offer.productVariantId || offer.variantId),
      offer
    ]));
    const offers: OzonListingDraft['data']['offers'] = allPublicationVariants.map((variant) => {
      const stableIdentity = identities.get(variant.variantId)!;
      const mediaVariant = mediaByVariantId.get(variant.variantId);
      const existing = existingByProductVariantId.get(variant.variantId);
      if (!mediaVariant && !existing) {
        throw new StopAutoJob('OZON_SHARED_MATERIAL_VARIANT_MISSING', `产品变体 ${variant.variantId} 缺少可共享媒体与稳定身份`);
      }
      const variantDescription = descriptionsByVariant.get(variant.variantId);
      return {
        variantId: variant.variantId,
        productVariantId: variant.variantId,
        productVariantName: variant.name,
        ...(variant.wbColor?.colorKey && variant.wbColor.nameRu && variant.wbColor.nameZh
          ? { productVariantColor: variant.wbColor }
          : {}),
        variantCode: stableIdentity.variantCode,
        offerId: stableIdentity.offerId,
        barcode: '',
        modelGroup: identity.sku,
        // The persisted compatibility envelope requires numeric values. These
        // placeholders are not exposed by the public-material API and are
        // replaced by every store's frozen preset before publication.
        price: 1,
        oldPrice: 1,
        minPrice: 0,
        stock: 0,
        descriptionRu: variantDescription?.content || existing?.descriptionRu || descriptionRu,
        ...(variantDescription?.source ? {
          descriptionSource: {
            type: 'E003' as const,
            workflowCode: 'E003' as const,
            executionId: variantDescription.source.executionId,
            fileName: variantDescription.source.fileName,
            sha256: variantDescription.source.sha256,
            productVariantId: variant.variantId
          }
        } : existing?.descriptionSource ? { descriptionSource: existing.descriptionSource } : {}),
        descriptionWarnings: [],
        attributes: [],
        media: mediaVariant
          ? [...mediaVariant.images, ...mediaVariant.videos].map((asset, sortOrder) => ({
              assetId: manifestAssetId(asset),
              relativePath: asset.relativePath.replaceAll('\\', '/'),
              kind: asset.kind,
              sortOrder,
              isPrimary: asset.kind === 'image' && sortOrder === 0
            }))
          : existing!.media.map((reference, sortOrder) => ({
              ...reference,
              sortOrder,
              isPrimary: reference.kind === 'image'
                && existing!.media.findIndex((candidate) => candidate.kind === 'image') === sortOrder
            }))
      };
    });
    const sharedData: Omit<OzonListingDraft['data'], never> = {
      fulfillmentMode: 'FBS',
      warehouseId: '',
      currency: 'CNY',
      vat: '0.2',
      titleRu: '',
      descriptionRu,
      ...(descriptions.source ? {
        descriptionSource: {
          type: 'E003',
          workflowCode: 'E003',
          executionId: descriptions.source.executionId,
          fileName: descriptions.source.fileName,
          sha256: descriptions.source.sha256,
          ...(descriptions.source.productVariantId ? { productVariantId: descriptions.source.productVariantId } : {})
        }
      } : {}),
      descriptionWarnings: [],
      brand: '',
      sharedAttributes: [],
      offers,
      mediaAssets,
      mediaSourceRoot: second.productRoot,
      videoUploadMode: 'COMPRESSED_COPY'
    };
    const currentManifestDeliveries = automaticDeliveryIdentitiesFromAssets(freshMediaAssets);
    let currentManifestEvidence: Awaited<ReturnType<OzonRepository['resolveAutomaticMediaDeliveryEvidence']>>;
    try {
      currentManifestEvidence = await this.repository.resolveAutomaticMediaDeliveryEvidence({
        sku: identity.sku,
        identities: currentManifestDeliveries
      });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'OZON_MEDIA_DELIVERY_IDENTITY_DRIFT') throw error;
      await this.waitForMedia(job, '公共媒体投递账本正在收口，等待同一准备任务重新绑定后继续', second);
      return;
    }
    if (currentManifestEvidence.length !== currentManifestDeliveries.length
      || currentManifestEvidence.some((delivery) => delivery.jobId !== job.id || delivery.decision !== 'ACCEPTED')) {
      // A manifest can become complete while its E004/E005 notification races
      // with the active preparation lease. Never freeze or fan out those files
      // until every current-manifest delivery is owned by this preparation job.
      await this.waitForMedia(job, '公共媒体投递账本正在收口，等待同一准备任务重新绑定后继续', second);
      return;
    }
    let commitMediaSignature = second.signature;
    if (Object.keys(prePlanRecovery(job)).length) {
      const commitInspection = await inspectOzonMediaManifest(
        manifestPath,
        identity.sku,
        identity.productName,
        publicationVariants,
        requiredVariantIds
      );
      assertPrePlanWorkerManifest(job, commitInspection.signature);
      if (commitInspection.issues.length || commitInspection.signature !== second.signature) {
        throw new StopAutoJob(
          'OZON_PRE_PLAN_MEDIA_MANIFEST_DRIFT',
          'PRE_PLAN 媒体文件在稳定版本提交前发生变化'
        );
      }
      commitMediaSignature = commitInspection.signature;
    }
    const persisted = await this.repository.persistAutomaticSharedMaterialRevision({
      jobId: job.id,
      jobRowVersion: job.rowVersion,
      sku: identity.sku,
      productName: identity.productName,
      ...(listing ? { expectedListingRowVersion: listing.rowVersion } : {}),
      data: sharedData,
      mediaSignature: `sha256:${commitMediaSignature}`,
      offerIds: offers.map((offer) => offer.offerId)
    });
    listing = persisted.listing;
    job = persisted.job;
    await this.dispatchPreparedListing(job, listing, {}, settings);
  }




  private async waitForMedia(job: OzonPublishJob, message: string, inspection: OzonMediaInspection): Promise<void> {
    await this.repository.transitionJob(job.id, {
      rowVersion: job.rowVersion,
      state: 'WAITING_MEDIA',
      eventType: 'MEDIA_INCOMPLETE',
      message,
      payload: { issues: inspection.issues },
      jobPayload: { mediaSignature: inspection.signature, mediaIssues: inspection.issues },
      stageStates: { images: inspection.variants.length ? 'PARTIAL' : 'WAITING_LOCAL', video: 'WAITING_LOCAL' },
      errorCode: 'MEDIA_INCOMPLETE',
      errorMessage: message,
      nextAttemptAt: null
    });
  }

  private async handleJobError(jobId: string, error: unknown): Promise<void> {
    this.logger.warn({ err: error, jobId }, 'OZON 自动上品任务推进失败');
    const job = await this.repository.getJob(jobId).catch(() => undefined);
    if (!job || ['SUCCEEDED', 'CANCELLED'].includes(job.state)) return;
    const message = error instanceof Error ? error.message : 'OZON 自动上品任务执行失败';
    const code = error instanceof StopAutoJob ? error.code : error instanceof AppError ? error.code : 'OZON_AUTO_PUBLISH_FAILED';
    if (error instanceof AppError && error.code === 'OZON_MANAGEMENT_DISABLED') return;
    if (error instanceof AppError
      && error.code === 'TASK_LOCKED'
      && error.details?.id === jobId
      && !error.details?.reasonCode) {
      // Another worker already advanced this job. Its newer row owns the next step;
      // the stale worker must not overwrite that progress with NEEDS_ATTENTION.
      return;
    }
    const networkError = normalizeOzonNetworkError(error);
    if (networkError) {
      const networkRecovery = nextOzonNetworkRecovery(job, {
        phase: 'AUTO_COORDINATOR',
        resumeState: 'READY',
        error,
        checkpoint: { jobId: job.id, sku: job.sku, source: job.source, state: job.state }
      });
      await this.repository.transitionJob(job.id, {
        rowVersion: job.rowVersion,
        state: 'READY',
        eventType: 'NETWORK_RETRY_SCHEDULED',
        message: '自动上品依赖暂时不可达；已保留原任务，网络恢复后将继续执行',
        errorCode: networkRecovery.errorCode,
        errorMessage: networkRecovery.errorMessage,
        nextAttemptAt: networkRecovery.nextAttemptAt,
        incrementRetry: true,
        networkRecovery
      });
      return;
    }
    if (error instanceof StopAutoJob || (error instanceof AppError && [
      'CONFIG_INVALID', 'NOT_FOUND', 'TASK_LOCKED', 'VERSION_CONFLICT',
      'OZON_MEDIA_DELIVERY_IDENTITY_DRIFT', 'OZON_PRE_PLAN_MEDIA_LEDGER_DRIFT',
      'OZON_PRE_PLAN_MEDIA_MANIFEST_DRIFT'
    ].includes(error.code))) {
      const ownershipInvalidated = error instanceof AppError && error.code === 'TASK_LOCKED';
      await this.repository.transitionJob(job.id, {
        rowVersion: job.rowVersion,
        state: 'NEEDS_ATTENTION',
        eventType: 'AUTOMATION_STOPPED',
        message,
        ...(error instanceof AppError && error.details ? { payload: { errorDetails: error.details } } : {}),
        errorCode: code,
        errorMessage: message,
        ...(ownershipInvalidated ? {
          jobPayload: {
            autoPreparedOwnershipInvalidatedAt: new Date().toISOString(),
            autoPreparedOwnershipInvalidatedReason: String(error.details?.reasonCode || 'TASK_LOCKED')
          }
        } : {}),
        nextAttemptAt: null
      });
      return;
    }
    const delayMs = RETRY_DELAYS_MS[job.retryCount];
    if (delayMs !== undefined) {
      await this.repository.transitionJob(job.id, {
        rowVersion: job.rowVersion,
        state: 'READY',
        eventType: 'RETRY_SCHEDULED',
        message,
        payload: { retryDelayMs: delayMs, retryCount: job.retryCount + 1 },
        errorCode: code,
        errorMessage: message,
        nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
        incrementRetry: true
      });
      return;
    }
    await this.repository.transitionJob(job.id, {
      rowVersion: job.rowVersion,
      state: 'NEEDS_ATTENTION',
      eventType: 'AUTOMATION_FAILED',
      message,
      errorCode: code,
      errorMessage: message,
      nextAttemptAt: null,
      incrementRetry: true
    });
  }
}

function isErroneousEmptyFanoutMediaFinalization(job: OzonPublishJob): boolean {
  const fanout = asJsonRecord(job.payload?.multistoreFanout);
  const failures = Array.isArray(fanout.failures) ? fanout.failures.map(asJsonRecord) : [];
  return job.taskKind === 'SHARED_PREPARATION'
    && job.state === 'NEEDS_ATTENTION'
    && !job.publicationId
    && Array.isArray(fanout.publicationIds)
    && fanout.publicationIds.length === 0
    && failures.length > 0
    && failures.every((failure) => (
      failure.code === 'OZON_PUBLICATION_CREATE_FAILED'
      && failure.message === 'INSERT has more expressions than target columns'
    ));
}

export async function inspectOzonMediaManifest(
  manifestPath: string,
  sku: string,
  productName: string,
  productVariants: ProductVariant[],
  requiredVariantIds?: string[]
): Promise<OzonMediaInspection> {
  let raw: JsonRecord;
  try { raw = JSON.parse(await readFile(manifestPath, 'utf8')) as JsonRecord; }
  catch (error: any) {
    if (error?.code === 'ENOENT') return { productRoot: path.dirname(path.dirname(manifestPath)), signature: '', issues: ['媒体清单尚未生成'], variants: [] };
    throw new StopAutoJob('MEDIA_MANIFEST_INVALID', 'OZON 媒体清单无法解析');
  }
  if (Number(raw.schemaVersion) !== 2 || String(raw.SKU || '') !== sku || String(raw.productName || '') !== productName || !Array.isArray(raw.assets)) {
    throw new StopAutoJob('MEDIA_MANIFEST_INVALID', '自动上品只接受与 PostgreSQL 产品身份一致的 schemaVersion 2 媒体清单');
  }
  const productRoot = path.dirname(path.dirname(manifestPath));
  const productRootReal = await realpath(productRoot).catch(() => '');
  if (!productRootReal) return { productRoot, signature: '', issues: ['OZON 商品媒体目录不存在'], variants: [] };
  const knownVariants = new Map(productVariants.map((variant) => [variant.variantId, variant]));
  const assets = raw.assets.map(parseManifestAsset);
  const issues: string[] = [];
  const unknownVariantIds = [...new Set(assets.map((asset) => asset.variantId).filter((variantId) => !knownVariants.has(variantId)))];
  for (const variantId of unknownVariantIds) {
    const asset = assets.find((candidate) => candidate.variantId === variantId);
    issues.push(`${asset?.variantName || variantId}：媒体清单中的 productVariantId 不属于当前产品可发布变体`);
  }
  const normalizedRequiredVariantIds = requiredVariantIds === undefined
    ? undefined
    : [...new Set(requiredVariantIds.map((variantId) => String(variantId || '').trim()).filter(Boolean))];
  if (normalizedRequiredVariantIds?.some((variantId) => !knownVariants.has(variantId))) {
    throw new StopAutoJob('MEDIA_VARIANT_MISMATCH', 'OZON 媒体检查包含不属于当前产品的必需变体');
  }
  const actualKnownVariantIds = [...new Set(assets
    .filter((asset) => knownVariants.has(asset.variantId))
    .map((asset) => asset.variantId))];
  if (normalizedRequiredVariantIds) {
    const required = new Set(normalizedRequiredVariantIds);
    const extraVariantIds = actualKnownVariantIds.filter((variantId) => !required.has(variantId));
    if (extraVariantIds.length) {
      issues.push(`媒体清单包含本轮提交作用域外的变体：${extraVariantIds.join(', ')}；请拆分到下一轮处理`);
    }
  }
  const variantIds = normalizedRequiredVariantIds ?? [...new Set(
    assets
      .filter((asset) => asset.sourceStageId === 'E005' && asset.kind === 'image' && knownVariants.has(asset.variantId))
      .map((asset) => asset.variantId)
  )];
  const variants: OzonMediaVariant[] = [];
  const snapshots: JsonRecord[] = [];
  for (const variantId of variantIds) {
    const known = knownVariants.get(variantId);
    const candidates = assets.filter((asset) => asset.variantId === variantId);
    const variantName = known?.name || candidates[0]?.variantName || variantId;
    const images = orderedOzonLatestImages(
      latestBatch(candidates.filter((asset) => asset.sourceStageId === 'E005' && asset.kind === 'image')),
      variantName
    );
    const videos = latestBatch(candidates.filter((asset) => asset.sourceStageId === 'E004' && asset.kind === 'video'));
    if (images.length < 1 || images.length > 15) issues.push(`${variantName}：最新 E005 图片需要 1-15 张，当前 ${images.length} 张`);
    if (videos.length !== 1) issues.push(`${variantName}：最新 E004 批次必须恰好包含 1 个视频，当前 ${videos.length} 个`);
    variants.push({
      variantId,
      variantName,
      ...(candidates.find((asset) => asset.variantColor?.nameRu)?.variantColor?.nameRu ? { colorNameRu: candidates.find((asset) => asset.variantColor?.nameRu)!.variantColor!.nameRu } : {}),
      images,
      videos
    });
    for (const asset of [...images, ...videos]) snapshots.push(await inspectManifestFile(productRootReal, asset, issues));
  }
  if (!variantIds.length) issues.push('媒体清单没有包含任何 E005 变体图片');
  const signature = createHash('sha256').update(stableJson(snapshots)).digest('hex');
  return { productRoot: productRootReal, signature, issues, variants };
}

export function resolveOzonVariantPublicationScope(
  variants: ProductVariant[],
  listing?: OzonListingDraft
): OzonVariantPublicationScope {
  const identityPlan = createOzonCompatibleIdentityPlan({
    sku: listing?.sku || '0000000',
    productVariants: variants,
    existingOffers: listing?.data.offers || [],
    productLinks: listing?.ozonProductLinks
  });
  const publicationVariants = identityPlan.publicationVariants;
  const representedVariantIds = identityPlan.representedVariantIds;
  if (listing?.status === 'PUBLISHED') {
    const missingVariantIds = identityPlan.missingVariants.map((variant) => variant.variantId);
    return {
      mode: missingVariantIds.length ? 'APPEND_MISSING' : 'NO_OP',
      publicationVariants,
      representedVariantIds,
      requiredVariantIds: missingVariantIds
    };
  }
  return {
    mode: 'INITIAL_FULL',
    publicationVariants,
    representedVariantIds,
    requiredVariantIds: publicationVariants.map((variant) => variant.variantId)
  };
}

function readTargetedRecoveryContract(job: OzonPublishJob): JsonRecord | undefined {
  const recovery = asJsonRecord(job.payload?.recovery);
  if (String(recovery.kind || '') !== 'PREVIOUSLY_ACCEPTED_VARIANT_MEDIA') return undefined;
  const contract = asJsonRecord(recovery.contract);
  if (contract.schemaVersion !== 1) {
    throw new StopAutoJob('OZON_RECOVERY_CONTRACT_INVALID', '定向恢复任务缺少冻结的产品、Offer 与媒体合同');
  }
  return contract;
}


function asJsonRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}



function parseManifestAsset(value: unknown): ManifestAsset {
  const asset = value && typeof value === 'object' ? value as JsonRecord : {};
  const hasSortOrder = Object.hasOwn(asset, 'sortOrder');
  const parsed: ManifestAsset = {
    assetId: String(asset.assetId || ''),
    submissionId: String(asset.submissionId || ''),
    sourceStageId: String(asset.sourceStageId || '') as ManifestAsset['sourceStageId'],
    kind: String(asset.kind || '') as ManifestAsset['kind'],
    variantId: String(asset.variantId || ''),
    variantName: String(asset.variantName || ''),
    relativePath: String(asset.relativePath || ''),
    deliveredAt: String(asset.deliveredAt || ''),
    sizeBytes: Number(asset.sizeBytes || 0),
    ...(hasSortOrder ? { sortOrder: asset.sortOrder } : {}),
    ...(asset.variantColor && typeof asset.variantColor === 'object' ? { variantColor: asset.variantColor } : {}),
    ...(asset.sha256 ? { sha256: String(asset.sha256) } : {})
  };
  if (!parsed.assetId || !parsed.submissionId || !['E004', 'E005'].includes(parsed.sourceStageId)
    || !['image', 'video'].includes(parsed.kind) || !parsed.variantId || !parsed.relativePath || !Number.isFinite(parsed.sizeBytes)
    || !/^[a-f0-9]{64}$/.test(parsed.sha256 || '')) {
    throw new StopAutoJob('MEDIA_MANIFEST_INVALID', 'OZON 媒体清单包含字段不完整的资源');
  }
  return parsed;
}

export function uniqueManifestAssets(assets: ManifestAsset[]): OzonMediaAsset[] {
  const unique = new Map<string, OzonMediaAsset>();
  for (const asset of assets) {
    const assetId = manifestAssetId(asset);
    const extension = path.extname(asset.relativePath).toLocaleLowerCase('en-US');
    const variantColor = asset.variantColor;
    unique.set(assetId, {
      assetId,
      relativePath: asset.relativePath.replaceAll('\\', '/'),
      kind: asset.kind,
      ...(typeof asset.sortOrder === 'number' ? { sortOrder: asset.sortOrder } : {}),
      mimeType: asset.kind === 'video'
        ? 'video/mp4'
        : extension === '.jpg' || extension === '.jpeg'
          ? 'image/jpeg'
          : extension === '.webp'
            ? 'image/webp'
            : 'image/png',
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256!,
      modifiedAt: asset.deliveredAt,
      validationStatus: 'VALID',
      productVariantId: asset.variantId,
      productVariantName: asset.variantName,
      ...(variantColor?.colorKey && variantColor.nameRu && variantColor.nameZh
        ? { productVariantColor: { colorKey: variantColor.colorKey, nameRu: variantColor.nameRu, nameZh: variantColor.nameZh } }
        : {}),
      sourceStageId: asset.sourceStageId,
      sourceSubmissionId: asset.submissionId,
      deliveredAt: asset.deliveredAt
    });
  }
  return [...unique.values()].sort(compareManifestMediaAssets);
}

function orderedOzonLatestImages(assets: ManifestAsset[], variantName: string): ManifestAsset[] {
  const ordering = resolveManifestMediaOrder(assets);
  if (!ordering.ok) {
    throw new StopAutoJob('MEDIA_MANIFEST_INVALID', `${variantName}：${ordering.message}`);
  }
  return ordering.assets;
}

function compareManifestMediaAssets(left: OzonMediaAsset, right: OzonMediaAsset): number {
  const variant = String(left.productVariantId || left.productVariantColor?.colorKey || left.productVariantName || '')
    .localeCompare(String(right.productVariantId || right.productVariantColor?.colorKey || right.productVariantName || ''), 'en');
  if (variant) return variant;
  const kind = Number(left.kind === 'video') - Number(right.kind === 'video');
  if (kind) return kind;
  if (left.kind === 'image' && right.kind === 'image'
    && left.sortOrder !== undefined && right.sortOrder !== undefined
    && left.sortOrder !== right.sortOrder) {
    return left.sortOrder - right.sortOrder;
  }
  return left.relativePath.localeCompare(right.relativePath, 'zh-CN', { numeric: true });
}

function manifestAssetId(asset: ManifestAsset): string {
  return createHash('sha256').update(`${asset.relativePath.replaceAll('\\', '/')}\0${asset.sha256}`).digest('hex');
}

async function inspectManifestFile(productRootReal: string, asset: ManifestAsset, issues: string[]): Promise<JsonRecord> {
  const relativePath = asset.relativePath.replaceAll('\\', '/');
  if (path.isAbsolute(relativePath) || relativePath.split('/').includes('..')) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON 媒体清单包含不安全路径', { relativePath }, 409);
  }
  const candidate = path.resolve(productRootReal, ...relativePath.split('/'));
  let info;
  try {
    info = await lstat(candidate);
  } catch (error: any) {
    if (error?.code === 'ENOENT') throw new StopAutoJob('SOURCE_FILE_MISSING', `${relativePath}：文件不存在`);
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON 媒体清单指向的资源不是普通文件', { relativePath }, 409);
  }
  let candidateReal: string;
  try {
    candidateReal = await realpath(candidate);
  } catch (error: any) {
    if (error?.code === 'ENOENT') throw new StopAutoJob('SOURCE_FILE_MISSING', `${relativePath}：文件不存在`);
    throw error;
  }
  const relative = path.relative(productRootReal, candidateReal);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON 媒体文件真实路径超出商品目录', { relativePath }, 409);
  }
  const current = await stat(candidateReal);
  if (current.size !== asset.sizeBytes || current.size < 1) issues.push(`${relativePath}：文件大小与媒体清单不一致`);
  const digest = createHash('sha256').update(await readFile(candidateReal)).digest('hex');
  if (asset.sha256 && digest !== asset.sha256) issues.push(`${relativePath}：SHA-256 与媒体清单不一致`);
  return { relativePath, size: current.size, mtimeMs: current.mtimeMs, sha256: digest };
}

function latestBatch(assets: ManifestAsset[]): ManifestAsset[] {
  if (!assets.length) return [];
  const groups = new Map<string, ManifestAsset[]>();
  for (const asset of assets) groups.set(asset.submissionId, [...(groups.get(asset.submissionId) || []), asset]);
  return [...groups.entries()]
    .sort((left, right) => manifestBatchSortValue(right).localeCompare(manifestBatchSortValue(left)))[0]?.[1] || [];
}

function manifestBatchSortValue(entry: [string, ManifestAsset[]]): string {
  const deliveredAt = entry[1].map((asset) => String(asset.deliveredAt || '')).sort().at(-1) || '';
  return `${deliveredAt}\0${entry[0]}`;
}

function matchProductVariants(productVariants: ProductVariant[], mediaVariants: OzonMediaVariant[]): ProductVariant[] {
  const byId = new Map(productVariants.map((variant) => [variant.variantId, variant]));
  return mediaVariants.map((variant) => {
    const match = byId.get(variant.variantId);
    if (!match) throw new StopAutoJob('MEDIA_VARIANT_MISMATCH', `${variant.variantName} 无法按 productVariantId 匹配 PostgreSQL 产品变体`);
    return match;
  });
}

function requireDescription(result: E003VariantDescriptionsResult): string {
  if (result.status === 'MISSING' || result.status === 'AMBIGUOUS' || !result.content) {
    throw new StopAutoJob('E003_DESCRIPTION_UNAVAILABLE', result.message || '没有找到最新有效 E003 俄文详情 TXT');
  }
  return result.content;
}


export function createExpectedOzonOfferSnapshots(
  offers: OzonListingDraft['data']['offers'],
  mediaAssets: OzonListingDraft['data']['mediaAssets'],
  submittedOfferIds: string[],
  existingLinks: NonNullable<OzonListingDraft['ozonProductLinks']>
): JsonRecord[] {
  const submitted = new Set(submittedOfferIds);
  const assets = new Set(mediaAssets.map((asset) => asset.assetId));
  const links = new Map(existingLinks.map((link) => [link.offerId, link]));
  return offers.map((offer) => {
    const disposition = submitted.has(offer.offerId) ? 'SUBMITTED' : 'PRESERVED_EXISTING';
    const missingAssets = offer.media.filter((media) => !assets.has(media.assetId)).map((media) => media.assetId);
    if (missingAssets.length) {
      throw new StopAutoJob(
        'OZON_EXPECTED_OFFER_MEDIA_INVALID',
        `${offer.offerId} 的父卡媒体快照缺少资产：${missingAssets.join(', ')}`
      );
    }
    const mapping = links.get(offer.offerId);
    if (disposition === 'PRESERVED_EXISTING' && (!mapping?.ozonProductId || !mapping.ozonSku)) {
      throw new StopAutoJob(
        'OZON_COMPATIBLE_MAPPING_INCOMPLETE',
        `${offer.offerId} 缺少可保留的 OZON productId/sku 映射`
      );
    }
    return {
      offerId: offer.offerId,
      productVariantId: String(offer.productVariantId || offer.variantId),
      disposition,
      price: offer.price,
      oldPrice: offer.oldPrice,
      minPrice: offer.minPrice,
      stock: offer.stock,
      descriptionRu: offer.descriptionRu,
      media: {
        imageCount: offer.media.filter((media) => media.kind === 'image').length,
        videoCount: offer.media.filter((media) => media.kind === 'video').length
      },
      ...(mapping ? {
        mapping: {
          ozonProductId: mapping.ozonProductId,
          ozonSku: mapping.ozonSku
        }
      } : {})
    };
  });
}

export function buildSharedAttributes(
  categoryAttributes: OzonCategoryAttribute[],
  preset: OzonPreset,
  titleRu: string,
  descriptionRu: string,
  sku: string,
  typeId: number
): OzonAttributeValueInput[] {
  return normalizeOzonNoBrandForPlatform(prepareOzonManagedSharedAttributes({
    categoryAttributes,
    attributes: preset.sharedAttributes,
    sku,
    typeId,
    titleRu,
    descriptionRu,
    brandMode: 'FORCE_NO_BRAND'
  }), categoryAttributes);
}

export function buildOzonVariantIdentities(
  variantIds: string[],
  existingOffers: Array<{ variantId: string; variantCode: string; offerId: string }>,
  sku: string
): Map<string, { variantCode: string; offerId: string }> {
  const identityPlan = createOzonCompatibleIdentityPlan({
    sku,
    productVariants: variantIds.map((variantId) => ({ variantId, name: variantId })),
    existingOffers: existingOffers as OzonListingDraft['data']['offers'],
    candidateOfferVariantIds: variantIds
  });
  if (identityPlan.exhaustedVariantIds.length) {
    throw new StopAutoJob('OZON_VARIANT_LIMIT_EXCEEDED', 'OZON 每个商品最多支持 99 个两位数稳定变体编码');
  }
  return new Map(identityPlan.offerIdentities.map((identity) => [
    identity.variantId,
    { variantCode: identity.variantCode, offerId: identity.offerId }
  ]));
}

export function selectPrices(result: any, currency: string): { price: number; oldPrice: number; minPrice: number } {
  const option = result.options.find((entry: any) => entry.recommended)
    || result.options.find((entry: any) => entry.optionId === result.summary?.recommendedOptionId)
    || result.options[0];
  const ensure = (value: unknown, label: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new StopAutoJob('PRICING_RESULT_INVALID', `定价结果缺少有效的${label}`);
    return parsed;
  };
  const selectCurrency = (amount: any) => [amount?.saleCurrency, amount?.costCurrency]
    .find((entry) => String(entry?.currencyCode || '').toUpperCase() === currency.toUpperCase());
  const listing = selectCurrency(option.amounts?.listing);
  const strike = selectCurrency(option.amounts?.strike);
  const target = selectCurrency(option.amounts?.targetSale);
  if ([listing, strike, target].some((entry) => !entry)) {
    throw new StopAutoJob('PRICING_CURRENCY_MISMATCH', `定价结果未包含 OZON 店铺合同币种 ${currency}`);
  }
  const price = ensure(listing.displayValue ?? listing.value, '销售价');
  const oldPrice = ensure(strike.displayValue ?? strike.value, '划线价');
  const minPrice = ensure(target.displayValue ?? target.value, '目标售价');
  return { price, oldPrice, minPrice };
}

export function selectOzonPricingOption(result: any, shippingServiceCode: string): any {
  const normalized = String(shippingServiceCode || '').trim().toUpperCase();
  const option = result.options?.find((candidate: any) => String(candidate.shipping?.serviceCode || '').toUpperCase() === normalized);
  if (!option) throw new StopAutoJob('NO_ELIGIBLE_PRICING_OPTION', `所选 OZON 服务渠道 ${normalized || '未设置'} 没有符合固定包装参数的上架价`);
  return option;
}

export function buildOzonPricingItem(
  preset: Pick<OzonPreset, 'dimensions' | 'destinationCountryCode'>,
  sku: string,
  productName: string,
  procurement: { purchasePrice: string; courierFee?: string },
  effectiveGrossWeightGrams: number
): PricingCalculationItem {
  const dimensions = dimensionsInCm(preset.dimensions);
  return {
    sku,
    productName,
    purchaseCost: String(procurement.purchasePrice),
    domesticFreight: String(procurement.courierFee || '0'),
    actualWeightGrams: String(effectiveGrossWeightGrams),
    lengthCm: String(dimensions.length),
    widthCm: String(dimensions.width),
    heightCm: String(dimensions.height),
    ...(preset.destinationCountryCode ? { destinationCountryCode: preset.destinationCountryCode } : {})
  };
}

function dimensionsInCm(dimensions: OzonPreset['dimensions']): { length: number; width: number; height: number } {
  const multiplier = dimensions.dimensionUnit === 'mm' ? 0.1 : dimensions.dimensionUnit === 'in' ? 2.54 : 1;
  return { length: dimensions.length * multiplier, width: dimensions.width * multiplier, height: dimensions.height * multiplier };
}

export function resolvePublicationDimensions(
  procurement: { grossWeightGrams?: unknown; lengthCm?: unknown; widthCm?: unknown; heightCm?: unknown },
  fallback: OzonPreset['dimensions']
): OzonPreset['dimensions'] {
  const procurementWeight = Number(procurement.grossWeightGrams);
  const effectiveWeight = Number.isFinite(procurementWeight) && procurementWeight > 0
    ? procurementWeight
    : weightInGrams(fallback.weight, fallback.weightUnit);
  return { ...fallback, weight: effectiveWeight, weightUnit: 'g' };
}

function weightInGrams(value: number, unit: OzonPreset['dimensions']['weightUnit']): number {
  return value * (unit === 'kg' ? 1_000 : unit === 'lb' ? 453.59237 : 1);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as JsonRecord).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}

function prePlanLocalEvidenceHash(input: {
  job: OzonPublishJob;
  database: unknown;
  identity?: { sku: string; productName: string; variants: ProductVariant[] };
  listing?: OzonListingDraft;
  deliveryEvidence: unknown[];
  manifest: JsonRecord;
  storeItems: JsonRecord[];
  expectedOfferIds: string[];
}): string {
  const canonical = {
    job: {
      id: input.job.id,
      sku: input.job.sku,
      rowVersion: input.job.rowVersion,
      taskKind: input.job.taskKind,
      state: input.job.state,
      importTaskId: input.job.importTaskId || null,
      ozonProductId: input.job.ozonProductId || null,
      directoryStage: input.job.directoryStage || null,
      mediaManifestPath: input.job.payload?.mediaManifestPath || null,
      mediaSignature: input.job.payload?.mediaSignature || null
    },
    database: input.database,
    identity: input.identity ? {
      sku: input.identity.sku,
      productName: input.identity.productName,
      variants: input.identity.variants
    } : null,
    listing: input.listing ? {
      sku: input.listing.sku,
      managementSource: input.listing.managementSource,
      status: input.listing.status,
      rowVersion: input.listing.rowVersion,
      revision: input.listing.revision,
      generatedVersionId: input.listing.generatedVersionId || null,
      materialHash: input.listing.materialHash || null,
      materialHashVersion: input.listing.materialHashVersion || null,
      contentPolicyVersion: input.listing.contentPolicyVersion || null,
      data: input.listing.data
    } : null,
    deliveryEvidence: [...input.deliveryEvidence].sort((left, right) => stableJson(left).localeCompare(stableJson(right))),
    manifest: input.manifest,
    stores: [...input.storeItems].sort((left, right) => String(left.id || '').localeCompare(String(right.id || ''))),
    expectedOfferIds: [...input.expectedOfferIds]
  };
  return `sha256:${createHash('sha256').update(stableJson(canonical)).digest('hex')}`;
}

function prePlanChecksForHash(checks: JsonRecord): JsonRecord {
  const stripAuditTimestamps = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripAuditTimestamps);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value as JsonRecord)
      .filter(([key]) => key !== 'checkedAt')
      .map(([key, entry]) => [key, stripAuditTimestamps(entry)]));
  };
  return stripAuditTimestamps(checks) as JsonRecord;
}

function validPrePlanAbsenceProof(proof: JsonRecord, store: JsonRecord, invocationStartedAt: string): boolean {
  const checkedAt = Date.parse(String(proof.checkedAt || ''));
  const startedAt = Date.parse(invocationStartedAt);
  const offerIds = Array.isArray(proof.offerIds) ? proof.offerIds.map(String) : [];
  const expectedOfferIds = Array.isArray(store.expectedOfferIds) ? store.expectedOfferIds.map(String) : [];
  const operations = Array.isArray(proof.operations) ? proof.operations.map(asJsonRecord) : [];
  const semantic = {
    absent: true,
    status: 'CONFIRMED_ABSENT',
    storeId: String(proof.storeId || ''),
    storeConfigVersion: Number(proof.storeConfigVersion),
    credentialVersionId: String(proof.credentialVersionId || ''),
    offerIds,
    operations
  };
  const calculatedHash = `sha256:${createHash('sha256').update(stableJson(semantic)).digest('hex')}`;
  return proof.absent === true
    && proof.status === 'CONFIRMED_ABSENT'
    && semantic.storeId === String(store.id || '')
    && semantic.storeConfigVersion === Number(store.configVersion)
    && semantic.credentialVersionId === String(store.credentialVersionId || '')
    && stableJson(offerIds) === stableJson(expectedOfferIds)
    && Number.isFinite(checkedAt)
    && Number.isFinite(startedAt)
    && checkedAt >= startedAt - 5_000
    && checkedAt <= Date.now() + 5_000
    && validOzonPrePlanAbsenceOperations(operations)
    && calculatedHash === String(proof.evidenceHash || '');
}

function prePlanRecovery(job: OzonPublishJob): JsonRecord {
  const recovery = asJsonRecord(job.payload?.prePlanRecovery);
  return Number(recovery.schemaVersion) === 1 ? recovery : {};
}

function validExpiredPrePlanRecoveryRefresh(job: OzonPublishJob): boolean {
  const exactAuthorizedRecoveryFailure = (errorCode: unknown, errorMessage: unknown) => (
    (errorCode === 'VERSION_CONFLICT'
      && String(errorMessage || '') === 'OZON PRE_PLAN 冻结恢复证据合同无效或已过期')
    || (errorCode === 'OZON_MEDIA_DELIVERY_IDENTITY_DRIFT'
      && String(errorMessage || '') === 'OZON PRE_PLAN 媒体账本在生成稳定版本前已变化')
    || (errorCode === 'OZON_PRE_PLAN_FANOUT_TARGET_DRIFT'
      && String(errorMessage || '') === 'PRE_PLAN 恢复后的店铺、凭据、预设、发布模式或 Offer 集合已变化')
  );
  if (!exactAuthorizedRecoveryFailure(job.lastErrorCode, job.lastErrorMessage)) return false;
  const recovery = prePlanRecovery(job);
  const evidence = asJsonRecord(recovery.evidence);
  const checks = asJsonRecord(evidence.checks);
  const originalJob = asJsonRecord(checks.job);
  const stores = asJsonRecord(checks.stores);
  const media = asJsonRecord(checks.media);
  const manifest = asJsonRecord(media.manifest);
  const contentPolicy = asJsonRecord(checks.contentPolicy);
  const productIdentity = asJsonRecord(checks.productIdentity);
  const targetStores = Array.isArray(recovery.targetStores) ? recovery.targetStores.map(asJsonRecord) : [];
  const evidenceStores = Array.isArray(stores.items) ? stores.items.map(asJsonRecord) : [];
  const targetFields = (store: JsonRecord) => ({
    id: String(store.id || ''),
    rowVersion: Number(store.rowVersion),
    configVersion: Number(store.configVersion),
    credentialVersionId: String(store.credentialVersionId || ''),
    presetId: String(store.presetId || ''),
    presetRowVersion: Number(store.presetRowVersion),
    presetDefinitionHash: String(store.presetDefinitionHash || ''),
    presetSnapshotHash: String(store.presetSnapshotHash || ''),
    publicationMode: String(store.publicationMode || ''),
    warehouseId: String(store.warehouseId || ''),
    fulfillmentMode: String(store.fulfillmentMode || ''),
    accountCurrency: String(store.accountCurrency || ''),
    expectedOfferIds: Array.isArray(store.expectedOfferIds) ? store.expectedOfferIds.map(String) : []
  });
  const canonical = {
    schemaVersion: Number(evidence.schemaVersion),
    recoveryMode: String(evidence.recoveryMode || ''),
    jobId: String(evidence.jobId || ''),
    sku: String(evidence.sku || ''),
    rowVersion: Number(evidence.rowVersion),
    checks: prePlanChecksForHash(checks)
  };
  const calculatedPlanHash = `sha256:${createHash('sha256').update(stableJson(canonical)).digest('hex')}`;
  const planHash = String(recovery.planHash || '');
  const rootAuthorizationValid = (
    originalJob.lastErrorCode === 'CONFIG_INVALID'
    && originalJob.imitationFailureOnly === true
    && /IMITATION_CLAIM/.test(String(originalJob.lastErrorMessage || ''))
  ) || (
    originalJob.authorizedExpiredProofRefresh === true
    && exactAuthorizedRecoveryFailure(originalJob.lastErrorCode, originalJob.lastErrorMessage)
  );
  return Number(recovery.schemaVersion) === 1
    && canonical.schemaVersion === 2
    && canonical.recoveryMode === 'PRE_PLAN'
    && canonical.jobId === job.id
    && canonical.sku === job.sku
    && Number.isSafeInteger(canonical.rowVersion)
    && calculatedPlanHash === planHash
    && deterministicPreparationRequestId(job.id, planHash) === String(recovery.requestId || '')
    && originalJob.id === job.id
    && originalJob.sku === job.sku
    && originalJob.taskKind === 'SHARED_PREPARATION'
    && rootAuthorizationValid
    && checks.noPlatformEvidence === true
    && contentPolicy.valid === true
    && media.ownershipValid === true
    && manifest.valid === true
    && /^sha256:[a-f0-9]{64}$/.test(String(recovery.manifestSignature || ''))
    && String(manifest.signature || '') === String(recovery.manifestSignature || '')
    && productIdentity.sku === job.sku
    && stores.ready === true
    && targetStores.length > 0
    && targetStores.length === evidenceStores.length
    && stableJson(targetStores.map(targetFields).sort((left, right) => left.id.localeCompare(right.id)))
      === stableJson(evidenceStores.map(targetFields).sort((left, right) => left.id.localeCompare(right.id)))
    && stableJson(productIdentity) === stableJson(asJsonRecord(recovery.productIdentity));
}

function matchesPreparedSharedMaterial(job: OzonPublishJob, listing: OzonListingDraft): boolean {
  const prepared = asJsonRecord(job.payload?.sharedMaterialPreparation);
  return prepared.preparedByJobId === job.id
    && Number(prepared.listingRowVersion) === listing.rowVersion
    && Number(prepared.listingRevision) === listing.revision
    && String(prepared.dataSignature || '') === sharedMaterialDataSignature(listing)
    && String(job.payload?.generatedVersionId || '') === String(listing.generatedVersionId || '')
    && String(job.payload?.materialHash || '') === String(listing.materialHash || '')
    && String(job.payload?.materialHashVersion || '') === String(listing.materialHashVersion || '')
    && String(job.payload?.contentPolicyVersion || '') === String(listing.contentPolicyVersion || '');
}

function prePlanPayloadHasWriteCheckpoint(payloadInput: unknown): boolean {
  const payload = asJsonRecord(payloadInput);
  const writeKeys = [
    'importIntent', 'importTaskId', 'productJsonGenerated', 'productJsonPath',
    'packageSignature', 'directorySignature', 'platformWriteAttempted',
    'gatewayUnknown', 'gatewayRequestRef', 'priceStockWriteProgress'
  ];
  return writeKeys.some((key) => {
    const value = payload[key];
    return value !== undefined && value !== null && value !== false && value !== ''
      && (!Array.isArray(value) || value.length > 0)
      && (typeof value !== 'object' || Array.isArray(value) || Object.keys(asJsonRecord(value)).length > 0);
  });
}

function prePlanRecoveryTargets(job: OzonPublishJob): JsonRecord[] {
  const recovery = prePlanRecovery(job);
  return Array.isArray(recovery.targetStores) ? recovery.targetStores.map(asJsonRecord) : [];
}

function replanRecoveryTargets(job: OzonPublishJob): JsonRecord[] {
  const recovery = asJsonRecord(job.payload?.replanRecovery);
  if (recovery.recoveryMode !== 'REPLAN_WITH_CURRENT_PRESET') return [];
  return Array.isArray(recovery.targetStores) ? recovery.targetStores.map(asJsonRecord) : [];
}

const REPLAN_PRODUCT_TOP_LEVEL_IDENTITY_FIELDS = new Set([
  'materialHash', 'generatedVersionId', 'revision', 'rowVersion', 'materialRevision',
  'listingRevision', 'draftVersion'
]);

function replacementIdentityNeutralHash(value: unknown): string {
  const product = asJsonRecord(value);
  const normalized = Object.fromEntries(Object.entries(product)
    .filter(([key]) => !REPLAN_PRODUCT_TOP_LEVEL_IDENTITY_FIELDS.has(key)));
  return `sha256:${createHash('sha256').update(stableJson(normalized)).digest('hex')}`;
}

export function currentPresetReplanPlanContract(
  planInput: unknown,
  targetsInput: unknown[]
): {
  hash: string;
  settingsRowVersion: number;
  rootDirectoryHash: string;
  variantColorAuthorityHash: string;
} {
  const plan = asJsonRecord(planInput);
  const items = Array.isArray(plan.items) ? plan.items.map(asJsonRecord) : [];
  const stores = Array.isArray(plan.stores) ? plan.stores.map(asJsonRecord) : [];
  const targets = targetsInput.map(asJsonRecord);
  const settingsRowVersion = Number(plan.settingsRowVersion);
  const rootDirectoryHash = String(plan.rootDirectoryHash || '');
  const variantColorAuthorityHash = String(asJsonRecord(plan.variantColorAuthority).hash || '');
  const requiredHashes = [
    rootDirectoryHash,
    variantColorAuthorityHash,
    String(plan.sourceMediaIdentityHash || '')
  ];
  if (!Number.isSafeInteger(settingsRowVersion) || settingsRowVersion < 1
    || requiredHashes.some((value) => !/^sha256:[a-f0-9]{64}$/.test(value))
    || !items.length || items.length !== stores.length || items.length !== targets.length) {
    throw new AppError('VERSION_CONFLICT', 'OZON 当前预设语义计划合同不完整', undefined, 409);
  }
  const storesById = new Map(stores.map((entry) => [String(entry.storeId || ''), entry]));
  const targetsById = new Map(targets.map((entry) => [String(entry.id || ''), entry]));
  if (storesById.size !== stores.length || targetsById.size !== targets.length) {
    throw new AppError('VERSION_CONFLICT', 'OZON 当前预设语义计划店铺集合重复', undefined, 409);
  }
  const storeContracts = items.map((item) => {
    const storeId = String(item.storeId || '');
    const store = storesById.get(storeId);
    const target = targetsById.get(storeId);
    const productSnapshotHash = String(store?.productSnapshotHash || '');
    const calculatedProductSnapshotHash = store
      ? `sha256:${createHash('sha256').update(stableJson(stableMaterial(store.productSnapshot))).digest('hex')}`
      : '';
    const productContractHash = replacementIdentityNeutralHash(store?.productSnapshot);
    const modeEvidenceHash = String(asJsonRecord(store?.modeEvidence).evidenceHash || '');
    if (!store || !target
      || !/^sha256:[a-f0-9]{64}$/.test(productSnapshotHash)
      || calculatedProductSnapshotHash !== productSnapshotHash
      || !/^sha256:[a-f0-9]{64}$/.test(modeEvidenceHash)
      || !/^sha256:[a-f0-9]{64}$/.test(String(target.expectedProductSnapshotHash || ''))
      || productContractHash !== String(target.expectedProductContractHash || '')
      || modeEvidenceHash !== String(target.expectedModeEvidenceHash || '')
      || !String(target.categoryKey || '')
      || !/^[0-9a-f-]{36}$/i.test(String(target.expectedPublishedCategoryVersionId || ''))) {
      throw new AppError('VERSION_CONFLICT', 'OZON 当前预设逐店语义计划合同不完整', { storeId }, 409);
    }
    return {
      storeId,
      storeRowVersion: Number(item.storeRowVersion),
      storeConfigVersion: Number(item.storeConfigVersion),
      credentialVersionId: String(item.credentialVersionId || ''),
      presetId: String(item.presetId || ''),
      presetRowVersion: Number(item.presetRowVersion),
      presetDefinitionHash: String(item.presetDefinitionHash || ''),
      presetSnapshotHash: String(target.presetSnapshotHash || ''),
      categoryKey: String(target.categoryKey),
      publishedCategoryVersionId: String(target.expectedPublishedCategoryVersionId),
      publicationMode: String(item.publicationMode || ''),
      warehouseId: String(item.warehouseId || ''),
      fulfillmentMode: String(item.fulfillmentMode || ''),
      accountCurrency: String(item.accountCurrency || ''),
      ready: item.ready === true,
      blockers: Array.isArray(item.blockers) ? item.blockers.map(String) : [],
      errorCode: String(item.errorCode || ''),
      errorDetails: item.errorDetails ?? null,
      offerIds: Array.isArray(item.offerIds) ? item.offerIds.map(String) : [],
      productContractHash,
      modeEvidenceHash
    };
  }).sort((left, right) => left.storeId.localeCompare(right.storeId));
  const canonical = {
    schemaVersion: 1,
    sku: String(plan.sku || ''),
    contentPolicyVersion: String(plan.contentPolicyVersion || ''),
    materialHashVersion: String(plan.materialHashVersion || ''),
    sourceMediaIdentityHash: String(plan.sourceMediaIdentityHash || ''),
    settingsRowVersion,
    rootDirectoryHash,
    variantColorAuthorityHash,
    stores: storeContracts
  };
  return {
    hash: `sha256:${createHash('sha256').update(stableJson(canonical)).digest('hex')}`,
    settingsRowVersion,
    rootDirectoryHash,
    variantColorAuthorityHash
  };
}

async function assertCurrentPresetReplanCategoryVersions(
  repository: OzonRepository,
  targets: JsonRecord[]
): Promise<void> {
  const categories = await Promise.all([...new Set(targets.map((target) => String(target.categoryKey || '')))]
    .filter(Boolean)
    .map(async (categoryKey) => ({ categoryKey, category: await repository.getCategory(categoryKey) })));
  for (const target of targets) {
    const current = categories.find((entry) => entry.categoryKey === String(target.categoryKey || ''))?.category;
    if (!current?.publishedVersion
      || current.publishedVersion.id !== String(target.expectedPublishedCategoryVersionId || '')) {
      throw new StopAutoJob(
        'OZON_CURRENT_PRESET_CATEGORY_VERSION_DRIFT',
        'OZON 当前预设重建后的已发布类目版本已变化'
      );
    }
  }
}

function assertCurrentPresetReplanPlanContract(
  job: OzonPublishJob,
  plan: unknown,
  targets: JsonRecord[]
): void {
  const recovery = asJsonRecord(job.payload?.replanRecovery);
  // expectedCurrentPlanHash is retained as the dry-run audit source. The raw
  // hash cannot be equal after replacement because r2 deliberately receives a
  // new generatedVersionId/revision. The identity-neutral semantic hash below
  // is the actual worker CAS before fan-out freeze.
  const auditSourcePlanHash = String(recovery.expectedCurrentPlanHash || '');
  const expected = String(recovery.expectedPlanContractHash || '');
  let current: ReturnType<typeof currentPresetReplanPlanContract>;
  try {
    current = currentPresetReplanPlanContract(plan, targets);
  } catch {
    throw new StopAutoJob('OZON_CURRENT_PRESET_PLAN_DRIFT', 'OZON 当前预设重建后的语义计划合同无效');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(auditSourcePlanHash)
    || !/^sha256:[a-f0-9]{64}$/.test(expected)
    || current.hash !== expected
    || current.settingsRowVersion !== Number(recovery.expectedSettingsRowVersion)
    || current.rootDirectoryHash !== String(recovery.expectedRootDirectoryHash || '')
    || current.variantColorAuthorityHash !== String(recovery.expectedVariantColorAuthorityHash || '')) {
    throw new StopAutoJob(
      'OZON_CURRENT_PRESET_PLAN_DRIFT',
      'OZON 当前预设重建后的类目、定价、系统设置或属性物化已变化'
    );
  }
}

function assertPrePlanWorkerProductIdentity(
  job: OzonPublishJob,
  identity: { sku: string; productName: string; variants: ProductVariant[] }
): void {
  const recovery = prePlanRecovery(job);
  if (!Object.keys(recovery).length) return;
  const expected = asJsonRecord(recovery.productIdentity);
  if (stableJson(expected) !== stableJson(identity)) {
    throw new StopAutoJob('OZON_PRE_PLAN_PRODUCT_IDENTITY_DRIFT', 'PRE_PLAN 恢复后的稳定产品变体身份已变化');
  }
}

function assertPrePlanWorkerManifest(job: OzonPublishJob, signature: string): void {
  const recovery = prePlanRecovery(job);
  if (!Object.keys(recovery).length) return;
  const expected = String(recovery.manifestSignature || '');
  if (!/^sha256:[a-f0-9]{64}$/.test(expected) || expected !== `sha256:${signature}`) {
    throw new StopAutoJob('OZON_PRE_PLAN_MEDIA_MANIFEST_DRIFT', 'PRE_PLAN 恢复后的媒体文件签名已变化');
  }
}

function assertPrePlanWorkerMediaEvidence(job: OzonPublishJob, current: unknown[]): void {
  const recovery = prePlanRecovery(job);
  if (!Object.keys(recovery).length) return;
  const evidence = asJsonRecord(recovery.evidence);
  const checks = asJsonRecord(evidence.checks);
  const media = asJsonRecord(checks.media);
  const expected = Array.isArray(media.evidence) ? media.evidence.map(asJsonRecord) : [];
  if (!sameOzonPrePlanMediaEvidence(expected, current)) {
    throw new StopAutoJob('OZON_PRE_PLAN_MEDIA_LEDGER_DRIFT', 'PRE_PLAN 恢复后的媒体账本证据已变化');
  }
}

export function sameOzonPrePlanMediaEvidence(expected: unknown[], current: unknown[]): boolean {
  const normalizeTimestamp = (value: unknown) => {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
  };
  const canonical = (rows: unknown[]) => rows.map(asJsonRecord).map((entry) => ({
    sourceStageId: String(entry.sourceStageId || ''),
    submissionId: String(entry.submissionId || ''),
    variantId: String(entry.variantId || ''),
    deliveredAt: normalizeTimestamp(entry.deliveredAt),
    decision: String(entry.decision || ''),
    jobId: String(entry.jobId || ''),
    payloadHash: String(entry.payloadHash || ''),
    updatedAt: normalizeTimestamp(entry.updatedAt)
  })).sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  const timestampsValid = [...expected.map(asJsonRecord), ...current.map(asJsonRecord)].every((entry) => (
    Boolean(normalizeTimestamp(entry.deliveredAt)) && Boolean(normalizeTimestamp(entry.updatedAt))
  ));
  return expected.length > 0
    && timestampsValid
    && stableJson(canonical(expected)) === stableJson(canonical(current));
}

function assertPrePlanFanoutTargets(plan: JsonRecord, targets: JsonRecord[]): void {
  const items = Array.isArray(plan.items) ? plan.items.map(asJsonRecord) : [];
  const canonicalPlan = items.map((item) => ({
    id: String(item.storeId || ''),
    rowVersion: Number(item.storeRowVersion),
    configVersion: Number(item.storeConfigVersion),
    credentialVersionId: String(item.credentialVersionId || ''),
    presetId: String(item.presetId || ''),
    presetRowVersion: Number(item.presetRowVersion),
    presetDefinitionHash: String(item.presetDefinitionHash || ''),
    publicationMode: String(item.publicationMode || ''),
    warehouseId: String(item.warehouseId || ''),
    fulfillmentMode: String(item.fulfillmentMode || ''),
    accountCurrency: String(item.accountCurrency || ''),
    expectedOfferIds: Array.isArray(item.offerIds) ? item.offerIds.map(String) : []
  })).sort((left, right) => left.id.localeCompare(right.id));
  const canonicalTargets = targets.map((target) => ({
    id: String(target.id || ''),
    rowVersion: Number(target.rowVersion),
    configVersion: Number(target.configVersion),
    credentialVersionId: String(target.credentialVersionId || ''),
    presetId: String(target.presetId || ''),
    presetRowVersion: Number(target.presetRowVersion),
    presetDefinitionHash: String(target.presetDefinitionHash || ''),
    publicationMode: String(target.publicationMode || ''),
    warehouseId: String(target.warehouseId || ''),
    fulfillmentMode: String(target.fulfillmentMode || ''),
    accountCurrency: String(target.accountCurrency || ''),
    expectedOfferIds: Array.isArray(target.expectedOfferIds) ? target.expectedOfferIds.map(String) : []
  })).sort((left, right) => left.id.localeCompare(right.id));
  if (!canonicalTargets.length || stableJson(canonicalPlan) !== stableJson(canonicalTargets)) {
    throw new StopAutoJob(
      'OZON_PRE_PLAN_FANOUT_TARGET_DRIFT',
      'PRE_PLAN 恢复后的店铺、凭据、预设、发布模式或 Offer 集合已变化'
    );
  }
}

function assertPrePlanCurrentStores(currentInput: unknown[], targets: JsonRecord[]): void {
  const current = currentInput.map(asJsonRecord);
  const currentById = new Map(current.map((store) => [String(store.id || ''), store]));
  for (const target of targets) {
    const store = currentById.get(String(target.id || ''));
    const presetSnapshotHash = store?.presetSnapshot
      ? `sha256:${createHash('sha256').update(stableJson(store.presetSnapshot)).digest('hex')}`
      : '';
    if (!store
      || Number(store.rowVersion) !== Number(target.rowVersion)
      || Number(store.configVersion) !== Number(target.configVersion)
      || String(asJsonRecord(store.credential).activeVersionId || '') !== String(target.credentialVersionId || '')
      || String(store.defaultPresetId || '') !== String(target.presetId || '')
      || Number(store.presetRowVersion) !== Number(target.presetRowVersion)
      || presetSnapshotHash !== String(target.presetSnapshotHash || '')
      || String(store.autoPublishMode || '') !== String(target.publicationMode || '')
      || String(store.warehouseId || '') !== String(target.warehouseId || '')
      || String(store.fulfillmentMode || '') !== String(target.fulfillmentMode || '')
      || String(store.accountCurrency || '') !== String(target.accountCurrency || '')) {
      throw new StopAutoJob('OZON_PRE_PLAN_STORE_SNAPSHOT_DRIFT', 'PRE_PLAN 恢复后的目标店铺冻结配置已变化');
    }
  }
  if (current.length !== targets.length) {
    throw new StopAutoJob('OZON_PRE_PLAN_STORE_SET_DRIFT', 'PRE_PLAN 恢复后的自动发布店铺集合已变化');
  }
}











function isMissingListing(error: unknown): boolean {
  return error instanceof AppError && error.code === 'NOT_FOUND' && error.message.includes('草稿');
}

function sharedMaterialDataSignature(listing: OzonListingDraft): string {
  return String((listing as OzonListingDraft & { dataSignature?: string }).dataSignature || '');
}

function frozenFanoutStoreIds(plan: JsonRecord): string[] {
  return [...new Set((Array.isArray(plan.items) ? plan.items : [])
    .map((entry) => String(asJsonRecord(entry).storeId || '').trim())
    .filter(Boolean))];
}

function preparationRecoveryCapability(job: OzonPublishJob, hasFrozenPlan: boolean): {
  canRecheck: boolean;
  canManualTakeover: boolean;
  recoveryMode: 'NONE' | 'RECHECK' | 'REPLAN_WITH_CURRENT_PRESET' | 'MANUAL_TAKEOVER' | 'READBACK_REQUIRED';
  blockedReason?: string;
} {
  const recoverableState = ['NEEDS_ATTENTION', 'FAILED', 'CANCELLED'].includes(job.state);
  const remoteEvidence = Boolean(
    job.payload?.networkRecovery
    || job.payload?.platformWriteAttempted === true
    || job.importTaskId
    || job.ozonProductId
    || ['PROCESSING', 'SUCCESS'].includes(String(job.directoryStage || '').toUpperCase())
  );
  if (remoteEvidence) {
    return {
      canRecheck: false,
      canManualTakeover: false,
      recoveryMode: 'READBACK_REQUIRED',
      blockedReason: 'REMOTE_EVIDENCE_REQUIRES_READBACK'
    };
  }
  if (!recoverableState) {
    return {
      canRecheck: false,
      canManualTakeover: false,
      recoveryMode: 'NONE',
      blockedReason: 'PREPARATION_STATE_NOT_RECOVERABLE'
    };
  }
  return {
    canRecheck: hasFrozenPlan,
    canManualTakeover: true,
    recoveryMode: hasFrozenPlan ? 'RECHECK' : 'MANUAL_TAKEOVER',
    ...(!hasFrozenPlan ? { blockedReason: 'FANOUT_PLAN_NOT_FROZEN' } : {})
  };
}

function frozenFanoutRequiresCurrentPresetReplan(plan: JsonRecord): boolean {
  const items = Array.isArray(plan.items) ? plan.items.map(asJsonRecord) : [];
  return items.length > 0 && items.some((item) => item.ready !== true);
}

function mediaReconciliationKey(input: DeliveryNotification): string {
  return `${input.sku}:${input.stageId}:${input.submissionId}:${input.variantId || ''}`;
}

function automaticDeliveryIdentities(job: OzonPublishJob): OzonAutomaticDeliveryIdentity[] {
  const payload = asJsonRecord(job.payload);
  const candidates = Array.isArray(payload.mediaDeliveries)
    ? payload.mediaDeliveries
    : payload.media ? [payload.media] : [];
  const identities = new Map<string, OzonAutomaticDeliveryIdentity>();
  for (const candidate of candidates) {
    const delivery = asJsonRecord(candidate);
    const sourceStageId = String(delivery.sourceStageId || '').trim();
    const submissionId = String(delivery.submissionId || '').trim();
    const variantId = String(delivery.variantId || '').trim();
    const deliveredAtValue = String(delivery.deliveredAt || '').trim();
    const deliveredAt = Date.parse(deliveredAtValue);
    if (!['E004', 'E005'].includes(sourceStageId)
      || !submissionId
      || !variantId
      || !Number.isFinite(deliveredAt)) {
      throw new StopAutoJob(
        'OZON_MEDIA_DELIVERY_IDENTITY_MISSING',
        '多店铺共享准备任务包含不完整的冻结媒体投递身份'
      );
    }
    const identity: OzonAutomaticDeliveryIdentity = {
      sourceStageId,
      submissionId,
      variantId,
      deliveredAt: new Date(deliveredAt).toISOString()
    };
    const key = automaticDeliveryIdentityKey(identity);
    const existing = identities.get(key);
    if (existing && existing.deliveredAt !== identity.deliveredAt) {
      throw new StopAutoJob(
        'OZON_MEDIA_DELIVERY_IDENTITY_DRIFT',
        '多店铺共享准备任务的冻结媒体投递时间发生漂移'
      );
    }
    identities.set(key, identity);
  }
  return sortAutomaticDeliveryIdentities(identities.values());
}

function frozenPublicationDeliveryIdentities(
  job: OzonPublishJob,
  listing: OzonListingDraft
): OzonAutomaticDeliveryIdentity[] {
  const assets = new Map<string, OzonMediaAsset>();
  for (const asset of listing.data.mediaAssets) {
    if (assets.has(asset.assetId)) {
      throw new StopAutoJob('OZON_MEDIA_DELIVERY_IDENTITY_DRIFT', '冻结商品资料包含重复媒体资源 ID');
    }
    assets.set(asset.assetId, asset);
  }

  const referencedAssetIds = new Set(
    listing.data.offers.flatMap((offer) => offer.media.map((reference) => reference.assetId))
  );
  const identities = new Map<string, OzonAutomaticDeliveryIdentity>();
  for (const assetId of referencedAssetIds) {
    const asset = assets.get(assetId);
    if (!asset) {
      throw new StopAutoJob('OZON_MEDIA_DELIVERY_IDENTITY_DRIFT', '冻结商品资料引用了不存在的媒体资源');
    }
    const sourceStageId = String(asset.sourceStageId || '').trim();
    const submissionId = String(asset.sourceSubmissionId || '').trim();
    const variantId = String(asset.productVariantId || '').trim();
    const deliveredAtValue = String(asset.deliveredAt || '').trim();
    const deliveredAt = Date.parse(deliveredAtValue);
    if (!['E004', 'E005'].includes(sourceStageId)
      || !submissionId
      || !variantId
      || !Number.isFinite(deliveredAt)) {
      throw new StopAutoJob(
        'OZON_MEDIA_DELIVERY_IDENTITY_MISSING',
        '冻结商品资料中被 Offer 引用的媒体缺少完整投递身份'
      );
    }
    const identity: OzonAutomaticDeliveryIdentity = {
      sourceStageId,
      submissionId,
      variantId,
      deliveredAt: new Date(deliveredAt).toISOString()
    };
    const key = automaticDeliveryIdentityKey(identity);
    const existing = identities.get(key);
    if (existing && existing.deliveredAt !== identity.deliveredAt) {
      throw new StopAutoJob(
        'OZON_MEDIA_DELIVERY_IDENTITY_DRIFT',
        '冻结商品资料中同一媒体投递身份的时间不一致'
      );
    }
    identities.set(key, identity);
  }

  for (const jobIdentity of automaticDeliveryIdentities(job)) {
    const materialIdentity = identities.get(automaticDeliveryIdentityKey(jobIdentity));
    if (!materialIdentity) {
      throw new StopAutoJob(
        'OZON_MEDIA_DELIVERY_IDENTITY_DRIFT',
        '准备任务的媒体投递身份未被冻结发布资料准确引用'
      );
    }
  }
  return sortAutomaticDeliveryIdentities(identities.values());
}

function automaticDeliveryIdentitiesFromAssets(assets: OzonMediaAsset[]): OzonAutomaticDeliveryIdentity[] {
  const identities = new Map<string, OzonAutomaticDeliveryIdentity>();
  for (const asset of assets) {
    const sourceStageId = String(asset.sourceStageId || '').trim();
    const submissionId = String(asset.sourceSubmissionId || '').trim();
    const variantId = String(asset.productVariantId || '').trim();
    const deliveredAtValue = String(asset.deliveredAt || '').trim();
    const deliveredAt = Date.parse(deliveredAtValue);
    if (!['E004', 'E005'].includes(sourceStageId)
      || !submissionId
      || !variantId
      || !Number.isFinite(deliveredAt)) {
      throw new StopAutoJob(
        'OZON_MEDIA_DELIVERY_IDENTITY_MISSING',
        '当前媒体清单缺少完整的 E004/E005 投递身份'
      );
    }
    const identity: OzonAutomaticDeliveryIdentity = {
      sourceStageId: sourceStageId as 'E004' | 'E005',
      submissionId,
      variantId,
      deliveredAt: new Date(deliveredAt).toISOString()
    };
    const key = automaticDeliveryIdentityKey(identity);
    const existing = identities.get(key);
    if (existing && existing.deliveredAt !== identity.deliveredAt) {
      throw new StopAutoJob('OZON_MEDIA_DELIVERY_IDENTITY_DRIFT', '当前媒体清单的投递时间发生漂移');
    }
    identities.set(key, identity);
  }
  return sortAutomaticDeliveryIdentities(identities.values());
}

function automaticDeliveryIdentityKey(identity: OzonAutomaticDeliveryIdentity): string {
  return `${identity.sourceStageId}:${identity.submissionId}:${identity.variantId || ''}`;
}

function sortAutomaticDeliveryIdentities(
  identities: Iterable<OzonAutomaticDeliveryIdentity>
): OzonAutomaticDeliveryIdentity[] {
  return [...identities].sort((left, right) => (
    left.deliveredAt.localeCompare(right.deliveredAt)
    || left.sourceStageId.localeCompare(right.sourceStageId)
    || left.submissionId.localeCompare(right.submissionId)
    || String(left.variantId || '').localeCompare(String(right.variantId || ''))
  ));
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

class StopAutoJob extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
