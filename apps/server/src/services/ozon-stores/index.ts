import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import writeFileAtomic from 'write-file-atomic';
import {
  AppError,
  OZON_SHARED_MATERIAL_HASH_VERSION,
  ozonProductSchema,
  ozonIntakeVerifySchema,
  ozonPublicationCreateInputSchema,
  ozonPublicationCompatibleAppendSchema,
  ozonPublicationMutationSchema,
  ozonPublicationPlanInputSchema,
  ozonPublicationRecheckInputSchema,
  ozonRuntimeClaimSchema,
  ozonRuntimeClaimResultSchema,
  ozonRuntimePreflightClaimSchema,
  ozonRuntimeStorePreflightReportInputSchema,
  ozonStoreCreateSchema,
  ozonStoreCredentialInputSchema,
  ozonStoreMutationSchema,
  ozonStorePreflightDispatchSchema,
  ozonStoreSystemSettingsPatchSchema,
  ozonStoreUpdateSchema,
  type OzonPublicationPlan,
  type OzonPublicationPlanInput,
  type OzonPublicationTaskSummary,
  type OzonAutomaticListingSnapshot,
  type OzonStore,
  type OzonStorePublication,
  type OzonVariantColorAuthority
} from '@n8n-media-review/shared';
import type {
  OzonAutomaticListingSnapshotContext,
  OzonImportNoBrandRecoveryInput,
  OzonImportPriceFloorRecoveryInput,
  OzonPublicationPlanningContext,
  OzonStoreRepository
} from '../../repositories/ozon-stores.js';
import {
  assertOzonPresetDefinitionMatchesCategory,
  type OzonRepository
} from '../../repositories/ozon.js';
import {
  assertOzonVariantColorAuthority,
  createOzonVariantColorAuthority,
  normalizeOzonPlatformStatusRefresh,
  type OzonPublishingService
} from '../ozon-publishing/index.js';
import { normalizeOzonNoBrandAttributeForPlatform } from '../ozon-publishing/material-preparation.js';
import { isRetryableOzonTitleTranslationError } from '../ozon-publishing/title-translation.js';
import { OzonNetworkRequestError } from '../ozon-publishing/network-recovery.js';
import { OzonCredentialVault } from './token-vault.js';
import type { OzonSourceMediaCleanupService } from '../ozon-source-media/index.js';
import { withOzonSourceMediaSkuLock } from '../ozon-source-media/sku-lock.js';
import { safeOzonSignatureEqual, signIntakeTicket, signSharedSourceMarker } from './integrity.js';

export { signIntakeTicket, signSharedSourceMarker } from './integrity.js';

type JsonRecord = Record<string, unknown>;
type OzonPriceCurrency = 'RUB' | 'CNY';
type OzonStorePresetPrices = {
  currency: OzonPriceCurrency;
  price: number;
  oldPrice: number;
  minPrice: number;
};

export type OzonAutomaticDeliveryIdentity = {
  sourceStageId: string;
  submissionId: string;
  variantId?: string;
  deliveredAt: string;
};

type BuiltPlan = {
  plan: OzonPublicationPlan;
  context: OzonPublicationPlanningContext;
  productByStore: Map<string, JsonRecord>;
  modeEvidenceByStore: Map<string, OzonPublicationModeEvidence>;
  settingsContract: {
    rowVersion: number;
    rootDirectoryHash: string;
  };
};

type OzonPublicationModeEvidence = {
  preservedOfferIds: string[];
  evidenceHash: string;
};

export type OzonFrozenAutomaticPublicationPlan = OzonPublicationPlan & {
  schemaVersion: 3;
  settingsRowVersion: number;
  rootDirectoryHash: string;
  stores: Array<{
    storeId: string;
    storeSnapshot: OzonPublicationPlanningContext['stores'][number];
    productSnapshot: JsonRecord;
    productSnapshotHash: string;
    modeEvidence: OzonPublicationModeEvidence;
  }>;
  frozenContractHash: string;
};

export class OzonStoreService {
  private sourceMediaCleanup?: OzonSourceMediaCleanupService;

  constructor(
    readonly repository: OzonStoreRepository,
    private readonly ozon: OzonRepository,
    private readonly publishing: OzonPublishingService,
    private readonly vault = new OzonCredentialVault()
  ) {}

  setSourceMediaCleanup(service: OzonSourceMediaCleanupService): void {
    this.sourceMediaCleanup = service;
  }

  async settings() { return this.repository.getSettings(); }

  async updateSettings(input: unknown) {
    const parsed = ozonStoreSystemSettingsPatchSchema.safeParse(input);
    if (!parsed.success) throw validationError('无效的 OZON 公共设置', parsed.error.issues);
    const current = await this.repository.getSettings();
    if (current.rowVersion !== parsed.data.rowVersion) {
      throw new AppError('VERSION_CONFLICT', 'OZON 公共设置已被其他操作修改，请刷新后重试', {
        expected: parsed.data.rowVersion,
        actual: current.rowVersion
      }, 409);
    }
    const rootDirectory = parsed.data.rootDirectory ?? current.rootDirectory;
    const enabled = parsed.data.enabled ?? current.enabled;
    if (enabled && !rootDirectory) throw new AppError('CONFIG_INVALID', '启用 OZON 前必须配置根目录', undefined, 409);
    if (rootDirectory && (rootDirectory !== current.rootDirectory || (enabled && !current.enabled))) {
      await this.publishing.initializeRoot(rootDirectory);
      await mkdir(path.join(rootDirectory, 'stores'), { recursive: true });
    }
    return this.repository.updateSettings(parsed.data);
  }

  async listStores(includeArchived = false) {
    const items = await this.repository.listStores(includeArchived);
    return { items, total: items.length };
  }

  async createStore(input: unknown) {
    const parsed = ozonStoreCreateSchema.safeParse(input);
    if (!parsed.success) throw validationError('无效的 OZON 店铺配置', parsed.error.issues);
    await this.assertStorePresetConfiguration(
      parsed.data.autoPublishEnabled,
      parsed.data.defaultPresetId,
      Boolean(parsed.data.defaultPresetId)
    );
    return this.repository.createStore(parsed.data);
  }

  async updateStore(storeId: string, input: unknown) {
    const parsed = ozonStoreUpdateSchema.safeParse(input);
    if (!parsed.success) throw validationError('无效的 OZON 店铺配置', parsed.error.issues);
    if (parsed.data.autoPublishEnabled !== undefined || parsed.data.defaultPresetId !== undefined) {
      const current = await this.repository.getStore(storeId);
      const effectiveAutoPublishEnabled = parsed.data.autoPublishEnabled ?? current.autoPublishEnabled;
      const effectiveDefaultPresetId = parsed.data.defaultPresetId === undefined
        ? current.defaultPresetId
        : parsed.data.defaultPresetId;
      await this.assertStorePresetConfiguration(
        effectiveAutoPublishEnabled,
        effectiveDefaultPresetId,
        Boolean(parsed.data.defaultPresetId)
      );
    }
    return this.repository.updateStore(storeId, parsed.data);
  }

  private async assertStorePresetConfiguration(
    autoPublishEnabled: boolean,
    defaultPresetId: string | null | undefined,
    validateBoundPreset: boolean
  ): Promise<void> {
    if (autoPublishEnabled && !defaultPresetId) {
      throw new AppError(
        'CONFIG_INVALID',
        '启用 OZON 自动上品前必须配置默认上品预设',
        { autoPublishEnabled: true, defaultPresetId: null },
        409
      );
    }
    if (defaultPresetId && (autoPublishEnabled || validateBoundPreset)) {
      await this.assertDefaultPresetCompatible(defaultPresetId);
    }
  }

  private async assertDefaultPresetCompatible(presetId: string): Promise<void> {
    const preset = await this.ozon.getPreset(presetId);
    const category = await this.ozon.getCategory(preset.categoryKey);
    if (!category.publishedVersion) {
      throw new AppError('CONFIG_INVALID', '店铺默认 OZON 预设引用的类目尚未发布', {
        presetId,
        categoryKey: preset.categoryKey
      }, 409);
    }
    assertOzonPresetDefinitionMatchesCategory(preset, category.publishedVersion.snapshot);
  }

  async saveCredential(storeId: string, input: unknown) {
    const parsed = ozonStoreCredentialInputSchema.safeParse(input);
    if (!parsed.success) {
      // Credential validation errors deliberately do not echo request values.
      throw new AppError('CONFIG_INVALID', 'OZON Client-Id、Api-Key 或 rowVersion 格式无效');
    }
    const credentialVersionId = randomUUID();
    const encrypted = this.vault.encrypt(
      { clientId: parsed.data.clientId, apiKey: parsed.data.apiKey },
      storeId,
      credentialVersionId
    );
    return this.repository.savePendingCredential(storeId, parsed.data.rowVersion, credentialVersionId, encrypted);
  }

  async preflight(storeId: string, input: unknown) {
    const parsed = ozonStoreMutationSchema.safeParse(input);
    if (!parsed.success) throw validationError('缺少有效的 rowVersion', parsed.error.issues);
    const settings = await this.repository.getSettings();
    if (!settings.preflightWebhookUrl) {
      throw new AppError('CONFIG_INVALID', '尚未配置 OZON 店铺预检 Webhook', undefined, 409);
    }
    const context = await this.repository.beginPreflight(storeId, parsed.data.rowVersion);
    const requestRef = `ozon-preflight:${storeId}:${context.storeConfigVersion}:${context.credentialVersionId}:${randomUUID()}`;
    const dispatch = ozonStorePreflightDispatchSchema.parse({
      action: 'preflight',
      storeId,
      storeAlias: context.store.storeAlias,
      rowVersion: context.store.rowVersion,
      storeConfigVersion: context.storeConfigVersion,
      credentialVersionId: context.credentialVersionId,
      requestRef
    });
    let result: Awaited<ReturnType<typeof postJson>>;
    try {
      result = await postJson(settings.preflightWebhookUrl, dispatch);
    } catch (error) {
      if (error instanceof AppError && error.details?.deliveryUnknown === false) {
        await this.repository.failPreflightDispatch(
          storeId,
          context.storeConfigVersion,
          context.credentialVersionId
        );
      }
      throw error;
    }
    // The webhook body is intentionally not reflected to the browser: a
    // misconfigured workflow could echo Client-Id/Api-Key/Authorization.
    return { accepted: result.accepted, requestRef, store: context.store };
  }

  async applyPreflightReport(storeId: string, input: unknown) {
    const parsed = ozonRuntimeStorePreflightReportInputSchema.safeParse(input);
    if (!parsed.success) throw validationError('无效的 OZON 店铺预检回写', parsed.error.issues);
    return this.repository.applyPreflightReport(
      storeId,
      parsed.data.storeConfigVersion,
      parsed.data.credentialVersionId,
      parsed.data.report
    );
  }

  async enable(storeId: string, input: unknown) {
    const parsed = ozonStoreMutationSchema.safeParse(input);
    if (!parsed.success) throw validationError('缺少有效的 rowVersion', parsed.error.issues);
    const store = await this.repository.getStore(storeId);
    await this.assertStorePresetConfiguration(
      store.autoPublishEnabled,
      store.defaultPresetId,
      Boolean(store.defaultPresetId)
    );
    return this.repository.setStoreEnabled(storeId, true, parsed.data.rowVersion);
  }

  async disable(storeId: string, input: unknown) {
    const parsed = ozonStoreMutationSchema.safeParse(input);
    if (!parsed.success) throw validationError('缺少有效的 rowVersion', parsed.error.issues);
    return this.repository.setStoreEnabled(storeId, false, parsed.data.rowVersion);
  }

  async archive(storeId: string, input: unknown) {
    const parsed = ozonStoreMutationSchema.safeParse(input);
    if (!parsed.success) throw validationError('缺少有效的 rowVersion', parsed.error.issues);
    return this.repository.archiveStore(storeId, parsed.data.rowVersion);
  }

  async publicationPlan(sku: string, input: unknown): Promise<OzonPublicationPlan> {
    const parsed = ozonPublicationPlanInputSchema.safeParse(input);
    if (!parsed.success) throw validationError('无效的 OZON 多店铺发布计划', parsed.error.issues);
    return (await this.buildPlan(sku, parsed.data)).plan;
  }

  async createPublications(sku: string, input: unknown): Promise<{
    publications: OzonStorePublication[];
    results: Array<{ storeId: string; publicationId: string; status: string; errorCode?: string; errorMessage?: string }>;
    accepted: number;
    failed: number;
  }> {
    const parsed = ozonPublicationCreateInputSchema.safeParse(input);
    if (!parsed.success) throw validationError('无效的 OZON 多店铺发布请求', parsed.error.issues);
    const built = await this.buildPlan(sku, parsed.data);
    if (built.plan.planHash !== parsed.data.planHash) {
      throw new AppError('VERSION_CONFLICT', '店铺、凭据、预设或草稿已变化，请重新生成发布计划', {
        expectedPlanHash: parsed.data.planHash,
        currentPlanHash: built.plan.planHash
      }, 409);
    }
    const resultWithFailures = await this.createFromBuiltPlan(
      built,
      'MANUAL',
      undefined,
      parsed.data.requestId
    );
    const { failures, ...result } = resultWithFailures;
    void failures;
    return result;
  }

  async createAutomaticPublications(
    sku: string,
    draftVersion: number,
    storeIds: string[],
    deliveryIdentity: OzonAutomaticDeliveryIdentity,
    preparationJobId?: string,
    expectedPlanHash?: string
  ): Promise<{
    publications: OzonStorePublication[];
    results: Array<{ storeId: string; publicationId: string; status: string; errorCode?: string; errorMessage?: string }>;
    failures: Array<{ storeId: string; storeAlias: string; code: string; message: string }>;
    accepted: number;
    failed: number;
  }> {
    const parsed = ozonPublicationPlanInputSchema.safeParse({ draftVersion, storeIds });
    if (!parsed.success) throw validationError('无效的 OZON 自动多店铺发布计划', parsed.error.issues);
    assertAutomaticDeliveryIdentity(deliveryIdentity);
    const built = await this.buildPlan(sku, parsed.data);
    if (expectedPlanHash && built.plan.planHash !== expectedPlanHash) {
      throw new AppError('VERSION_CONFLICT', '店铺、凭据、预设或公共素材已偏离冻结 fan-out 计划', {
        expectedPlanHash,
        currentPlanHash: built.plan.planHash,
        preparationJobId
      }, 409);
    }
    return this.createFromBuiltPlan(built, 'AUTOMATION', deliveryIdentity, undefined, preparationJobId);
  }

  async createAutomaticPublicationsFromFrozenPlan(
    frozenInput: unknown,
    deliveryIdentity: OzonAutomaticDeliveryIdentity,
    preparationJobId: string
  ): Promise<{
    publications: OzonStorePublication[];
    results: Array<{ storeId: string; publicationId: string; status: string; errorCode?: string; errorMessage?: string }>;
    failures: Array<{ storeId: string; storeAlias: string; code: string; message: string }>;
    accepted: number;
    failed: number;
  }> {
    assertAutomaticDeliveryIdentity(deliveryIdentity);
    const built = frozenAutomaticBuiltPlan(frozenInput);
    const settings = await this.repository.getSettings();
    assertBuiltPlanSettingsContract(settings, built.settingsContract);
    return this.createFromBuiltPlan(
      built,
      'AUTOMATION',
      deliveryIdentity,
      undefined,
      strictUuid(preparationJobId, 'preparationJobId')
    );
  }

  async automaticPublicationPlan(
    sku: string,
    draftVersion: number,
    storeIds: string[],
    options: { prepareSharedSource?: boolean; readOnly?: boolean } = {}
  ): Promise<OzonFrozenAutomaticPublicationPlan> {
    const parsed = ozonPublicationPlanInputSchema.parse({ draftVersion, storeIds });
    const built = await this.buildPlan(sku, parsed, { ...options, retryTransientTranslation: true });
    const settings = await this.repository.getSettings();
    assertBuiltPlanSettingsContract(settings, built.settingsContract);
    const stores = built.plan.items.map((item) => {
      const storeSnapshot = built.context.stores.find((store) => store.id === item.storeId);
      if (!storeSnapshot) {
        throw new AppError('VERSION_CONFLICT', 'OZON 自动发布计划缺少店铺冻结快照', {
          storeId: item.storeId,
          planHash: built.plan.planHash
        }, 409);
      }
      const productSnapshot = structuredClone(built.productByStore.get(item.storeId) || {});
      return {
        storeId: item.storeId,
        storeSnapshot: structuredClone(storeSnapshot),
        productSnapshot,
        productSnapshotHash: sha256(stableMaterial(productSnapshot)),
        modeEvidence: structuredClone(built.modeEvidenceByStore.get(item.storeId)!)
      };
    });
    const contract = {
      schemaVersion: 3 as const,
      ...built.plan,
      settingsRowVersion: settings.rowVersion,
      rootDirectoryHash: built.settingsContract.rootDirectoryHash,
      stores
    };
    return {
      ...contract,
      frozenContractHash: sha256(contract)
    };
  }

  private async applyPublicationModes(built: BuiltPlan): Promise<void> {
    for (const item of built.plan.items) {
      const store = built.context.stores.find((candidate) => candidate.id === item.storeId);
      if (!store) throw new AppError('VERSION_CONFLICT', 'OZON 发布计划缺少店铺快照', { storeId: item.storeId }, 409);
      const preservedOfferIds = await this.repository.getSuccessfulOfferUnion(item.storeId, built.plan.sku);
      const preserved = [...new Set(preservedOfferIds)].sort();
      built.modeEvidenceByStore.set(item.storeId, {
        preservedOfferIds: preserved,
        evidenceHash: publicationModeEvidenceHash(item.storeId, built.plan.sku, item.publicationMode, preserved)
      });
      if (!item.ready) continue;
      if (store.autoPublishMode === 'CREATE_ONLY' && preservedOfferIds.length) {
        item.ready = false;
        item.blockers = [...item.blockers, '店铺为仅创建模式，但该 SKU 已存在成功 Offer 或平台映射'];
        continue;
      }
      if (store.autoPublishMode !== 'COMPATIBLE_UPSERT' || !preservedOfferIds.length) continue;
      const preservedSet = new Set(preservedOfferIds);
      const newOfferIds = item.offerIds.filter((offerId) => !preservedSet.has(offerId));
      if (!newOfferIds.length) {
        item.ready = false;
        item.blockers = [...item.blockers, '店铺兼容发布没有新的 Offer 可追加'];
        continue;
      }
      const product = built.productByStore.get(item.storeId)!;
      const appendProduct = {
        ...product,
        offers: asArray(product.offers).filter((entry) => newOfferIds.includes(String(asRecord(entry).offerId || '')))
      };
      const validated = ozonProductSchema.safeParse(appendProduct);
      if (!validated.success) {
        item.ready = false;
        item.blockers = [...item.blockers, '店铺兼容追加发布包合同无效'];
        continue;
      }
      item.offerIds = newOfferIds;
      item.offerContractHash = sha256({
        storeId: item.storeId,
        generatedVersionId: built.plan.generatedVersionId,
        offerIds: [...newOfferIds].sort(),
        preservedOfferIds: preserved,
        mode: 'COMPATIBLE_UPSERT'
      });
      item.materializationHash = sha256({
        sourceMediaIdentityHash: built.plan.sourceMediaIdentityHash,
        product: stableMaterial(appendProduct),
        variantColorAuthorityHash: built.plan.variantColorAuthority.hash,
        storeId: item.storeId,
        storeConfigVersion: item.storeConfigVersion,
        presetDefinitionHash: item.presetDefinitionHash || null,
        offerContractHash: item.offerContractHash
      });
      built.productByStore.set(item.storeId, appendProduct);
    }
  }

  private async createFromBuiltPlan(
    built: BuiltPlan,
    source: 'MANUAL' | 'AUTOMATION',
    deliveryIdentity?: OzonAutomaticDeliveryIdentity,
    requestId?: string,
    preparationJobId?: string
  ): Promise<{
    publications: OzonStorePublication[];
    results: Array<{ storeId: string; publicationId: string; status: string; errorCode?: string; errorMessage?: string }>;
    failures: Array<{ storeId: string; storeAlias: string; code: string; message: string }>;
    accepted: number;
    failed: number;
  }> {
    const settings = await this.repository.getSettings();
    assertBuiltPlanSettingsContract(settings, built.settingsContract);
    const attemptRequestId = requestId || (preparationJobId
      ? deterministicUuid('ozon-fanout-request', preparationJobId, built.plan.planHash)
      : undefined);
    if (this.sourceMediaCleanup?.repository.configured) {
      await this.sourceMediaCleanup.assertVersionAvailable(built.plan.generatedVersionId);
      if (/^sha256:[a-f0-9]{64}$/.test(built.plan.sourceMediaIdentityHash)) {
        await this.sourceMediaCleanup.registerPlan({
          plan: built.plan,
          source,
          rootDirectory: settings.rootDirectory,
          ...(attemptRequestId ? { requestId: attemptRequestId } : {}),
          ...(preparationJobId ? { preparationJobId } : {})
        });
      }
    }
    const publications: OzonStorePublication[] = [];
    const failures: Array<{ storeId: string; storeAlias: string; code: string; message: string }> = [];
    const results: Array<{
      storeId: string;
      publicationId: string;
      status: string;
      errorCode?: string;
      errorMessage?: string;
    }> = [];

    // Each store commits independently. A filesystem, database or dispatch
    // failure for one Seller must not roll back another Seller's publication.
    for (const item of built.plan.items) {
      const store = built.context.stores.find((candidate) => candidate.id === item.storeId)!;
      let planned: OzonStorePublication | undefined;
      try {
        const frozenProduct = built.productByStore.get(item.storeId);
        planned = await this.repository.planPublicationAttempt({
          id: item.publicationId,
          jobId: item.plannedJobId,
          sku: built.plan.sku,
          generatedVersionId: built.plan.generatedVersionId,
          revision: built.plan.revision,
          storeId: item.storeId,
          storeAlias: item.storeAlias,
          storeDisplayName: item.displayName,
          source,
          credentialBindingMode: item.credentialBindingMode,
          credentialVersionId: item.credentialVersionId,
          storeConfigVersion: item.storeConfigVersion,
          presetId: item.presetId,
          presetName: store.presetName,
          presetRowVersion: item.presetRowVersion,
          presetSnapshot: store.presetSnapshot,
          presetDefinitionHash: item.presetDefinitionHash,
          preparationJobId,
          requestId: attemptRequestId,
          planHash: built.plan.planHash,
          contentPolicyVersion: built.context.contentPolicyVersion,
          materialHash: built.context.materialHash,
          materialHashVersion: built.context.materialHashVersion,
          publicationMode: item.publicationMode,
          taskId: item.taskId,
          warehouseId: item.warehouseId,
          warehouseName: item.warehouseName,
          fulfillmentMode: item.fulfillmentMode,
          accountCurrency: item.accountCurrency,
          offerIds: item.offerIds,
          offerContractHash: item.offerContractHash,
          materializationHash: item.materializationHash,
          materializedProductSnapshot: frozenProduct || {}
        });
        if (['QUEUED', 'RUNNING', 'SUCCEEDED'].includes(planned.status)) {
          if (deliveryIdentity) {
            await this.repository.recordMediaConsumption({
              storeId: item.storeId,
              sku: built.plan.sku,
              ...deliveryIdentity,
              publicationId: planned.id,
              decision: 'ALREADY_BOUND',
              reason: '当前生成版本已绑定该店铺 publication'
            });
          }
          publications.push(planned);
          results.push({ storeId: item.storeId, publicationId: planned.id, status: planned.status });
          continue;
        }
        if (!item.ready) {
          const message = item.blockers.join('；') || 'OZON 店铺尚未就绪';
          const errorCode = item.errorCode || 'OZON_STORE_NOT_READY';
          const failed = await this.repository.failPublicationAttempt({
            publicationId: item.publicationId,
            jobId: item.plannedJobId,
            errorCode,
            errorMessage: message,
            phase: 'LOCAL_VALIDATION',
            errorDetails: item.errorDetails
          });
          failures.push({ storeId: item.storeId, storeAlias: item.storeAlias, code: errorCode, message });
          publications.push(failed);
          results.push({
            storeId: item.storeId,
            publicationId: failed.id,
            status: failed.status,
            errorCode,
            errorMessage: message
          });
          continue;
        }
        if (!frozenProduct) {
          throw new AppError('OZON_STORE_NOT_READY', '店铺发布计划缺少冻结商品快照', {
            storeId: item.storeId,
            publicationId: item.publicationId
          }, 409);
        }
        const packageResult = await writeStorePackage({
          rootDirectory: settings.rootDirectory,
          storeAlias: item.storeAlias,
          sku: built.plan.sku,
          generatedVersionId: built.plan.generatedVersionId,
          revision: built.plan.revision,
          publicationId: item.publicationId,
          jobId: item.plannedJobId,
          taskId: item.taskId,
          storeId: item.storeId,
          credentialBindingMode: item.credentialBindingMode,
          credentialVersionId: item.credentialVersionId,
          storeConfigVersion: item.storeConfigVersion,
          warehouseId: item.warehouseId,
          planHash: built.plan.planHash,
          contentPolicyVersion: built.context.contentPolicyVersion,
          materialHash: built.context.materialHash,
          materialHashVersion: built.context.materialHashVersion,
          presetRowVersion: item.presetRowVersion,
          publicationMode: item.publicationMode,
          materializationHash: item.materializationHash,
          offerContractHash: item.offerContractHash,
          product: frozenProduct
        });
        const created = await this.repository.materializePublicationAttempt({
          publicationId: item.publicationId,
          jobId: item.plannedJobId,
          planHash: built.plan.planHash,
          materializationHash: item.materializationHash,
          packageRelPath: packageResult.packageRelPath,
          packageSignature: packageResult.packageSignature,
          productJsonPath: packageResult.productJsonPath
        });
        if (deliveryIdentity) {
          await this.repository.recordMediaConsumption({
            storeId: item.storeId,
            sku: built.plan.sku,
            ...deliveryIdentity,
            publicationId: created.id,
            decision: 'FANNED_OUT',
            reason: 'OZON 共享媒体已物化为店铺 publication'
          });
        }
        publications.push(created);
        results.push({ storeId: item.storeId, publicationId: created.id, status: created.status });
      } catch (error) {
        const errorCode = error instanceof AppError ? error.code : 'OZON_PUBLICATION_CREATE_FAILED';
        const errorMessage = error instanceof Error ? error.message : 'OZON 店铺 publication 创建失败';
        if (planned) {
          const failed = await this.repository.failPublicationAttempt({
            publicationId: planned.id,
            jobId: item.plannedJobId,
            errorCode,
            errorMessage,
            phase: 'PACKAGE_OR_DATABASE'
          }).catch(() => undefined);
          if (failed) publications.push(failed);
          results.push({
            storeId: item.storeId,
            publicationId: planned.id,
            status: failed?.status || 'NEEDS_ATTENTION',
            errorCode,
            errorMessage
          });
        }
        if (deliveryIdentity) {
          await this.repository.recordMediaConsumption({
            storeId: item.storeId,
            sku: built.plan.sku,
            ...deliveryIdentity,
            ...(planned ? { publicationId: planned.id } : {}),
            decision: 'FAILED',
            reason: errorMessage.slice(0, 1_000)
          }).catch(() => undefined);
        }
        failures.push({
          storeId: item.storeId,
          storeAlias: item.storeAlias,
          code: errorCode,
          message: errorMessage
        });
      }
    }
    return {
      publications,
      results,
      failures,
      accepted: results.filter((result) => !result.errorCode).length,
      failed: results.filter((result) => Boolean(result.errorCode)).length
    };
  }

  async listPublications(
    sku: string | undefined,
    input: { skus?: string[]; storeId?: string; status?: string; source?: string } = {}
  ) {
    const items = await this.repository.listPublications({ ...(sku ? { sku } : {}), ...input });
    return { items, total: items.length };
  }

  async listLatestManualPublicationTaskSummaries(skus: string[]): Promise<{
    items: OzonPublicationTaskSummary[];
    total: number;
  }> {
    const items = await this.repository.listLatestManualPublicationTaskSummaries(skus);
    if (!this.sourceMediaCleanup?.repository.configured || !items.length) return { items, total: items.length };
    const generatedVersionIds = [...new Set(items.map((item) => item.generatedVersionId))];
    const summaries = new Map((await Promise.all(generatedVersionIds.map(async (generatedVersionId) => [
      generatedVersionId,
      await this.sourceMediaCleanup!.summary(generatedVersionId)
    ] as const))).filter((entry): entry is readonly [string, NonNullable<typeof entry[1]>] => Boolean(entry[1])));
    const enriched = items.map((item) => {
      const sourceMediaCleanup = summaries.get(item.generatedVersionId);
      return sourceMediaCleanup ? { ...item, sourceMediaCleanup } : item;
    });
    return { items: enriched, total: enriched.length };
  }

  async getPublication(publicationId: string) { return this.repository.getPublication(publicationId); }

  async publicationTaskDetail(publicationId: string) {
    const detail = await this.repository.getPublicationTaskDetail(strictUuid(publicationId, 'publicationId'));
    const sourceMediaCleanup = this.sourceMediaCleanup
      ? await this.sourceMediaCleanup.summary(detail.publication.generatedVersionId)
      : undefined;
    return { ...detail, ...(sourceMediaCleanup ? { sourceMediaCleanup } : {}) };
  }

  async automaticListingSnapshot(jobIdInput: string, storeIdInput: string): Promise<OzonAutomaticListingSnapshot> {
    const jobId = strictUuid(jobIdInput, 'jobId');
    const storeId = strictUuid(storeIdInput, 'storeId');
    const settings = await this.repository.getSettings();
    let context = await this.repository.getAutomaticListingSnapshotContext(jobId);
    assertAutomaticSnapshotStore(context, storeId);
    let artifact: Awaited<ReturnType<typeof readAutomaticListingArtifact>>;
    try {
      artifact = await readAutomaticListingArtifact(settings.rootDirectory, context);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      // P002 moves the whole task directory atomically between inbox,
      // processing and success. Re-read the authoritative job once so a
      // lifecycle move cannot create a false missing-artifact result.
      context = await this.repository.getAutomaticListingSnapshotContext(jobId);
      assertAutomaticSnapshotStore(context, storeId);
      try {
        artifact = await readAutomaticListingArtifact(settings.rootDirectory, context);
      } catch (retryError) {
        if (!isMissingFileError(retryError)) throw retryError;
        throw frozenArtifactUnavailable(jobId, storeId);
      }
    }
    return automaticListingSnapshotResult(context, artifact);
  }
  async recoverImportNoBrandFailure(publicationId: string, input: unknown) {
    const body = input && typeof input === 'object' && !Array.isArray(input) ? input as JsonRecord : {};
    const parsed: OzonImportNoBrandRecoveryInput = {
      publicationRowVersion: Number(body.publicationRowVersion),
      jobRowVersion: Number(body.jobRowVersion),
      dryRun: body.dryRun === undefined ? true : body.dryRun === true
    };
    if (!Number.isInteger(parsed.publicationRowVersion) || parsed.publicationRowVersion < 1
      || !Number.isInteger(parsed.jobRowVersion) || parsed.jobRowVersion < 1
      || (body.dryRun !== undefined && typeof body.dryRun !== 'boolean')) {
      throw new AppError('CONFIG_INVALID', '无品牌恢复缺少有效的 publicationRowVersion/jobRowVersion/dryRun', {
        publicationId
      }, 400);
    }
    const preview = await this.repository.recoverImportNoBrandFailure(publicationId, { ...parsed, dryRun: true });
    if (preview.status === 'ALREADY_RECOVERED') return preview;
    await this.assertImportNoBrandRecoveryArtifact(preview.checks);
    if (parsed.dryRun) return preview;
    return this.repository.recoverImportNoBrandFailure(publicationId, parsed);
  }

  async recoverImportPriceFloorFailure(publicationId: string, input: unknown) {
    const body = input && typeof input === 'object' && !Array.isArray(input) ? input as JsonRecord : {};
    const parsed: OzonImportPriceFloorRecoveryInput = {
      publicationRowVersion: Number(body.publicationRowVersion),
      jobRowVersion: Number(body.jobRowVersion),
      dryRun: body.dryRun === undefined ? true : body.dryRun === true
    };
    if (!Number.isInteger(parsed.publicationRowVersion) || parsed.publicationRowVersion < 1
      || !Number.isInteger(parsed.jobRowVersion) || parsed.jobRowVersion < 1
      || (body.dryRun !== undefined && typeof body.dryRun !== 'boolean')) {
      throw new AppError('CONFIG_INVALID', '价格下限恢复缺少有效的 publicationRowVersion/jobRowVersion/dryRun', {
        publicationId
      }, 400);
    }
    const preview = await this.repository.recoverImportPriceFloorFailure(publicationId, { ...parsed, dryRun: true });
    if (preview.status === 'ALREADY_RECOVERED') return preview;
    await this.assertImportPriceFloorRecoveryArtifact(preview.checks);
    if (parsed.dryRun) return preview;
    return this.repository.recoverImportPriceFloorFailure(publicationId, parsed);
  }

  private async assertImportPriceFloorRecoveryArtifact(
    checks: Awaited<ReturnType<OzonStoreRepository['recoverImportPriceFloorFailure']>>['checks']
  ): Promise<void> {
    const settings = await this.repository.getSettings();
    const rootDirectory = String(settings.rootDirectory || '').trim();
    if (!rootDirectory) throw new AppError('CONFIG_INVALID', 'OZON 自动上品根目录未配置', undefined, 409);
    const rootInfo = await lstat(rootDirectory).catch(() => undefined);
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new AppError('VERSION_CONFLICT', 'OZON 自动上品根目录不可安全读取', undefined, 409);
    }
    const rootReal = await realpath(rootDirectory);
    const workDirectory = path.resolve(rootReal, ...checks.workRelPath.split('/'));
    const relativeWork = path.relative(rootReal, workDirectory);
    if (!relativeWork || relativeWork.startsWith('..') || path.isAbsolute(relativeWork)) {
      throw new AppError('VERSION_CONFLICT', '价格下限恢复目录逃逸 OZON 根目录', { workRelPath: checks.workRelPath }, 409);
    }
    const workInfo = await lstat(workDirectory).catch(() => undefined);
    const productPath = path.join(workDirectory, 'product.json');
    const productInfo = await lstat(productPath).catch(() => undefined);
    if (!workInfo?.isDirectory() || workInfo.isSymbolicLink()
      || !productInfo?.isFile() || productInfo.isSymbolicLink()) {
      throw new AppError('VERSION_CONFLICT', '价格下限恢复缺少可信 processing/product.json', {
        workRelPath: checks.workRelPath
      }, 409);
    }
    const productReal = await realpath(productPath);
    const relativeProduct = path.relative(rootReal, productReal);
    if (relativeProduct.startsWith('..') || path.isAbsolute(relativeProduct)) {
      throw new AppError('VERSION_CONFLICT', '价格下限恢复 product.json 真实路径逃逸 OZON 根目录', undefined, 409);
    }
    const raw = await readFile(productReal);
    const signature = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    if (signature !== checks.directorySignature) {
      throw new AppError('VERSION_CONFLICT', '价格下限恢复 product.json 原始字节签名与任务冻结值不一致', {
        expected: checks.directorySignature,
        actual: signature
      }, 409);
    }
    let parsedJson: unknown;
    try { parsedJson = JSON.parse(raw.toString('utf8')); } catch {
      throw new AppError('VERSION_CONFLICT', '价格下限恢复 product.json 不是有效 JSON', undefined, 409);
    }
    const parsedProduct = ozonProductSchema.safeParse(parsedJson);
    if (!parsedProduct.success) {
      throw new AppError('VERSION_CONFLICT', '价格下限恢复 product.json 不符合 OZON 商品合同', {
        issues: parsedProduct.error.issues
      }, 409);
    }
    const product = parsedProduct.data as JsonRecord;
    const offers = Array.isArray(product.offers) ? product.offers.map((entry) => entry as JsonRecord) : [];
    const offerIds = offers.map((offer) => String(offer.offerId || ''));
    if (JSON.stringify(offerIds) !== JSON.stringify(checks.offerIds)
      || !['RUB', 'CNY'].includes(String(product.currency || ''))
      || offers.some((offer) => {
        const price = Number(offer.price);
        const oldPrice = Number(offer.oldPrice);
        const minPrice = Number(offer.minPrice);
        const stock = Number(offer.stock);
        return !Number.isFinite(price) || price <= 0 || !Number.isFinite(oldPrice) || oldPrice < price
          || !Number.isFinite(minPrice) || minPrice < 0 || minPrice >= price
          || !Number.isInteger(stock) || stock < 0;
      })) {
      throw new AppError('VERSION_CONFLICT', '价格下限恢复 product.json 的 Offer/币种/价格/库存目标无效', {
        offerIds,
        expectedOfferIds: checks.offerIds,
        currency: product.currency
      }, 409);
    }
  }

  private async assertImportNoBrandRecoveryArtifact(
    checks: Awaited<ReturnType<OzonStoreRepository['recoverImportNoBrandFailure']>>['checks']
  ): Promise<void> {
    await this.assertImportPriceFloorRecoveryArtifact(checks);
    const settings = await this.repository.getSettings();
    const rootReal = await realpath(String(settings.rootDirectory || ''));
    const productPath = path.resolve(rootReal, ...checks.workRelPath.split('/'), 'product.json');
    const raw = await readFile(productPath);
    const signature = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    if (signature !== checks.directorySignature) {
      throw new AppError('VERSION_CONFLICT', '无品牌恢复 product.json 在验证期间发生变化', undefined, 409);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch {
      throw new AppError('VERSION_CONFLICT', '无品牌恢复 product.json 不是有效 JSON', undefined, 409);
    }
    const product = parsed as JsonRecord;
    const brand = String(product.brand || '').trim().toLocaleLowerCase('ru-RU');
    const brandAttributes = asArray(product.sharedAttributes).map(asRecord)
      .filter((attribute) => Number(attribute.attributeId ?? attribute.id) === 85
        && Number(attribute.complexId ?? attribute.complex_id ?? 0) === 0);
    const exactTextSentinel = brandAttributes.length === 1
      && asArray(brandAttributes[0]?.values).length === 1
      && (() => {
        const value = asRecord(asArray(brandAttributes[0]?.values)[0]);
        return !Number(value.dictionaryValueId ?? value.dictionary_value_id ?? 0)
          && ['无品牌', 'нет бренда'].includes(String(value.value || '').trim().toLocaleLowerCase('ru-RU'));
      })();
    if (brand !== 'нет бренда' || !exactTextSentinel) {
      throw new AppError('VERSION_CONFLICT', '无品牌恢复只允许纠正冻结 product.json 中属性 85 的明确无品牌文本哨兵', {
        brand,
        brandAttributeCount: brandAttributes.length
      }, 409);
    }
  }

  async syncPublication(publicationId: string, input: unknown) {
    const parsed = ozonPublicationMutationSchema.safeParse(input);
    if (!parsed.success) throw validationError('缺少有效的 publication rowVersion', parsed.error.issues);
    return this.repository.syncPublicationFromJob(publicationId, parsed.data.rowVersion);
  }

  async cancelPublication(publicationId: string, input: unknown) {
    const parsed = ozonPublicationMutationSchema.safeParse(input);
    if (!parsed.success) throw validationError('缺少有效的 publication rowVersion', parsed.error.issues);
    return this.repository.cancelPublication(publicationId, parsed.data.rowVersion);
  }

  async recheckPublication(publicationId: string, input: unknown) {
    const parsed = ozonPublicationRecheckInputSchema.safeParse(input);
    if (!parsed.success) throw validationError('OZON publication 重检缺少冻结身份', parsed.error.issues);
    const attempt = await this.repository.getPublication(publicationId);
    if (attempt.rowVersion !== parsed.data.rowVersion
      || attempt.planHash !== parsed.data.planHash
      || attempt.requestId !== parsed.data.requestId) {
      throw new AppError('VERSION_CONFLICT', 'OZON publication 与重检冻结身份不一致', {
        publicationId,
        expectedRowVersion: attempt.rowVersion,
        expectedPlanHash: attempt.planHash,
        expectedRequestId: attempt.requestId
      }, 409);
    }
    if (['PLANNED', 'NEEDS_ATTENTION'].includes(attempt.status)) {
      if (this.sourceMediaCleanup?.repository.configured) {
        await this.sourceMediaCleanup.assertVersionAvailable(attempt.generatedVersionId);
      }
      if (!attempt.plannedJobId
        || !attempt.materializationHash) {
        throw new AppError('VERSION_CONFLICT', 'OZON publication attempt 与重检冻结身份不一致', {
          publicationId,
          expectedRowVersion: attempt.rowVersion,
          expectedPlanHash: attempt.planHash,
          expectedRequestId: attempt.requestId
        }, 409);
      }
      const detail = await this.repository.getPublicationTaskDetail(publicationId);
      const readback = asRecord(detail.readback);
      const recovery = asRecord(detail.recovery);
      const recoveryMode = String(recovery.recoveryMode || 'NONE');
      if (readback.required === true || Number(readback.gatewayRequestCount || 0) > 0
        || recoveryMode === 'READBACK_REQUIRED') {
        throw new AppError('OZON_READBACK_REQUIRED', 'publication attempt 已有远端或网关证据，只允许按原身份平台回读', {
          publicationId,
          recoveryMode,
          ...(recovery.blockedReason ? { blockedReason: String(recovery.blockedReason) } : {})
        }, 409);
      }
      if (recovery.canRecheck !== true || recoveryMode !== 'RECHECK') {
        throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'publication attempt 不是可安全重检的纯平台前状态', {
          publicationId,
          recoveryMode,
          ...(recovery.blockedReason ? { blockedReason: String(recovery.blockedReason) } : {})
        }, 409);
      }
      const settings = await this.repository.getSettings();
      const root = await realpath(settings.rootDirectory);
      const packageDirectory = path.join(root, 'stores', attempt.storeAliasSnapshot, 'inbox', attempt.sku);
      const productPath = path.join(packageDirectory, 'product.json');
      const intakePath = path.join(packageDirectory, '.ozon-intake.json');
      let productBytes: Buffer;
      let intake: JsonRecord;
      try {
        [productBytes, intake] = await Promise.all([
          readFile(productPath),
          readFile(intakePath, 'utf8').then((raw) => asRecord(JSON.parse(raw)))
        ]);
      } catch {
        const recovery = await this.repository.getPublicationRecoveryArtifact(publicationId);
        const frozenProduct = recovery.materializedProductSnapshot;
        if (!Object.keys(frozenProduct).length
          || String(frozenProduct.contentPolicyVersion || '') !== String(attempt.contentPolicyVersion || '')
          || String(frozenProduct.materialHash || '') !== String(attempt.materialHash || '')
          || String(frozenProduct.materialHashVersion || '') !== String(attempt.materialHashVersion || '')) {
          throw new AppError('OZON_PACKAGE_NOT_FOUND', '原 publication attempt 缺少可证明的冻结商品快照，禁止按当前店铺配置重算', {
            publicationId,
            recoveryMode: 'MANUAL_TAKEOVER'
          }, 409);
        }
        const rebuilt = await writeStorePackage({
          rootDirectory: settings.rootDirectory,
          storeAlias: attempt.storeAliasSnapshot,
          sku: attempt.sku,
          generatedVersionId: attempt.generatedVersionId,
          revision: attempt.revision,
          publicationId,
          jobId: attempt.plannedJobId,
          taskId: attempt.taskId || '',
          storeId: attempt.storeId,
          credentialBindingMode: attempt.credentialBindingMode,
          credentialVersionId: attempt.credentialVersionId,
          storeConfigVersion: attempt.storeConfigVersion,
          warehouseId: attempt.warehouseId,
          planHash: attempt.planHash!,
          contentPolicyVersion: attempt.contentPolicyVersion!,
          materialHash: attempt.materialHash!,
          materialHashVersion: attempt.materialHashVersion!,
          presetRowVersion: attempt.presetRowVersion,
          publicationMode: attempt.publicationMode || 'CREATE_ONLY',
          materializationHash: attempt.materializationHash,
          offerContractHash: attempt.offerContractHash,
          product: frozenProduct
        });
        return this.repository.materializePublicationAttempt({
          publicationId,
          jobId: attempt.plannedJobId,
          planHash: attempt.planHash!,
          materializationHash: attempt.materializationHash,
          packageRelPath: rebuilt.packageRelPath,
          packageSignature: rebuilt.packageSignature,
          productJsonPath: rebuilt.productJsonPath
        });
      }
      const signature = sha256Bytes(productBytes);
      const mismatches = [
        ['publicationId', publicationId],
        ['jobId', attempt.plannedJobId],
        ['planHash', attempt.planHash],
        ['materializationHash', attempt.materializationHash],
        ['contentPolicyVersion', attempt.contentPolicyVersion],
        ['materialHash', attempt.materialHash],
        ['materialHashVersion', attempt.materialHashVersion],
        ['productContentHash', signature]
      ].filter(([key, value]) => String(intake[String(key)] ?? '') !== String(value ?? '')).map(([key]) => key);
      if (mismatches.length) {
        throw new AppError('VERSION_CONFLICT', '原 publication attempt 发布包与冻结合同不一致', {
          publicationId, mismatches
        }, 409);
      }
      return this.repository.materializePublicationAttempt({
        publicationId,
        jobId: attempt.plannedJobId,
        planHash: attempt.planHash!,
        materializationHash: attempt.materializationHash,
        packageRelPath: path.posix.join('stores', attempt.storeAliasSnapshot, 'inbox', attempt.sku),
        packageSignature: signature,
        productJsonPath: productPath
      });
    }
    const settings = await this.repository.getSettings();
    if (!settings.publicationReadbackEnabled || !settings.adminApiWebhookUrl) {
      throw new AppError('OZON_READBACK_DISPATCH_UNAVAILABLE', 'OZON publication 只读回查尚未通过受控 fleet capability 门禁', {
        publicationId, deliveryState: 'NOT_SENT', publicationReadbackEnabled: false
      }, 409);
    }
    const context = await this.repository.beginPublicationReadback(publicationId, parsed.data.rowVersion);
    try {
      const response = await postPublicationReadback(settings.adminApiWebhookUrl, {
        action: 'productStatus',
        requestRef: context.requestRef,
        taskId: context.taskId,
        publicationId,
        offerIds: context.publication.offerIds
      });
      const normalized = normalizeOzonPlatformStatusRefresh({
        leaseToken: context.requestRef,
        leaseExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        listing: context.listing,
        storeAlias: context.publication.storeAliasSnapshot,
        offerIds: context.publication.offerIds,
        mappings: context.mappings
      }, response);
      return this.repository.completePublicationReadback({
        publicationId,
        dispatchRowVersion: context.dispatchRowVersion,
        requestRef: context.requestRef,
        ...normalized
      });
    } catch (error) {
      const failure = publicationReadbackFailure(error);
      await this.repository.failPublicationReadback({
        publicationId,
        dispatchRowVersion: context.dispatchRowVersion,
        requestRef: context.requestRef,
        ...failure
      });
      throw new AppError(failure.errorCode, failure.errorMessage, {
        publicationId,
        deliveryState: failure.deliveryState,
        retryClass: failure.retryClass,
        ...(failure.statusCode ? { statusCode: failure.statusCode } : {})
      }, failure.statusCode === 429 ? 429 : 502);
    }
  }

  async republishPublication(publicationId: string, input: unknown) {
    const parsed = ozonPublicationMutationSchema.safeParse(input);
    if (!parsed.success) throw validationError('缺少有效的 publication rowVersion', parsed.error.issues);
    const base = await this.repository.getPublication(publicationId);
    if (base.rowVersion !== parsed.data.rowVersion) {
      throw new AppError('VERSION_CONFLICT', 'OZON publication 已变化，请刷新后重试', {
        expected: parsed.data.rowVersion,
        actual: base.rowVersion
      }, 409);
    }
    const current = await this.repository.getCurrentListingVersion(base.sku);
    if (current.revision <= base.revision || current.generatedVersionId === base.generatedVersionId) {
      throw new AppError(
        'VERSION_CONFLICT',
        '重新上品必须先生成更新的 OZON 草稿版本；同一 revision 只能执行明确未送达的内部安全重试',
        {
          publicationId,
          currentRevision: current.revision,
          publicationRevision: base.revision,
          generatedVersionId: current.generatedVersionId
        },
        409
      );
    }
    const built = await this.buildPlan(base.sku, {
      draftVersion: current.draftVersion,
      storeIds: [base.storeId]
    });
    const blocked = built.plan.items.filter((item) => !item.ready);
    if (blocked.length) {
      throw new AppError('OZON_STORE_NOT_READY', 'OZON 店铺尚未满足重新上品条件', {
        stores: blocked.map((item) => ({ storeId: item.storeId, blockers: item.blockers }))
      }, 409);
    }
    const created = await this.createFromBuiltPlan(built, 'MANUAL');
    const publication = created.publications[0];
    if (!publication) {
      throw new AppError('OZON_PUBLICATION_CREATE_FAILED', created.failures[0]?.message || 'OZON 新 revision publication 创建失败', {
        failures: created.failures
      }, 409);
    }
    return publication;
  }

  async compatibleAppendPlan(publicationId: string) {
    return { plan: (await this.buildCompatibleAppend(publicationId)).plan };
  }

  async compatibleAppend(publicationId: string, input: unknown): Promise<{ publication: OzonStorePublication }> {
    const parsed = ozonPublicationCompatibleAppendSchema.safeParse(input);
    if (!parsed.success) throw validationError('无效的 OZON publication 兼容追加请求', parsed.error.issues);
    const built = await this.buildCompatibleAppend(publicationId, parsed.data.rowVersion);
    if (!built.plan.ready) {
      throw new AppError('OZON_STORE_NOT_READY', 'OZON publication 兼容追加尚未就绪', { blockers: built.plan.blockers }, 409);
    }
    if (built.plan.planHash !== parsed.data.planHash) {
      throw new AppError('VERSION_CONFLICT', 'OZON publication 兼容追加计划已变化', {
        expectedPlanHash: parsed.data.planHash,
        currentPlanHash: built.plan.planHash
      }, 409);
    }
    const result = await this.createFromBuiltPlan(built.built, 'MANUAL');
    const publication = result.publications[0];
    if (!publication) {
      throw new AppError('OZON_PUBLICATION_CREATE_FAILED', result.failures[0]?.message || 'OZON publication 兼容追加创建失败', {
        failures: result.failures
      }, 409);
    }
    return { publication };
  }

  async claimRuntimeJobs(input: unknown) {
    const parsed = ozonRuntimeClaimSchema.safeParse(input);
    if (!parsed.success) throw validationError('无效的 OZON runtime claim 请求', parsed.error.issues);
    const settings = await this.repository.getSettings();
    const runtimeRoot = strictRuntimeRoot(settings.rootDirectory);
    const items = await this.repository.claimRuntimeJobs(parsed.data);
    return ozonRuntimeClaimResultSchema.parse({
      items: items.map((job) => withAuthoritativeRuntimePaths(job, runtimeRoot)),
      globalConcurrency: 2,
      perStoreConcurrency: 1
    });
  }

  async claimDuePreflights(input: unknown) {
    const parsed = ozonRuntimePreflightClaimSchema.safeParse(input);
    if (!parsed.success) throw validationError('无效的 OZON 到期预检 claim 请求', parsed.error.issues);
    return { stores: await this.repository.claimDuePreflights(parsed.data) };
  }

  decryptGatewayCredential(credential: Parameters<OzonCredentialVault['decrypt']>[0], storeId: string, credentialVersionId: string) {
    return this.vault.decrypt(credential, storeId, credentialVersionId);
  }

  async verifyIntake(input: unknown) {
    const parsed = ozonIntakeVerifySchema.safeParse(input);
    if (!parsed.success) throw validationError('无效的 OZON intake 验证请求', parsed.error.issues);
    const signed = {
      schemaVersion: 1,
      jobId: parsed.data.jobId,
      taskId: parsed.data.taskId,
      storeId: parsed.data.storeId,
      storeAlias: parsed.data.storeAlias,
      publicationId: parsed.data.publicationId,
      credentialVersionId: parsed.data.credentialVersionId,
      credentialBindingMode: parsed.data.credentialBindingMode,
      storeConfigVersion: parsed.data.storeConfigVersion,
      warehouseId: parsed.data.warehouseId,
      sku: parsed.data.sku,
      revision: parsed.data.revision,
      planHash: parsed.data.planHash,
      contentPolicyVersion: parsed.data.contentPolicyVersion,
      materialHash: parsed.data.materialHash,
      materialHashVersion: parsed.data.materialHashVersion,
      presetRowVersion: parsed.data.presetRowVersion ?? null,
      publicationMode: parsed.data.publicationMode,
      materializationHash: parsed.data.materializationHash,
      offerContractHash: parsed.data.offerContractHash,
      productContentHash: parsed.data.productContentHash
    };
    const expected = signIntakeTicket(signed);
    if (!safeOzonSignatureEqual(expected, parsed.data.ticket)) {
      throw new AppError('AUTH_INVALID', 'OZON intake 票据签名无效', undefined, 401);
    }
    const identity = await this.repository.verifyIntake(parsed.data);
    return { verified: true as const, identity };
  }

  private async buildCompatibleAppend(publicationId: string, expectedRowVersion?: number): Promise<{
    plan: { planHash: string; ready: boolean; blockers: string[]; newOfferIds: string[]; createdAt: string };
    built: BuiltPlan;
  }> {
    const base = await this.repository.getPublication(publicationId);
    if (expectedRowVersion !== undefined && base.rowVersion !== expectedRowVersion) {
      throw new AppError('VERSION_CONFLICT', 'OZON publication 已被其他操作修改', {
        expected: expectedRowVersion,
        actual: base.rowVersion
      }, 409);
    }
    const listing = await this.ozon.getListing(base.sku);
    const full = await this.buildPlan(base.sku, { draftVersion: listing.rowVersion, storeIds: [base.storeId] });
    const fullItem = full.plan.items[0]!;
    const preservedOfferIds = await this.repository.getSuccessfulOfferUnion(base.storeId, base.sku);
    const preserved = new Set([...preservedOfferIds, ...base.offerIds]);
    const newOfferIds = fullItem.offerIds.filter((offerId) => !preserved.has(offerId));
    const blockers = [...fullItem.blockers];
    if (base.status !== 'SUCCEEDED') blockers.push('只能向已成功 publication 追加新 Offer');
    if (!newOfferIds.length) blockers.push('当前生成版本没有可追加的新 Offer');
    const fullProduct = full.productByStore.get(base.storeId)!;
    const appendProduct = {
      ...fullProduct,
      offers: asArray(fullProduct.offers).filter((entry) => newOfferIds.includes(String(asRecord(entry).offerId || '')))
    };
    const parsedProduct = newOfferIds.length ? ozonProductSchema.safeParse(appendProduct) : undefined;
    if (parsedProduct && !parsedProduct.success) blockers.push('OZON 兼容追加新 Offer 物化合同无效');
    const offerContractHash = sha256({
      storeId: base.storeId,
      generatedVersionId: full.plan.generatedVersionId,
      offerIds: [...newOfferIds].sort(),
      appendFromPublicationId: base.id
    });
    const materializationHash = sha256({
      baseMaterializationHash: fullItem.materializationHash,
      variantColorAuthorityHash: full.plan.variantColorAuthority.hash,
      appendFromPublicationId: base.id,
      product: stableMaterial(appendProduct),
      offerContractHash
    });
    const item = {
      ...fullItem,
      ready: blockers.length === 0,
      blockers,
      offerIds: newOfferIds,
      offerContractHash,
      materializationHash
    };
    const createdAt = new Date().toISOString();
    const planHash = sha256({
      publicationId: base.id,
      publicationRowVersion: base.rowVersion,
      generatedVersionId: full.plan.generatedVersionId,
      storeId: base.storeId,
      preservedOfferIds: [...preserved].sort(),
      newOfferIds,
      variantColorAuthorityHash: full.plan.variantColorAuthority.hash,
      offerContractHash,
      materializationHash
    });
    return {
      plan: { planHash, ready: blockers.length === 0, blockers, newOfferIds, createdAt },
      built: {
        context: { ...full.context, offerIds: newOfferIds },
        productByStore: new Map([[base.storeId, appendProduct]]),
        modeEvidenceByStore: full.modeEvidenceByStore,
        settingsContract: full.settingsContract,
        plan: { ...full.plan, planHash, createdAt, items: [item] }
      }
    };
  }

  private async buildPlan(
    sku: string,
    input: OzonPublicationPlanInput,
    options: { prepareSharedSource?: boolean; readOnly?: boolean; retryTransientTranslation?: boolean } = {}
  ): Promise<BuiltPlan> {
    const [context, settings] = await Promise.all([
      this.repository.getPlanningContext(sku, input.draftVersion, input.storeIds, { readOnly: options.readOnly === true }),
      this.repository.getSettings()
    ]);
    if (!settings.rootDirectory) throw new AppError('CONFIG_INVALID', '尚未配置 OZON 根目录', undefined, 409);
    let variantColorAuthority = createOzonVariantColorAuthority([]);
    let variantColorAuthorityError: AppError | undefined;
    try {
      variantColorAuthority = await this.publishing.resolveVariantColorAuthority(context.sku, context.draftVersion);
    } catch (error) {
      variantColorAuthorityError = error instanceof AppError
        ? error
        : new AppError('OZON_VARIANT_COLOR_INCOMPATIBLE', 'E001 OZON 颜色权威快照读取失败', undefined, 409);
    }
    const productByStore = new Map<string, JsonRecord>();
    const transientTranslationErrors: AppError[] = [];
    let sharedSourceCandidate: { product: JsonRecord; sourceDirectory: string } | undefined;
    const fleetReady = fleetCapabilityReady();
    const items = await Promise.all(context.stores.map(async (store) => {
      const blockers = [...store.readiness.blockers];
      let errorCode = variantColorAuthorityError?.code;
      let errorDetails = variantColorAuthorityError
        ? {
            ...(variantColorAuthorityError.details || {}),
            storeId: store.id,
            storeAlias: store.storeAlias,
            storeDisplayName: store.displayName
          }
        : undefined;
      if (variantColorAuthorityError) blockers.push(variantColorAuthorityError.message);
      if (context.contentPolicyVersion === 'LEGACY_UNKNOWN' || !context.materialHash
        || context.materialHashVersion !== OZON_SHARED_MATERIAL_HASH_VERSION) {
        blockers.push('OZON 公共素材稳定版本缺少可证明的内容策略或素材哈希');
      }
      if (!settings.enabled) blockers.push('OZON 总开关未启用');
      if (!store.enabled) blockers.push('OZON 店铺未启用');
      if (!fleetReady) {
        blockers.push('OZON publication 调度 capability 尚未受控开启；仅保留历史任务只读收尾');
      }
      const presetDefinitionHash = store.presetSnapshot ? sha256(stablePresetMaterial(store.presetSnapshot)) : undefined;
      let product: JsonRecord | undefined;
      if (!store.defaultPresetId || !store.presetSnapshot || !store.presetRowVersion || !store.presetName) {
        blockers.push('店铺缺少有效的默认上品预设');
      } else {
        try {
          const generated = await this.publishing.buildStorePresetProduct(
            context.sku,
            context.draftVersion,
            store.presetSnapshot,
            store.accountCurrency,
            { id: store.defaultPresetId, name: store.presetName, rowVersion: store.presetRowVersion },
            variantColorAuthority
          );
          if (generated.listing.revision !== context.revision) {
            throw new AppError('VERSION_CONFLICT', 'OZON 公共素材修订已变化，请重新生成发布计划', {
              expected: context.revision,
              actual: generated.listing.revision
            }, 409);
          }
          product = {
            ...applyOzonStoreScopedProductFields(generated.productJson as unknown as JsonRecord, store, settings),
            contentPolicyVersion: context.contentPolicyVersion,
            materialHash: context.materialHash,
            materialHashVersion: 'ozon-shared-material-v1'
          };
          const validated = ozonProductSchema.safeParse(product);
          if (!validated.success) throw validationError(`OZON 店铺 ${store.storeAlias} 物化 product.json 无效`, validated.error.issues);
          product = validated.data as unknown as JsonRecord;
          productByStore.set(store.id, product);
          sharedSourceCandidate ||= {
            product: generated.productJson as unknown as JsonRecord,
            sourceDirectory: generated.sourceMediaDirectory
          };
        } catch (error) {
          if (options.retryTransientTranslation && isRetryableOzonTitleTranslationError(error)) {
            transientTranslationErrors.push(error);
          }
          if (error instanceof AppError) {
            errorCode = error.code;
            errorDetails = {
              ...(error.details || {}),
              storeId: store.id,
              storeAlias: store.storeAlias,
              storeDisplayName: store.displayName
            };
          }
          blockers.push(error instanceof Error ? error.message : 'OZON 店铺商品物化失败');
        }
      }
      const offerIds = product ? asArray(product.offers).map((offer) => String(asRecord(offer).offerId || '')).filter(Boolean) : [];
      const offerContractHash = sha256({
        storeId: store.id,
        generatedVersionId: context.generatedVersionId,
        offerIds: [...offerIds].sort()
      });
      const materializationHash = sha256({
        contentPolicyVersion: context.contentPolicyVersion,
        materialHash: context.materialHash,
        materialHashVersion: context.materialHashVersion,
        sourceMediaIdentityHash: context.sourceMediaIdentityHash,
        product: product ? stableMaterial(product) : null,
        variantColorAuthorityHash: variantColorAuthority.hash,
        blockers: [...new Set(blockers)],
        storeId: store.id,
        storeConfigVersion: store.configVersion,
        credentialVersionId: store.credential.activeVersionId || null,
        presetId: store.defaultPresetId || null,
        presetDefinitionHash: presetDefinitionHash || null,
        warehouseId: store.warehouseId,
        fulfillmentMode: store.fulfillmentMode,
        accountCurrency: store.accountCurrency,
        offerContractHash
      });
      const publicationId = deterministicUuid('ozon-publication', context.generatedVersionId, store.id);
      const plannedJobId = deterministicUuid('ozon-publication-job', context.generatedVersionId, store.id);
      return {
        storeId: store.id,
        storeAlias: store.storeAlias,
        displayName: store.displayName,
        ...(store.defaultPresetId ? { presetId: store.defaultPresetId } : {}),
        ...(store.presetRowVersion ? { presetRowVersion: store.presetRowVersion } : {}),
        ...(presetDefinitionHash ? { presetDefinitionHash } : {}),
        contentPolicyVersion: context.contentPolicyVersion,
        materialHash: context.materialHash,
        publicationMode: store.autoPublishMode,
        ready: blockers.length === 0,
        blockers,
        ...(errorCode ? { errorCode } : {}),
        ...(errorDetails ? { errorDetails } : {}),
        storeRowVersion: store.rowVersion,
        storeConfigVersion: store.configVersion,
        ...(store.credential.activeVersionId ? { credentialVersionId: store.credential.activeVersionId } : {}),
        credentialBindingMode: store.credential.bindingMode,
        warehouseId: store.warehouseId,
        warehouseName: store.warehouseName,
        fulfillmentMode: store.fulfillmentMode,
        accountCurrency: store.accountCurrency,
        offerIds,
        offerContractHash,
        materializationHash,
        publicationId,
        jobId: plannedJobId,
        plannedJobId,
        taskId: `${store.storeAlias}__${context.sku}__r${context.revision}`
      };
    }));
    // Wait for all store materializations before returning an error. No failed
    // plan/publications or shared-source files may be frozen for a startup outage.
    const transientTranslation = transientTranslationErrors[0];
    if (transientTranslation) {
      throw new OzonNetworkRequestError({
        code: String(transientTranslation.details?.errorCode),
        message: transientTranslation.message,
        deliveryState: 'NOT_SENT', // Planning has not submitted anything to OZON.
        cause: transientTranslation
      });
    }
    if (sharedSourceCandidate && options.prepareSharedSource !== false) {
      await prepareSharedSource(settings.rootDirectory, context, async () => sharedSourceCandidate!);
    }
    const built: BuiltPlan = {
      context,
      productByStore,
      modeEvidenceByStore: new Map(),
      settingsContract: {
        rowVersion: settings.rowVersion,
        rootDirectoryHash: sha256(settings.rootDirectory)
      },
      plan: {
        planHash: '',
        sku: context.sku,
        draftVersion: context.draftVersion,
        generatedVersionId: context.generatedVersionId,
        revision: context.revision,
        contentPolicyVersion: context.contentPolicyVersion as OzonPublicationPlan['contentPolicyVersion'],
        materialHash: context.materialHash,
        materialHashVersion: OZON_SHARED_MATERIAL_HASH_VERSION,
        sourceMediaIdentityHash: context.sourceMediaIdentityHash,
        variantColorAuthority,
        createdAt: new Date().toISOString(),
        items
      }
    };
    await this.applyPublicationModes(built);
    built.plan.planHash = sha256(publicationPlanCanonical(
      context,
      settings.rowVersion,
      built.settingsContract.rootDirectoryHash,
      items,
      built.modeEvidenceByStore,
      variantColorAuthority
    ));
    return built;
  }
}

function frozenAutomaticBuiltPlan(input: unknown): BuiltPlan {
  const frozen = asRecord(input);
  const schemaVersion = Number(frozen.schemaVersion);
  const sourceMediaIdentityHash = String(frozen.sourceMediaIdentityHash || '');
  const hasSourceMediaIdentity = /^sha256:[a-f0-9]{64}$/.test(sourceMediaIdentityHash);
  const storesInput = asArray(frozen.stores);
  const itemsInput = asArray(frozen.items);
  const contractHash = String(frozen.frozenContractHash || '');
  const unsigned = { ...frozen };
  delete unsigned.frozenContractHash;
  if (![2, 3].includes(schemaVersion)
    || !/^sha256:[a-f0-9]{64}$/.test(String(frozen.planHash || ''))
    || !/^sha256:[a-f0-9]{64}$/.test(String(frozen.materialHash || ''))
    || (schemaVersion === 3 && !hasSourceMediaIdentity)
    || frozen.materialHashVersion !== OZON_SHARED_MATERIAL_HASH_VERSION
    || !['merchroute-ozon-content-v2', 'merchroute-ozon-content-v3', 'merchroute-ozon-content-v4'].includes(String(frozen.contentPolicyVersion || ''))
    || !Number.isInteger(Number(frozen.settingsRowVersion))
    || Number(frozen.settingsRowVersion) < 1
    || !/^sha256:[a-f0-9]{64}$/.test(String(frozen.rootDirectoryHash || ''))
    || !itemsInput.length
    || itemsInput.length !== storesInput.length
    || !/^sha256:[a-f0-9]{64}$/.test(contractHash)
    || sha256(unsigned) !== contractHash) {
    throw new AppError('VERSION_CONFLICT', 'OZON 冻结 fan-out 合同不完整或签名已漂移', undefined, 409);
  }
  const variantColorAuthority = assertOzonVariantColorAuthority(
    frozen.variantColorAuthority as unknown as OzonVariantColorAuthority
  );
  const itemByStore = new Map<string, OzonPublicationPlan['items'][number]>();
  for (const entry of itemsInput) {
    const item = asRecord(entry) as unknown as OzonPublicationPlan['items'][number];
    const storeId = String(item.storeId || '');
    if (!storeId || itemByStore.has(storeId)
      || !String(item.publicationId || '')
      || !String(item.jobId || '')
      || !String(item.plannedJobId || '')
      || item.jobId !== item.plannedJobId
      || !String(item.taskId || '')
      || !/^sha256:[a-f0-9]{64}$/.test(String(item.materializationHash || ''))
      || !/^sha256:[a-f0-9]{64}$/.test(String(item.offerContractHash || ''))
      || !['CREATE_ONLY', 'COMPATIBLE_UPSERT'].includes(String(item.publicationMode || ''))) {
      throw new AppError('VERSION_CONFLICT', 'OZON 冻结 fan-out 子任务身份不完整', { storeId }, 409);
    }
    itemByStore.set(storeId, structuredClone(item));
  }
  const stores: OzonPublicationPlanningContext['stores'] = [];
  const productByStore = new Map<string, JsonRecord>();
  const modeEvidenceByStore = new Map<string, OzonPublicationModeEvidence>();
  for (const entry of storesInput) {
    const frozenStore = asRecord(entry);
    const storeId = String(frozenStore.storeId || '');
    const item = itemByStore.get(storeId);
    const store = asRecord(frozenStore.storeSnapshot) as unknown as OzonPublicationPlanningContext['stores'][number];
    const product = structuredClone(asRecord(frozenStore.productSnapshot));
    const modeEvidenceInput = asRecord(frozenStore.modeEvidence);
    const preservedOfferIds = [...new Set(asArray(modeEvidenceInput.preservedOfferIds).map(String).filter(Boolean))].sort();
    const modeEvidence: OzonPublicationModeEvidence = {
      preservedOfferIds,
      evidenceHash: String(modeEvidenceInput.evidenceHash || '')
    };
    if (!item || String(store.id || '') !== storeId
      || String(store.storeAlias || '') !== String(item.storeAlias || '')
      || Number(store.rowVersion || 0) !== Number(item.storeRowVersion || 0)
      || Number(store.configVersion || 0) !== Number(item.storeConfigVersion || 0)
      || String(store.credential?.bindingMode || '') !== String(item.credentialBindingMode || '')
      || String(store.credential?.activeVersionId || '') !== String(item.credentialVersionId || '')
      || String(store.defaultPresetId || '') !== String(item.presetId || '')
      || Number(store.presetRowVersion || 0) !== Number(item.presetRowVersion || 0)
      || String(store.warehouseId || '') !== String(item.warehouseId || '')
      || String(store.fulfillmentMode || '') !== String(item.fulfillmentMode || '')
      || String(store.accountCurrency || '') !== String(item.accountCurrency || '')
      || String(store.autoPublishMode || '') !== String(item.publicationMode || '')
      || sha256(stableMaterial(product)) !== String(frozenStore.productSnapshotHash || '')
      || modeEvidence.evidenceHash !== publicationModeEvidenceHash(
        storeId,
        String(frozen.sku || ''),
        item.publicationMode,
        preservedOfferIds
      )) {
      throw new AppError('VERSION_CONFLICT', 'OZON 冻结 fan-out 店铺或商品快照已漂移', { storeId }, 409);
    }
    if (item.presetDefinitionHash
      && sha256(stablePresetMaterial(asRecord(store.presetSnapshot))) !== item.presetDefinitionHash) {
      throw new AppError('VERSION_CONFLICT', 'OZON 冻结 fan-out 预设快照已漂移', { storeId }, 409);
    }
    if (item.ready) {
      const parsedProduct = ozonProductSchema.safeParse(product);
      if (!parsedProduct.success
        || String(product.contentPolicyVersion || '') !== String(frozen.contentPolicyVersion || '')
        || String(product.materialHash || '') !== String(frozen.materialHash || '')
        || String(product.materialHashVersion || '') !== String(frozen.materialHashVersion || '')) {
        throw new AppError('VERSION_CONFLICT', 'OZON 冻结 fan-out 商品合同不可证明', {
          storeId,
          issues: parsedProduct.success ? undefined : parsedProduct.error.issues
        }, 409);
      }
    }
    stores.push(structuredClone(store));
    productByStore.set(storeId, product);
    modeEvidenceByStore.set(storeId, modeEvidence);
  }
  const items = [...itemByStore.values()];
  const canonical = publicationPlanCanonical({
    sku: String(frozen.sku || ''),
    draftVersion: Number(frozen.draftVersion),
    generatedVersionId: String(frozen.generatedVersionId || ''),
    revision: Number(frozen.revision),
    contentPolicyVersion: String(frozen.contentPolicyVersion || ''),
    materialHash: String(frozen.materialHash || ''),
    materialHashVersion: String(frozen.materialHashVersion || ''),
    sourceMediaIdentityHash
  }, Number(frozen.settingsRowVersion), String(frozen.rootDirectoryHash), items, modeEvidenceByStore, variantColorAuthority,
  hasSourceMediaIdentity);
  if (sha256(canonical) !== frozen.planHash) {
    throw new AppError('VERSION_CONFLICT', 'OZON 冻结 fan-out planHash 与固定子任务不一致', undefined, 409);
  }
  const plan: OzonPublicationPlan = {
    planHash: String(frozen.planHash),
    contentPolicyVersion: String(frozen.contentPolicyVersion) as OzonPublicationPlan['contentPolicyVersion'],
    materialHash: String(frozen.materialHash),
    materialHashVersion: OZON_SHARED_MATERIAL_HASH_VERSION,
    sourceMediaIdentityHash,
    variantColorAuthority,
    sku: String(frozen.sku),
    draftVersion: Number(frozen.draftVersion),
    generatedVersionId: String(frozen.generatedVersionId),
    revision: Number(frozen.revision),
    createdAt: String(frozen.createdAt || ''),
    items
  };
  return {
    plan,
    context: {
      sku: plan.sku,
      draftVersion: plan.draftVersion,
      generatedVersionId: plan.generatedVersionId,
      revision: plan.revision,
      contentPolicyVersion: plan.contentPolicyVersion,
      materialHash: plan.materialHash,
      materialHashVersion: plan.materialHashVersion,
      sourceMediaIdentityHash: plan.sourceMediaIdentityHash,
      listingStatus: 'FROZEN',
      listingSnapshot: {},
      materialOverrides: {},
      offerIds: [...new Set(items.flatMap((item) => item.offerIds))],
      stores
    },
    productByStore,
    modeEvidenceByStore,
    settingsContract: {
      rowVersion: Number(frozen.settingsRowVersion),
      rootDirectoryHash: String(frozen.rootDirectoryHash)
    }
  };
}

function publicationPlanCanonical(
  context: Pick<OzonPublicationPlanningContext,
    'sku' | 'draftVersion' | 'generatedVersionId' | 'revision' | 'contentPolicyVersion' | 'materialHash' | 'materialHashVersion' | 'sourceMediaIdentityHash'>,
  settingsRowVersion: number,
  rootDirectoryHash: string,
  items: OzonPublicationPlan['items'],
  modeEvidenceByStore: Map<string, OzonPublicationModeEvidence>,
  variantColorAuthority: OzonVariantColorAuthority,
  includeSourceMediaIdentityHash = true
): JsonRecord {
  return {
    sku: context.sku,
    draftVersion: context.draftVersion,
    generatedVersionId: context.generatedVersionId,
    revision: context.revision,
    contentPolicyVersion: context.contentPolicyVersion,
    materialHash: context.materialHash,
    materialHashVersion: context.materialHashVersion,
    ...(includeSourceMediaIdentityHash ? { sourceMediaIdentityHash: context.sourceMediaIdentityHash } : {}),
    variantColorAuthority,
    settingsRowVersion,
    rootDirectoryHash,
    items: items.map((item) => ({
      storeId: item.storeId,
      storeAlias: item.storeAlias,
      storeRowVersion: item.storeRowVersion,
      storeConfigVersion: item.storeConfigVersion,
      credentialVersionId: item.credentialVersionId || null,
      credentialBindingMode: item.credentialBindingMode,
      presetId: item.presetId || null,
      presetRowVersion: item.presetRowVersion || null,
      presetDefinitionHash: item.presetDefinitionHash || null,
      publicationMode: item.publicationMode,
      publicationId: item.publicationId,
      jobId: item.jobId,
      plannedJobId: item.plannedJobId,
      taskId: item.taskId,
      warehouseId: item.warehouseId,
      fulfillmentMode: item.fulfillmentMode,
      accountCurrency: item.accountCurrency,
      ready: item.ready,
      blockers: [...item.blockers],
      errorCode: item.errorCode || null,
      errorDetails: item.errorDetails || null,
      offerIds: [...item.offerIds],
      offerContractHash: item.offerContractHash,
      materializationHash: item.materializationHash,
      modeEvidence: modeEvidenceByStore.get(item.storeId) || null
    })).sort((left, right) => left.storeId.localeCompare(right.storeId))
  };
}

function publicationModeEvidenceHash(
  storeId: string,
  sku: string,
  publicationMode: 'CREATE_ONLY' | 'COMPATIBLE_UPSERT',
  preservedOfferIds: string[]
): string {
  return sha256({ storeId, sku, publicationMode, preservedOfferIds: [...preservedOfferIds].sort() });
}

function assertBuiltPlanSettingsContract(
  settings: Awaited<ReturnType<OzonStoreRepository['getSettings']>>,
  contract: BuiltPlan['settingsContract']
): void {
  if (settings.rowVersion !== contract.rowVersion
    || sha256(settings.rootDirectory) !== contract.rootDirectoryHash) {
    throw new AppError('VERSION_CONFLICT', 'OZON 公共设置或发布根目录已偏离冻结计划', {
      expectedRowVersion: contract.rowVersion,
      actualRowVersion: settings.rowVersion
    }, 409);
  }
}

export function materializeProduct(
  source: JsonRecord,
  store: OzonStore & { presetSnapshot?: JsonRecord },
  settings: Awaited<ReturnType<OzonStoreRepository['getSettings']>>,
  offerIds: string[],
  materialOverrides: JsonRecord = {},
  presetPrices?: OzonStorePresetPrices
): JsonRecord {
  const product = applyOzonStoreScopedProductFields(source, store, settings);
  const preset = store.presetSnapshot || {};
  if (preset.vat !== undefined) product.vat = preset.vat;
  if (preset.dimensions !== undefined) product.dimensions = preset.dimensions;
  if (preset.sharedAttributes !== undefined) product.sharedAttributes = preset.sharedAttributes;
  if (materialOverrides.vat !== undefined) product.vat = structuredClone(materialOverrides.vat);
  if (materialOverrides.dimensions !== undefined) product.dimensions = structuredClone(materialOverrides.dimensions);
  if (materialOverrides.sharedAttributes !== undefined) product.sharedAttributes = structuredClone(materialOverrides.sharedAttributes);
  if (materialOverrides.videoUploadMode !== undefined) product.videoUploadMode = materialOverrides.videoUploadMode;
  if (materialOverrides.purchaseMeasurements !== undefined) product.purchaseMeasurements = structuredClone(materialOverrides.purchaseMeasurements);
  product.sharedAttributes = normalizeOzonNoBrandAttributeForPlatform(
    asArray(product.sharedAttributes) as Parameters<typeof normalizeOzonNoBrandAttributeForPlatform>[0]
  );
  const offerOverrides = new Map(asArray(materialOverrides.offerOverrides).map((entry) => {
    const row = asRecord(entry);
    return [String(row.offerId || ''), row] as const;
  }).filter(([offerId]) => offerId));
  const selected = new Set(offerIds);
  product.offers = asArray(product.offers).filter((entry) => selected.has(String(asRecord(entry).offerId || '')))
    .map((entry) => {
      const offer = asRecord(entry);
      const override = offerOverrides.get(String(offer.offerId || '')) || {};
      return materializeOfferForStore(
        offer,
        presetPrices,
        preset.defaultStock,
        override,
        store.accountCurrency
      );
    });
  const parsed = ozonProductSchema.safeParse(product);
  if (!parsed.success) throw validationError(`OZON 店铺 ${store.storeAlias} 物化 product.json 无效`, parsed.error.issues);
  return parsed.data as unknown as JsonRecord;
}

export function applyOzonStoreScopedProductFields(
  source: JsonRecord,
  store: Pick<OzonStore, 'storeAlias' | 'warehouseId' | 'fulfillmentMode' | 'accountCurrency'>,
  settings: Pick<Awaited<ReturnType<OzonStoreRepository['getSettings']>>,
    'imageUploadConcurrency' | 'videoUploadConcurrency' | 'videoPrewarmEnabled'>
): JsonRecord {
  const product = structuredClone(source);
  product.storeAlias = store.storeAlias;
  product.warehouseId = store.warehouseId;
  product.fulfillmentMode = store.fulfillmentMode;
  product.currency = store.accountCurrency;
  product.mediaSourceRoot = '';
  product.runtime = {
    ...asRecord(product.runtime),
    imageUploadConcurrency: settings.imageUploadConcurrency,
    videoUploadConcurrency: settings.videoUploadConcurrency,
    videoPrewarmEnabled: settings.videoPrewarmEnabled
  };
  return product;
}

async function readSourceProductAt(
  sourceDirectory: string,
  sku: string,
  revision: number,
  _offerIds: string[],
  generatedVersionId?: string
): Promise<JsonRecord> {
  const productJsonPath = await realpath(path.join(sourceDirectory, 'product.json'));
  assertInside(sourceDirectory, productJsonPath, 'OZON 共享源 product.json');
  const productBytes = await readFile(productJsonPath);
  const parsedJson = JSON.parse(productBytes.toString('utf8')) as unknown;
  const parsed = ozonProductSchema.safeParse(parsedJson);
  if (!parsed.success) throw validationError('OZON 共享源 product.json 无效', parsed.error.issues);
  if (parsed.data.productCode !== sku) {
    throw new AppError('VERSION_CONFLICT', 'OZON product.json SKU 与生成版本路径不一致', {
      expected: sku,
      actual: parsed.data.productCode
    }, 409);
  }
  if (parsed.data.revision !== revision) {
    throw new AppError('VERSION_CONFLICT', 'OZON product.json 修订版本已变化，请重新生成', {
      expected: revision,
      actual: parsed.data.revision
    }, 409);
  }
  if (generatedVersionId) {
    let marker: JsonRecord;
    try {
      const markerPath = await realpath(path.join(sourceDirectory, '.ozon-shared-source.json'));
      assertInside(sourceDirectory, markerPath, 'OZON 共享源完整性标记');
      marker = asRecord(JSON.parse(await readFile(markerPath, 'utf8')));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('VERSION_CONFLICT', 'OZON 共享生成版本缺少有效的完整性标记', {
        sku,
        generatedVersionId
      }, 409);
    }
    const actualHash = sha256Bytes(productBytes);
    const signedMarker = {
      schemaVersion: 1,
      sku,
      revision,
      generatedVersionId,
      productContentHash: actualHash,
      importedFrom: 'GENERATED_VERSION_SNAPSHOT'
    };
    const markerSignature = String(marker.integritySignature || '');
    if (Number(marker.schemaVersion) !== signedMarker.schemaVersion
      || String(marker.sku || '') !== signedMarker.sku
      || Number(marker.revision) !== signedMarker.revision
      || String(marker.generatedVersionId || '') !== signedMarker.generatedVersionId
      || String(marker.productContentHash || '') !== signedMarker.productContentHash
      || String(marker.importedFrom || '') !== signedMarker.importedFrom
      || !safeOzonSignatureEqual(signSharedSourceMarker(signedMarker), markerSignature)) {
      throw new AppError('VERSION_CONFLICT', 'OZON 共享生成版本完整性校验失败', {
        sku,
        generatedVersionId
      }, 409);
    }
  }
  return parsed.data as unknown as JsonRecord;
}

export async function prepareSharedSource(
  rootDirectory: string,
  context: OzonPublicationPlanningContext,
  buildFresh: () => Promise<{ product: JsonRecord; sourceDirectory: string }>
): Promise<JsonRecord> {
  return withOzonSourceMediaSkuLock(context.sku, () => prepareSharedSourceLocked(rootDirectory, context, buildFresh));
}

async function prepareSharedSourceLocked(
  rootDirectory: string,
  context: OzonPublicationPlanningContext,
  buildFresh: () => Promise<{ product: JsonRecord; sourceDirectory: string }>
): Promise<JsonRecord> {
  const root = await realpath(rootDirectory);
  const sharedSkuRoot = path.join(root, 'shared', context.sku);
  await mkdir(sharedSkuRoot, { recursive: true });
  const resolvedSharedSkuRoot = await realpath(sharedSkuRoot);
  assertInside(root, resolvedSharedSkuRoot, 'OZON 共享版本根目录');
  const target = path.join(resolvedSharedSkuRoot, context.generatedVersionId);
  const existing = await stat(target).catch(() => undefined);
  if (existing?.isDirectory()) {
    const resolvedTarget = await realpath(target);
    assertInside(root, resolvedTarget, 'OZON 共享生成版本目录');
    assertInside(resolvedSharedSkuRoot, resolvedTarget, 'OZON 共享生成版本目录');
    return readSourceProductAt(
      resolvedTarget,
      context.sku,
      context.revision,
      context.offerIds,
      context.generatedVersionId
    );
  }

  // A writable legacy inbox is runtime state, not authoring authority. New
  // publications always rebuild from the immutable DB generated-version
  // snapshot; accepting inbox/product.json here would turn this service into a
  // signing oracle for a worker-controlled file.
  const fresh = await buildFresh();
  let product = fresh.product;
  const sourceDirectory = await realpath(fresh.sourceDirectory);
  product = structuredClone(product);
  // Runtime media lookup is package-relative. Keeping an authoring machine's
  // absolute root here would make one generated version differ across OSes.
  product.mediaSourceRoot = '';
  assertInside(root, sourceDirectory, 'OZON 共享媒体导入源');
  const staging = path.join(resolvedSharedSkuRoot, `.staging-${context.generatedVersionId}-${randomUUID()}`);
  assertInside(resolvedSharedSkuRoot, staging, 'OZON 共享版本 staging');
  await mkdir(staging, { recursive: false });
  try {
    await copyProductMedia(product, sourceDirectory, staging);
    const serialized = `${JSON.stringify(product, null, 2)}\n`;
    const productContentHash = sha256Bytes(serialized);
    await writeFileAtomic(path.join(staging, 'product.json'), serialized, { encoding: 'utf8' });
    const markerPayload = {
      schemaVersion: 1,
      sku: context.sku,
      revision: context.revision,
      generatedVersionId: context.generatedVersionId,
      productContentHash,
      importedFrom: 'GENERATED_VERSION_SNAPSHOT'
    };
    await writeFileAtomic(path.join(staging, '.ozon-shared-source.json'), `${JSON.stringify({
      ...markerPayload,
      integritySignature: signSharedSourceMarker(markerPayload)
    }, null, 2)}\n`, { encoding: 'utf8' });
    try {
      await rename(staging, target);
    } catch (error) {
      const raced = await stat(target).catch(() => undefined);
      if (!raced?.isDirectory()) throw error;
      await rm(staging, { recursive: true, force: true });
    }
    const resolvedTarget = await realpath(target);
    assertInside(root, resolvedTarget, 'OZON 共享生成版本目录');
    assertInside(resolvedSharedSkuRoot, resolvedTarget, 'OZON 共享生成版本目录');
    return readSourceProductAt(
      resolvedTarget,
      context.sku,
      context.revision,
      context.offerIds,
      context.generatedVersionId
    );
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeStorePackage(input: {
  rootDirectory: string;
  storeAlias: string;
  sku: string;
  generatedVersionId: string;
  revision: number;
  publicationId: string;
  jobId: string;
  taskId: string;
  storeId: string;
  credentialBindingMode: 'VAULT' | 'LEGACY_PUBLICATION' | 'PURE_LEGACY';
  credentialVersionId?: string;
  storeConfigVersion: number;
  warehouseId: string;
  planHash: string;
  contentPolicyVersion: string;
  materialHash: string;
  materialHashVersion: string;
  presetRowVersion?: number;
  publicationMode: 'CREATE_ONLY' | 'COMPATIBLE_UPSERT';
  materializationHash: string;
  offerContractHash: string;
  product: JsonRecord;
}): Promise<{ packageDirectory: string; packageRelPath: string; productJsonPath: string; packageSignature: string }> {
  const root = await realpath(input.rootDirectory);
  const sourceDirectory = await realpath(path.join(root, 'shared', input.sku, input.generatedVersionId));
  assertInside(root, sourceDirectory, 'OZON 共享源商品目录');
  const storeRoot = path.join(root, 'stores', input.storeAlias);
  const inboxRoot = path.join(storeRoot, 'inbox');
  await mkdir(inboxRoot, { recursive: true });
  const resolvedInbox = await realpath(inboxRoot);
  assertInside(root, resolvedInbox, 'OZON 店铺 inbox');
  const directoryName = input.sku;
  const staging = path.join(resolvedInbox, `.staging-${input.publicationId}`);
  const target = path.join(resolvedInbox, directoryName);
  assertInside(resolvedInbox, staging, 'OZON 店铺 staging');
  assertInside(resolvedInbox, target, 'OZON 店铺 package');
  const existingTarget = await stat(target).catch(() => undefined);
  if (existingTarget?.isDirectory()) {
    const [productBytes, intakeRaw] = await Promise.all([
      readFile(path.join(target, 'product.json')),
      readFile(path.join(target, '.ozon-intake.json'), 'utf8')
    ]).catch(() => { throw new AppError('VERSION_CONFLICT', '原 publication 发布包不完整，禁止覆盖或新建 attempt', undefined, 409); });
    const intake = asRecord(JSON.parse(intakeRaw));
    const signature = sha256Bytes(productBytes);
    const expected = {
      publicationId: input.publicationId,
      jobId: input.jobId,
      taskId: input.taskId,
      planHash: input.planHash,
      contentPolicyVersion: input.contentPolicyVersion,
      materialHash: input.materialHash,
      materialHashVersion: input.materialHashVersion,
      materializationHash: input.materializationHash,
      productContentHash: signature
    };
    if (Object.entries(expected).some(([key, value]) => String(intake[key] ?? '') !== String(value))) {
      throw new AppError('VERSION_CONFLICT', '原 publication 发布包签名或冻结身份不一致', {
        publicationId: input.publicationId
      }, 409);
    }
    return {
      packageDirectory: target,
      packageRelPath: path.posix.join('stores', input.storeAlias, 'inbox', directoryName),
      productJsonPath: path.join(target, 'product.json'),
      packageSignature: signature
    };
  }
  await mkdir(staging, { recursive: false });
  try {
    await copyProductMedia(input.product, sourceDirectory, staging);
    const ticketPayload = {
      schemaVersion: 1,
      jobId: input.jobId,
      taskId: input.taskId,
      storeId: input.storeId,
      storeAlias: input.storeAlias,
      publicationId: input.publicationId,
      credentialVersionId: input.credentialVersionId ?? null,
      credentialBindingMode: input.credentialBindingMode,
      storeConfigVersion: input.storeConfigVersion,
      warehouseId: input.warehouseId,
      sku: input.sku,
      revision: input.revision,
      planHash: input.planHash,
      contentPolicyVersion: input.contentPolicyVersion,
      materialHash: input.materialHash,
      materialHashVersion: input.materialHashVersion,
      presetRowVersion: input.presetRowVersion ?? null,
      publicationMode: input.publicationMode,
      materializationHash: input.materializationHash,
      offerContractHash: input.offerContractHash
    };
    const serializedProduct = `${JSON.stringify(input.product, null, 2)}\n`;
    const productContentHash = sha256Bytes(serializedProduct);
    const ticket = signIntakeTicket({ ...ticketPayload, productContentHash });
    await writeFileAtomic(path.join(staging, 'product.json'), serializedProduct, { encoding: 'utf8' });
    await writeFileAtomic(path.join(staging, '_READY'), `${JSON.stringify(buildOzonStoreReadyMarker({
      jobId: input.jobId,
      taskId: input.taskId,
      sku: input.sku,
      revision: input.revision,
      productContentHash
    }), null, 2)}\n`, { encoding: 'utf8' });
    await writeFileAtomic(path.join(staging, '.ozon-intake.json'), `${JSON.stringify({
      ...ticketPayload,
      productContentHash,
      ticket
    }, null, 2)}\n`, { encoding: 'utf8' });
    await rename(staging, target);
    const packageRelPath = path.posix.join('stores', input.storeAlias, 'inbox', directoryName);
    return {
      packageDirectory: target,
      packageRelPath,
      productJsonPath: path.join(target, 'product.json'),
      packageSignature: productContentHash
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export type OzonProcessingPackageRecoveryInput = {
  rootDirectory: string;
  workRelPath: string;
  sku: string;
  generatedVersionId: string;
  revision: number;
  publicationId: string;
  jobId: string;
  taskId: string;
  storeId: string;
  storeAlias: string;
  credentialBindingMode: 'VAULT' | 'LEGACY_PUBLICATION' | 'PURE_LEGACY';
  credentialVersionId?: string;
  storeConfigVersion: number;
  warehouseId: string;
  planHash: string;
  contentPolicyVersion: string;
  materialHash: string;
  materialHashVersion: string;
  presetRowVersion?: number;
  publicationMode: 'CREATE_ONLY' | 'COMPATIBLE_UPSERT';
  materializationHash: string;
  offerContractHash: string;
  packageSignature: string;
  product: JsonRecord;
};

export async function inspectOzonProcessingPackageRecovery(
  input: OzonProcessingPackageRecoveryInput
): Promise<{
  targetDirectory: string;
  sourceDirectory: string;
  packageSignature: string;
  targetState: 'MISSING' | 'MATCHED';
  mediaFileCount: number;
  mediaBytes: number;
}> {
  const root = await realpath(input.rootDirectory);
  const sourceDirectory = await realpath(path.join(root, 'shared', input.sku, input.generatedVersionId));
  assertInside(root, sourceDirectory, 'OZON 共享源商品目录');
  const expectedWorkRelPath = path.posix.join('processing', input.taskId);
  if (safePosixRelativePath(input.workRelPath) !== expectedWorkRelPath) {
    throw new AppError('VERSION_CONFLICT', 'OZON processing 恢复路径与冻结 taskId 不一致', {
      expectedWorkRelPath,
      actualWorkRelPath: input.workRelPath
    }, 409);
  }
  const processingRoot = await realpath(path.join(root, 'processing'));
  assertInside(root, processingRoot, 'OZON processing 根目录');
  const targetDirectory = path.join(processingRoot, input.taskId);
  assertInside(processingRoot, targetDirectory, 'OZON processing 恢复目录');
  const serializedProduct = `${JSON.stringify(input.product, null, 2)}\n`;
  const packageSignature = sha256Bytes(serializedProduct);
  if (!safeOzonSignatureEqual(packageSignature, input.packageSignature)) {
    throw new AppError('VERSION_CONFLICT', '冻结商品快照与原 processing 包签名不一致', {
      publicationId: input.publicationId,
      expectedPackageSignature: input.packageSignature,
      actualPackageSignature: packageSignature
    }, 409);
  }
  const media = await inspectProductMedia(input.product, sourceDirectory);
  const target = await stat(targetDirectory).catch(() => undefined);
  if (target && !target.isDirectory()) {
    throw new AppError('VERSION_CONFLICT', 'OZON processing 恢复目标不是目录', { targetDirectory }, 409);
  }
  if (target?.isDirectory()) {
    await verifyOzonProcessingRecoveryTarget(input, targetDirectory, serializedProduct, packageSignature);
    await verifyProductMediaTarget(media, targetDirectory);
  }
  return {
    targetDirectory,
    sourceDirectory,
    packageSignature,
    targetState: target?.isDirectory() ? 'MATCHED' : 'MISSING',
    mediaFileCount: media.length,
    mediaBytes: media.reduce((sum, item) => sum + item.sizeBytes, 0)
  };
}

export async function writeOzonProcessingRecoveryPackage(
  input: OzonProcessingPackageRecoveryInput
): Promise<Awaited<ReturnType<typeof inspectOzonProcessingPackageRecovery>>> {
  const inspected = await inspectOzonProcessingPackageRecovery(input);
  if (inspected.targetState === 'MATCHED') return inspected;
  const processingRoot = path.dirname(inspected.targetDirectory);
  const staging = path.join(processingRoot, `.recovery-${input.publicationId}`);
  assertInside(processingRoot, staging, 'OZON processing 恢复 staging');
  if (await stat(staging).catch(() => undefined)) {
    throw new AppError('VERSION_CONFLICT', 'OZON processing 恢复 staging 已存在，禁止覆盖', { staging }, 409);
  }
  await mkdir(staging, { recursive: false });
  try {
    await copyProductMedia(input.product, inspected.sourceDirectory, staging);
    const ticketPayload = {
      schemaVersion: 1,
      jobId: input.jobId,
      taskId: input.taskId,
      storeId: input.storeId,
      storeAlias: input.storeAlias,
      publicationId: input.publicationId,
      credentialVersionId: input.credentialVersionId ?? null,
      credentialBindingMode: input.credentialBindingMode,
      storeConfigVersion: input.storeConfigVersion,
      warehouseId: input.warehouseId,
      sku: input.sku,
      revision: input.revision,
      planHash: input.planHash,
      contentPolicyVersion: input.contentPolicyVersion,
      materialHash: input.materialHash,
      materialHashVersion: input.materialHashVersion,
      presetRowVersion: input.presetRowVersion ?? null,
      publicationMode: input.publicationMode,
      materializationHash: input.materializationHash,
      offerContractHash: input.offerContractHash
    };
    const serializedProduct = `${JSON.stringify(input.product, null, 2)}\n`;
    const productContentHash = sha256Bytes(serializedProduct);
    const ticket = signIntakeTicket({ ...ticketPayload, productContentHash });
    await writeFileAtomic(path.join(staging, 'product.json'), serializedProduct, { encoding: 'utf8' });
    await writeFileAtomic(path.join(staging, '_READY'), `${JSON.stringify(buildOzonStoreReadyMarker({
      jobId: input.jobId,
      taskId: input.taskId,
      sku: input.sku,
      revision: input.revision,
      productContentHash
    }), null, 2)}\n`, { encoding: 'utf8' });
    await writeFileAtomic(path.join(staging, '.ozon-intake.json'), `${JSON.stringify({
      ...ticketPayload,
      productContentHash,
      ticket
    }, null, 2)}\n`, { encoding: 'utf8' });
    await verifyOzonProcessingRecoveryTarget(input, staging, serializedProduct, productContentHash);
    await verifyProductMediaTarget(
      await inspectProductMedia(input.product, inspected.sourceDirectory),
      staging
    );
    await rename(staging, inspected.targetDirectory);
    return inspectOzonProcessingPackageRecovery(input);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export function buildOzonStoreReadyMarker(input: {
  jobId: string;
  taskId: string;
  sku: string;
  revision: number;
  productContentHash: string;
}): JsonRecord {
  return {
    schemaVersion: 1,
    jobId: input.jobId,
    taskId: input.taskId,
    sku: input.sku,
    revision: input.revision,
    signature: input.productContentHash
  };
}

function collectMedia(product: JsonRecord): Array<{ relativePath: string; sha256?: string }> {
  const result = new Map<string, string | undefined>();
  for (const asset of asArray(product.mediaAssets)) {
    const row = asRecord(asset);
    const relativePath = String(row.relativePath || '');
    if (relativePath) result.set(relativePath, typeof row.sha256 === 'string' ? row.sha256 : undefined);
  }
  for (const offer of asArray(product.offers)) {
    for (const media of asArray(asRecord(offer).media)) {
      const row = asRecord(media);
      const relativePath = String(row.relativePath || '');
      if (relativePath && !result.has(relativePath)) result.set(relativePath, undefined);
    }
  }
  return [...result].map(([relativePath, sha256]) => ({ relativePath, ...(sha256 ? { sha256 } : {}) }));
}

async function copyProductMedia(product: JsonRecord, sourceDirectory: string, destinationDirectory: string): Promise<void> {
  for (const asset of await inspectProductMedia(product, sourceDirectory)) {
    const relativePath = asset.relativePath;
    const source = asset.source;
    const destination = path.join(destinationDirectory, ...relativePath.split('/'));
    assertInside(destinationDirectory, destination, 'OZON 店铺媒体');
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

async function inspectProductMedia(product: JsonRecord, sourceDirectory: string): Promise<Array<{
  relativePath: string;
  source: string;
  sizeBytes: number;
  sourceSha256: string;
}>> {
  const inspected: Array<{ relativePath: string; source: string; sizeBytes: number; sourceSha256: string }> = [];
  for (const asset of collectMedia(product)) {
    const relativePath = safePosixRelativePath(asset.relativePath);
    const source = await realpath(path.join(sourceDirectory, ...relativePath.split('/')));
    assertInside(sourceDirectory, source, 'OZON 共享媒体');
    const info = await stat(source);
    if (!info.isFile()) throw new AppError('SOURCE_FILE_MISSING', 'OZON 共享媒体不是普通文件', { relativePath }, 409);
    const sourceSha256 = await sha256File(source);
    if (asset.sha256 && sourceSha256 !== asset.sha256) {
      throw new AppError('VERIFY_FAILED', 'OZON 共享媒体 SHA-256 与清单不一致', { relativePath }, 409);
    }
    inspected.push({ relativePath, source, sizeBytes: info.size, sourceSha256 });
  }
  return inspected;
}

async function verifyProductMediaTarget(
  media: Awaited<ReturnType<typeof inspectProductMedia>>,
  targetDirectory: string
): Promise<void> {
  for (const asset of media) {
    const target = path.join(targetDirectory, ...asset.relativePath.split('/'));
    assertInside(targetDirectory, target, 'OZON processing 恢复媒体');
    const info = await stat(target).catch(() => undefined);
    if (!info?.isFile() || info.size !== asset.sizeBytes || await sha256File(target) !== asset.sourceSha256) {
      throw new AppError('VERSION_CONFLICT', 'OZON processing 恢复媒体与共享版本不一致', {
        relativePath: asset.relativePath
      }, 409);
    }
  }
}

async function verifyOzonProcessingRecoveryTarget(
  input: OzonProcessingPackageRecoveryInput,
  targetDirectory: string,
  serializedProduct: string,
  packageSignature: string
): Promise<void> {
  const [productBytes, intakeRaw, readyRaw] = await Promise.all([
    readFile(path.join(targetDirectory, 'product.json')),
    readFile(path.join(targetDirectory, '.ozon-intake.json'), 'utf8'),
    readFile(path.join(targetDirectory, '_READY'), 'utf8')
  ]).catch(() => {
    throw new AppError('VERSION_CONFLICT', 'OZON processing 恢复包不完整', {
      publicationId: input.publicationId,
      targetDirectory
    }, 409);
  });
  if (!productBytes.equals(Buffer.from(serializedProduct))) {
    throw new AppError('VERSION_CONFLICT', 'OZON processing 恢复商品快照字节不一致', {
      publicationId: input.publicationId
    }, 409);
  }
  const intake = asRecord(JSON.parse(intakeRaw));
  const ready = asRecord(JSON.parse(readyRaw));
  const expectedIntake = {
    jobId: input.jobId,
    taskId: input.taskId,
    storeId: input.storeId,
    storeAlias: input.storeAlias,
    publicationId: input.publicationId,
    planHash: input.planHash,
    contentPolicyVersion: input.contentPolicyVersion,
    materialHash: input.materialHash,
    materialHashVersion: input.materialHashVersion,
    materializationHash: input.materializationHash,
    offerContractHash: input.offerContractHash,
    productContentHash: packageSignature
  };
  const mismatches = Object.entries(expectedIntake)
    .filter(([key, value]) => String(intake[key] ?? '') !== String(value))
    .map(([key]) => key);
  const expectedReady = buildOzonStoreReadyMarker({
    jobId: input.jobId,
    taskId: input.taskId,
    sku: input.sku,
    revision: input.revision,
    productContentHash: packageSignature
  });
  if (JSON.stringify(ready) !== JSON.stringify(expectedReady)) mismatches.push('_READY');
  const ticket = String(intake.ticket || '');
  const unsignedIntake = { ...intake };
  delete unsignedIntake.ticket;
  if (!safeOzonSignatureEqual(ticket, signIntakeTicket(unsignedIntake))) mismatches.push('ticket');
  if (mismatches.length) {
    throw new AppError('VERSION_CONFLICT', 'OZON processing 恢复包与冻结合同不一致', {
      publicationId: input.publicationId,
      mismatches
    }, 409);
  }
}

export function stableMaterial(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableMaterial);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as JsonRecord)
    .filter(([key]) => !['capturedAt', 'generatedAt', 'updatedAt', 'createdAt', 'mediaSourceRoot'].includes(key))
    .map(([key, child]) => [key, stableMaterial(child)]));
}

export function stablePresetMaterial(value: JsonRecord): JsonRecord {
  const compatibilityOnly = new Set([
    'warehouseId', 'currency', 'fulfillmentMode', 'autoPublishEnabled', 'autoPublishMode', 'isDefault', 'capturedAt'
  ]);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !compatibilityOnly.has(key))
    .map(([key, child]) => [key, stableMaterial(child)]));
}

function safePosixRelativePath(value: string): string {
  const result = String(value || '').trim();
  if (!result || result.includes('\\') || path.posix.isAbsolute(result) || result.split('/').includes('..')) {
    throw new AppError('INVALID_RELATIVE_PATH', 'OZON 媒体路径必须是安全的 POSIX 相对路径', undefined, 409);
  }
  return result;
}

function assertInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', `${label}逸出允许根目录`, undefined, 409);
  }
}

type FrozenAutomaticListingArtifact = {
  product: JsonRecord;
  pricingOffers: Array<{ offerId: string; price: number; oldPrice?: number; minPrice?: number }>;
};

function strictUuid(value: unknown, field: string): string {
  const result = String(value || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw new AppError('CONFIG_INVALID', `缺少有效的 ${field}`);
  }
  return result;
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT');
}

function frozenArtifactUnavailable(jobId: string, storeId: string): AppError {
  return new AppError(
    'OZON_FROZEN_ARTIFACT_UNAVAILABLE',
    'OZON 自动任务冻结资料不可用，请刷新任务状态后重试',
    { jobId, storeId, noFallback: true },
    409
  );
}

function frozenArtifactConflict(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError('VERSION_CONFLICT', message, { ...details, noFallback: true }, 409);
}

function assertAutomaticSnapshotStore(context: OzonAutomaticListingSnapshotContext, requestedStoreId: string): void {
  const { job, publication } = context;
  if (job.storeId !== requestedStoreId || publication.storeId !== requestedStoreId) {
    throw new AppError('NOT_FOUND', '该 OZON 自动任务不属于请求店铺', {
      jobId: job.id,
      storeId: requestedStoreId
    }, 404);
  }
  const mismatches: string[] = [];
  if (job.source !== 'AUTO') mismatches.push('job.source');
  if (publication.source !== 'AUTOMATION') mismatches.push('publication.source');
  if (job.publicationId !== publication.id) mismatches.push('publicationId');
  if (job.sku !== publication.sku) mismatches.push('sku');
  if (job.revision !== publication.revision) mismatches.push('revision');
  if (job.storeAlias !== publication.storeAliasSnapshot) mismatches.push('storeAlias');
  if (job.taskId !== String(publication.taskId || '')) mismatches.push('taskId');
  if (job.taskId !== `${publication.storeAliasSnapshot}__${publication.sku}__r${publication.revision}`) {
    mismatches.push('taskId.format');
  }
  if (job.storeConfigVersion !== publication.storeConfigVersion) mismatches.push('storeConfigVersion');
  if (job.credentialBindingMode !== publication.credentialBindingMode) mismatches.push('credentialBindingMode');
  if (publication.credentialBindingMode === 'PURE_LEGACY') mismatches.push('credentialBindingMode.legacy');
  if (String(job.credentialVersionId || '') !== String(publication.credentialVersionId || '')) mismatches.push('credentialVersionId');
  if (job.warehouseId !== publication.warehouseId) mismatches.push('warehouseId');
  if (job.offerContractHash !== publication.offerContractHash) mismatches.push('offerContractHash');
  if (job.materializationHash !== publication.materializationHash) mismatches.push('materializationHash');
  if (!sameUniqueStrings(job.offerIds, publication.offerIds)) mismatches.push('offerIds');
  if (publication.generatedVersionId !== context.generatedVersionId) mismatches.push('generatedVersionId');
  if (mismatches.length) {
    throw frozenArtifactConflict('OZON 自动任务与冻结 publication 身份不一致', {
      jobId: job.id,
      storeId: requestedStoreId,
      mismatches
    });
  }
}

async function readAutomaticListingArtifact(
  rootDirectory: unknown,
  context: OzonAutomaticListingSnapshotContext
): Promise<FrozenAutomaticListingArtifact> {
  const root = strictRuntimeRoot(rootDirectory);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw frozenArtifactConflict('OZON 自动上品根目录不可安全读取');
  }
  const rootReal = await realpath(root);
  const workRelPath = strictRuntimeWorkRelPath(context.job.workRelPath);
  assertRuntimeWorkIdentity({
    storeAlias: context.job.storeAlias,
    credentialBindingMode: context.job.credentialBindingMode,
    directoryStage: context.job.directoryStage,
    sku: context.job.sku,
    taskFolder: context.job.taskFolder,
    taskId: context.job.taskId
  }, workRelPath);
  const workDirectory = path.resolve(rootReal, ...workRelPath.split('/'));
  assertInside(rootReal, workDirectory, 'OZON 自动任务冻结目录');
  const workInfo = await lstat(workDirectory);
  if (!workInfo.isDirectory() || workInfo.isSymbolicLink()) {
    throw frozenArtifactConflict('OZON 自动任务冻结目录不是普通目录', { jobId: context.job.id });
  }
  const workReal = await realpath(workDirectory);
  assertInside(rootReal, workReal, 'OZON 自动任务冻结目录真实路径');
  if (path.relative(workDirectory, workReal) !== '') {
    throw frozenArtifactConflict('OZON 自动任务冻结目录包含符号链接跳转', { jobId: context.job.id });
  }

  const [productBytes, readyBytes, intakeBytes] = await Promise.all([
    readOrdinaryFrozenFile(workReal, 'product.json', 16 * 1024 * 1024),
    readOrdinaryFrozenFile(workReal, '_READY', 64 * 1024),
    readOrdinaryFrozenFile(workReal, '.ozon-intake.json', 64 * 1024)
  ]);
  const productContentHash = sha256Bytes(productBytes);
  const productValue = parseFrozenJson(productBytes, 'product.json');
  const ready = asRecord(parseFrozenJson(readyBytes, '_READY'));
  const intake = asRecord(parseFrozenJson(intakeBytes, '.ozon-intake.json'));
  const parsedProduct = ozonProductSchema.safeParse(productValue);
  if (!parsedProduct.success) {
    throw frozenArtifactConflict('OZON 自动任务 product.json 不符合商品合同', {
      jobId: context.job.id,
      issues: parsedProduct.error.issues
    });
  }
  const product = parsedProduct.data as unknown as JsonRecord;
  assertFrozenAutomaticIdentity(context, product, ready, intake, productContentHash);
  const byOffer = new Map(asArray(product.offers).map((entry) => {
    const offer = asRecord(entry);
    return [String(offer.offerId || ''), offer] as const;
  }));
  return {
    product,
    pricingOffers: context.publication.offerIds.map((offerId) => {
      const offer = byOffer.get(offerId)!;
      return {
        offerId,
        price: Number(offer.price),
        ...(offer.oldPrice === undefined ? {} : { oldPrice: Number(offer.oldPrice) }),
        ...(offer.minPrice === undefined ? {} : { minPrice: Number(offer.minPrice) })
      };
    })
  };
}

async function readOrdinaryFrozenFile(directory: string, fileName: string, maxBytes: number): Promise<Buffer> {
  const filePath = path.join(directory, fileName);
  assertInside(directory, filePath, `OZON 自动任务 ${fileName}`);
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    throw frozenArtifactConflict(`OZON 自动任务 ${fileName} 不是受支持的普通文件`, {
      fileName,
      maxBytes
    });
  }
  const fileReal = await realpath(filePath);
  assertInside(directory, fileReal, `OZON 自动任务 ${fileName} 真实路径`);
  return readFile(fileReal);
}

function parseFrozenJson(bytes: Buffer, fileName: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw frozenArtifactConflict(`OZON 自动任务 ${fileName} 不是有效 JSON`, { fileName });
  }
}

function assertFrozenAutomaticIdentity(
  context: OzonAutomaticListingSnapshotContext,
  product: JsonRecord,
  ready: JsonRecord,
  intake: JsonRecord,
  productContentHash: string
): void {
  const { job, publication } = context;
  const listing = context.listingSnapshot;
  const listingData = asRecord(listing.data);
  const listingOfferIds = asArray(listingData.offers).map((entry) => String(asRecord(entry).offerId || '')).filter(Boolean);
  const productOfferIds = asArray(product.offers).map((entry) => String(asRecord(entry).offerId || '')).filter(Boolean);
  const payload = job.payload;
  const mismatches: string[] = [];
  if (String(listing.sku || '') !== job.sku) mismatches.push('listing.sku');
  if (Number(listing.revision) !== job.revision) mismatches.push('listing.revision');
  if (String(listing.generatedVersionId || context.generatedVersionId) !== context.generatedVersionId) {
    mismatches.push('listing.generatedVersionId');
  }
  if (!Number.isInteger(Number(listing.rowVersion)) || Number(listing.rowVersion) < 1) mismatches.push('listing.rowVersion');
  if (listing.managementSource !== 'AUTO') mismatches.push('listing.managementSource');
  if (!containsUniqueStrings(listingOfferIds, publication.offerIds)) mismatches.push('listing.offerIds');
  if (String(product.productCode || '') !== job.sku) mismatches.push('product.productCode');
  if (Number(product.revision) !== job.revision) mismatches.push('product.revision');
  if (String(product.storeAlias || '') !== publication.storeAliasSnapshot) mismatches.push('product.storeAlias');
  if (String(product.warehouseId || '') !== publication.warehouseId) mismatches.push('product.warehouseId');
  if (String(product.fulfillmentMode || '') !== publication.fulfillmentMode) mismatches.push('product.fulfillmentMode');
  if (String(product.currency || '') !== publication.accountCurrency) mismatches.push('product.currency');
  if (!sameUniqueStrings(productOfferIds, publication.offerIds)) mismatches.push('product.offerIds');
  if (job.directorySignature !== productContentHash) mismatches.push('job.directorySignature');
  if (String(publication.packageSignature || '') !== productContentHash) mismatches.push('publication.packageSignature');
  if (String(payload.publicationId || '') !== publication.id) mismatches.push('payload.publicationId');
  if (String(payload.storeId || '') !== publication.storeId) mismatches.push('payload.storeId');
  if (String(payload.offerContractHash || '') !== publication.offerContractHash) mismatches.push('payload.offerContractHash');
  if (String(payload.materializationHash || '') !== publication.materializationHash) mismatches.push('payload.materializationHash');

  const expectedOfferContractHash = sha256({
    storeId: publication.storeId,
    generatedVersionId: context.generatedVersionId,
    offerIds: [...publication.offerIds].sort()
  });
  if (publication.offerContractHash !== expectedOfferContractHash) mismatches.push('computed.offerContractHash');
  const expectedMaterializationHash = sha256({
    product: stableMaterial(product),
    storeId: publication.storeId,
    storeConfigVersion: publication.storeConfigVersion,
    credentialVersionId: publication.credentialVersionId || null,
    presetId: publication.presetId || null,
    presetDefinitionHash: publication.presetDefinitionHash || null,
    warehouseId: publication.warehouseId,
    fulfillmentMode: publication.fulfillmentMode,
    accountCurrency: publication.accountCurrency,
    offerContractHash: publication.offerContractHash
  });
  if (publication.materializationHash !== expectedMaterializationHash) mismatches.push('computed.materializationHash');

  const expectedReady = buildOzonStoreReadyMarker({
    jobId: job.id,
    taskId: job.taskId,
    sku: job.sku,
    revision: job.revision,
    productContentHash
  });
  if (stableJson(ready) !== stableJson(expectedReady)) mismatches.push('_READY');
  const expectedIntakePayload = {
    schemaVersion: 1,
    jobId: job.id,
    taskId: job.taskId,
    storeId: publication.storeId,
    storeAlias: publication.storeAliasSnapshot,
    publicationId: publication.id,
    credentialVersionId: publication.credentialVersionId ?? null,
    credentialBindingMode: publication.credentialBindingMode,
    storeConfigVersion: publication.storeConfigVersion,
    warehouseId: publication.warehouseId,
    sku: job.sku,
    revision: job.revision,
    materializationHash: publication.materializationHash,
    offerContractHash: publication.offerContractHash,
    productContentHash
  };
  const intakePayload = { ...intake };
  const ticket = String(intakePayload.ticket || '');
  delete intakePayload.ticket;
  if (stableJson(intakePayload) !== stableJson(expectedIntakePayload)) mismatches.push('.ozon-intake.json');
  const expectedTicket = signIntakeTicket(expectedIntakePayload);
  if (!ticket || !safeOzonSignatureEqual(expectedTicket, ticket)) mismatches.push('.ozon-intake.ticket');
  if (mismatches.length) {
    throw frozenArtifactConflict('OZON 自动任务冻结资料身份、签名或内容已漂移', {
      jobId: job.id,
      storeId: publication.storeId,
      mismatches
    });
  }
}

function automaticListingSnapshotResult(
  context: OzonAutomaticListingSnapshotContext,
  artifact: FrozenAutomaticListingArtifact
): OzonAutomaticListingSnapshot {
  const expectedOffers = new Set(context.publication.offerIds);
  const listing = structuredClone(context.listingSnapshot);
  const data = asRecord(listing.data);
  data.mediaSourceRoot = '';
  data.offers = asArray(data.offers).filter((entry) => expectedOffers.has(String(asRecord(entry).offerId || '')));
  listing.data = data;
  listing.generatedVersionId = context.generatedVersionId;
  const currentAccountCurrency = context.currentAccountCurrency;
  return {
    mode: 'AUTO_TASK_SNAPSHOT',
    readOnly: true,
    jobId: context.job.id,
    publicationId: context.publication.id,
    generatedVersionId: context.generatedVersionId,
    sku: context.job.sku,
    revision: context.job.revision,
    store: {
      id: context.publication.storeId,
      storeAlias: context.publication.storeAliasSnapshot,
      displayName: context.publication.storeDisplayNameSnapshot,
      accountCurrency: context.publication.accountCurrency,
      ...(currentAccountCurrency ? { currentAccountCurrency } : {}),
      accountCurrencyChanged: Boolean(currentAccountCurrency && currentAccountCurrency !== context.publication.accountCurrency)
    },
    listing: listing as OzonAutomaticListingSnapshot['listing'],
    pricing: {
      currency: context.publication.accountCurrency,
      offers: artifact.pricingOffers
    }
  };
}

function sameUniqueStrings(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return left.length === new Set(left).size
    && right.length === new Set(right).size
    && left.length === right.length
    && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function containsUniqueStrings(container: string[], expected: string[]): boolean {
  return container.length === new Set(container).size
    && expected.length === new Set(expected).size
    && expected.every((value) => container.includes(value));
}

function withAuthoritativeRuntimePaths<T extends {
  workRelPath?: unknown;
  payload?: unknown;
  storeAlias?: unknown;
  credentialBindingMode?: unknown;
  directoryStage?: unknown;
  sku?: unknown;
  taskFolder?: unknown;
  taskId?: unknown;
}>(job: T, rootDirectory: unknown): T {
  const root = strictRuntimeRoot(rootDirectory);
  const workRelPath = strictRuntimeWorkRelPath(job.workRelPath);
  assertRuntimeWorkIdentity(job, workRelPath);
  const workDirectory = path.resolve(root, ...workRelPath.split('/'));
  assertInside(root, workDirectory, 'OZON runtime 工作目录');
  const productJsonPath = path.join(workDirectory, 'product.json');
  const payload = job.payload && typeof job.payload === 'object' && !Array.isArray(job.payload)
    ? job.payload as Record<string, unknown>
    : {};
  return {
    ...job,
    workRelPath,
    payload: {
      ...payload,
      workRelPath,
      workDirectory,
      productJsonPath
    }
  };
}

function strictRuntimeRoot(value: unknown): string {
  const rootValue = String(value || '').trim();
  if (!rootValue || !path.isAbsolute(rootValue)) {
    throw new AppError('CONFIG_INVALID', 'OZON runtime claim 缺少合法的绝对根目录', undefined, 409);
  }
  const root = path.resolve(rootValue);
  if (root === path.parse(root).root) {
    throw new AppError('CONFIG_INVALID', 'OZON runtime claim 不允许使用磁盘或卷根目录', undefined, 409);
  }
  return root;
}

function strictRuntimeWorkRelPath(value: unknown): string {
  const workRelPath = String(value || '').trim();
  if (!workRelPath
    || workRelPath.includes('\\')
    || workRelPath.startsWith('/')
    || /^[A-Za-z]:/.test(workRelPath)) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON runtime workRelPath 必须是根目录相对的可移植路径', undefined, 409);
  }
  const parts = workRelPath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')
    || path.posix.normalize(workRelPath) !== workRelPath) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON runtime workRelPath 包含空段或路径逃逸', undefined, 409);
  }
  return workRelPath;
}

function assertRuntimeWorkIdentity(job: {
  storeAlias?: unknown;
  credentialBindingMode?: unknown;
  directoryStage?: unknown;
  sku?: unknown;
  taskFolder?: unknown;
  taskId?: unknown;
}, workRelPath: string): void {
  const storeAlias = String(job.storeAlias || '').trim().toLowerCase();
  const bindingMode = String(job.credentialBindingMode || '').trim().toUpperCase();
  const directoryStage = String(job.directoryStage || '').trim().toUpperCase();
  const sku = String(job.sku || '').trim();
  const taskFolder = String(job.taskFolder || '').trim();
  const taskId = String(job.taskId || '').trim();
  const storeScoped = bindingMode === 'VAULT'
    || (bindingMode === 'LEGACY_PUBLICATION' && storeAlias === 'default');
  const parts = workRelPath.split('/');
  const validDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const timestamp = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
  };
  const matches = (expected: string[]) => expected.length === parts.length
    && expected.every((part, index) => part === parts[index]);
  const lifecycleFolder = storeScoped ? taskId : taskFolder;
  const matchesSuccess = parts.length === 3
    && parts[0] === 'success'
    && validDate(parts[1] || '')
    && parts[2] === lifecycleFolder;
  const valid = directoryStage === 'INBOX'
    ? matches(storeScoped ? ['stores', storeAlias, 'inbox', sku] : ['inbox', sku])
    : directoryStage === 'PROCESSING'
      ? matches(['processing', lifecycleFolder])
      : directoryStage === 'SUCCESS' && matchesSuccess;
  if (!valid) {
    throw new AppError('VERSION_CONFLICT', 'OZON runtime workRelPath 与店铺、目录阶段或任务身份不一致', {
      storeAlias,
      directoryStage,
      workRelPath
    }, 409);
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

type PublicationReadbackFailure = {
  deliveryState: 'NOT_SENT' | 'UNKNOWN' | 'RESPONDED';
  retryClass: 'RETRYABLE' | 'READBACK_REQUIRED' | 'PERMANENT';
  statusCode?: number;
  errorCode: string;
  errorMessage: string;
};

async function postPublicationReadback(url: string, body: JsonRecord): Promise<JsonRecord> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240_000)
    });
  } catch (error) {
    const code = String(asRecord(error).code || '').toUpperCase();
    const definitelyNotSent = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
    throw new AppError('OZON_PLATFORM_STATUS_REFRESH_FAILED', 'OZON publication 只读回查调度失败', {
      deliveryState: definitelyNotSent ? 'NOT_SENT' : 'UNKNOWN',
      retryClass: definitelyNotSent ? 'RETRYABLE' : 'READBACK_REQUIRED'
    }, 502);
  }
  const text = (await response.text()).slice(0, 2_000_000);
  let result: JsonRecord = {};
  try {
    const parsed = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) result = parsed as JsonRecord;
    else throw new Error('response must be object');
  } catch {
    throw new AppError('OZON_PLATFORM_STATUS_REFRESH_FAILED', 'OZON publication 只读回查响应不是有效 JSON 对象', {
      deliveryState: 'RESPONDED', retryClass: 'PERMANENT', statusCode: response.status
    }, 502);
  }
  if (response.status === 425 || response.status === 429) {
    throw new AppError('OZON_PLATFORM_STATUS_REFRESH_FAILED', `OZON publication 只读回查暂未受理（HTTP ${response.status}）`, {
      deliveryState: 'NOT_SENT', retryClass: 'RETRYABLE', statusCode: response.status
    }, response.status === 429 ? 429 : 502);
  }
  if (response.status === 408 || response.status >= 500) {
    throw new AppError('OZON_PLATFORM_STATUS_REFRESH_FAILED', `OZON publication 只读回查送达结果不确定（HTTP ${response.status}）`, {
      deliveryState: 'UNKNOWN', retryClass: 'READBACK_REQUIRED', statusCode: response.status
    }, 502);
  }
  if (!response.ok) {
    throw new AppError('OZON_PLATFORM_STATUS_REFRESH_FAILED', `OZON publication 只读回查被拒绝（HTTP ${response.status}）`, {
      deliveryState: 'RESPONDED', retryClass: 'PERMANENT', statusCode: response.status
    }, 502);
  }
  return result;
}

function publicationReadbackFailure(error: unknown): PublicationReadbackFailure {
  const details = error instanceof AppError ? error.details || {} : {};
  const deliveryState = details.deliveryState === 'NOT_SENT' || details.deliveryState === 'UNKNOWN'
    || details.deliveryState === 'RESPONDED'
    ? details.deliveryState
    : 'RESPONDED';
  const retryClass = details.retryClass === 'RETRYABLE' || details.retryClass === 'READBACK_REQUIRED'
    || details.retryClass === 'PERMANENT'
    ? details.retryClass
    : 'PERMANENT';
  const statusCode = Number(details.statusCode || 0);
  return {
    deliveryState,
    retryClass,
    ...(statusCode ? { statusCode } : {}),
    errorCode: error instanceof AppError ? error.code : 'OZON_PLATFORM_STATUS_REFRESH_FAILED',
    errorMessage: error instanceof Error ? error.message : 'OZON publication 只读回查失败'
  };
}

async function postJson(url: string, body: unknown): Promise<{ accepted: boolean; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    });
  } catch (error) {
    throw new AppError('OZON_PREFLIGHT_DISPATCH_UNKNOWN', 'OZON 店铺预检调度结果未知', {
      deliveryUnknown: true,
      message: error instanceof Error ? error.message : '网络异常'
    }, 502);
  }
  const text = await response.text();
  let parsed: unknown = text;
  try { parsed = text ? JSON.parse(text) : {}; } catch { /* keep bounded text */ }
  if (!response.ok) {
    throw new AppError('OZON_PREFLIGHT_DISPATCH_REJECTED', 'OZON 店铺预检调度被拒绝', {
      statusCode: response.status,
      deliveryUnknown: false
    }, 502);
  }
  return { accepted: true, body: parsed };
}

function validationError(message: string, issues: unknown): AppError {
  return new AppError('CONFIG_INVALID', message, { issues });
}

function assertAutomaticDeliveryIdentity(input: OzonAutomaticDeliveryIdentity): void {
  const sourceStageId = String(input.sourceStageId || '').trim();
  const submissionId = String(input.submissionId || '').trim();
  const variantId = String(input.variantId || '').trim();
  const deliveredAt = new Date(input.deliveredAt);
  if (!sourceStageId || sourceStageId.length > 128 || !submissionId || submissionId.length > 256
    || variantId.length > 256 || !Number.isFinite(deliveredAt.getTime())) {
    throw new AppError('CONFIG_INVALID', '无效的 OZON 自动媒体投递身份');
  }
}

function fleetCapabilityReady(): boolean {
  return /^(?:1|true|yes|on)$/i.test(String(process.env.MERCHROUTE_OZON_MULTISTORE_FLEET_READY || '').trim());
}

export function materializeOfferForStore(
  offer: JsonRecord,
  presetPrices: OzonStorePresetPrices | undefined,
  presetDefaultStock: unknown,
  materialOverride: JsonRecord,
  expectedCurrency: OzonPriceCurrency
): JsonRecord {
  return {
    ...offer,
    ...(presetPrices ? {
      price: presetPrices.price,
      oldPrice: presetPrices.oldPrice,
      minPrice: presetPrices.minPrice
    } : {}),
    ...(Number.isSafeInteger(Number(presetDefaultStock)) ? { stock: Number(presetDefaultStock) } : {}),
    ...pickOfferMaterialOverride(materialOverride, expectedCurrency)
  };
}

export function pickOfferMaterialOverride(
  value: JsonRecord,
  expectedCurrency: OzonPriceCurrency
): JsonRecord {
  const result: JsonRecord = {};
  for (const key of ['stock', 'attributes'] as const) {
    if (value[key] !== undefined) result[key] = structuredClone(value[key]);
  }
  if (normalizePriceCurrency(value.priceCurrency) === expectedCurrency) {
    for (const key of ['price', 'oldPrice', 'minPrice'] as const) {
      if (value[key] !== undefined) result[key] = structuredClone(value[key]);
    }
  }
  return result;
}

export function sanitizeLegacyCrossCurrencyPriceOverrides(
  source: JsonRecord,
  current: JsonRecord,
  basePreset: JsonRecord | undefined
): { overrides: JsonRecord; changed: boolean } {
  const sourceCurrency = normalizePriceCurrency(source.currency);
  const baseCurrency = normalizePriceCurrency(basePreset?.currency);
  if (!sourceCurrency || !baseCurrency || sourceCurrency === baseCurrency) {
    return { overrides: structuredClone(current), changed: false };
  }
  let changed = false;
  const offerOverrides = asArray(current.offerOverrides).flatMap((entry) => {
    const row = structuredClone(asRecord(entry));
    if (hasPriceFields(row) && isMissingPriceCurrency(row.priceCurrency)) {
      delete row.price;
      delete row.oldPrice;
      delete row.minPrice;
      delete row.priceCurrency;
      changed = true;
    }
    const materialKeys = Object.keys(row).filter((key) => key !== 'offerId' && row[key] !== undefined);
    return materialKeys.length ? [row] : [];
  });
  if (!changed) return { overrides: structuredClone(current), changed: false };
  const overrides = structuredClone(current);
  if (offerOverrides.length) overrides.offerOverrides = offerOverrides;
  else delete overrides.offerOverrides;
  return { overrides, changed: true };
}

export function materialPriceOverrideBlockers(
  overrides: JsonRecord,
  expectedCurrency: OzonPriceCurrency
): string[] {
  return asArray(overrides.offerOverrides).flatMap((entry) => {
    const row = asRecord(entry);
    if (!hasPriceFields(row)) return [];
    const offerId = String(row.offerId || '').trim() || '未知 Offer';
    const currency = normalizePriceCurrency(row.priceCurrency);
    if (!currency) return [`Offer ${offerId} 的价格覆盖缺少币种证据，请重新保存商品价格`];
    if (currency !== expectedCurrency) {
      return [`Offer ${offerId} 的价格覆盖币种 ${currency} 与店铺币种 ${expectedCurrency} 不一致`];
    }
    return [];
  });
}

export function deriveExplicitPriceOverrides(
  source: JsonRecord,
  current: JsonRecord,
  basePrices: OzonStorePresetPrices
): JsonRecord {
  const sourceCurrency = normalizePriceCurrency(source.currency);
  if (!sourceCurrency || sourceCurrency !== basePrices.currency) return structuredClone(current);
  const byOffer = new Map<string, JsonRecord>(asArray(current.offerOverrides).map((entry) => {
    const row = asRecord(entry);
    return [String(row.offerId || ''), { ...row }] as const;
  }).filter(([offerId]) => offerId));
  for (const entry of asArray(source.offers)) {
    const offer = asRecord(entry);
    const offerId = String(offer.offerId || '');
    if (!offerId) continue;
    const override: JsonRecord = byOffer.get(offerId) || { offerId };
    let hasPriceOverride = false;
    for (const key of ['price', 'oldPrice', 'minPrice'] as const) {
      const value = Number(offer[key]);
      if (Number.isFinite(value) && value !== basePrices[key]) {
        override[key] = value;
        hasPriceOverride = true;
      }
    }
    if (hasPriceOverride) override.priceCurrency = sourceCurrency;
    if (Object.keys(override).length > 1) byOffer.set(offerId, override);
  }
  const result = { ...current };
  const offerOverrides = [...byOffer.values()].sort((left, right) => String(left.offerId).localeCompare(String(right.offerId)));
  if (offerOverrides.length) result.offerOverrides = offerOverrides;
  return result;
}

function hasPriceFields(value: JsonRecord): boolean {
  return value.price !== undefined || value.oldPrice !== undefined || value.minPrice !== undefined;
}

function isMissingPriceCurrency(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === '';
}

function normalizePriceCurrency(value: unknown): OzonPriceCurrency | undefined {
  const currency = String(value || '').trim().toUpperCase();
  return currency === 'RUB' || currency === 'CNY' ? currency : undefined;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as JsonRecord;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function deterministicUuid(...parts: string[]): string {
  const hex = createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function sha256Bytes(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
