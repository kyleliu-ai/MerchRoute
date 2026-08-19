import { createHash, randomUUID } from 'node:crypto';
import {
  AppError,
  wbPublicationCreateInputSchema,
  wbPublicationPlanInputSchema,
  wbStoreCreateSchema,
  wbStoreCredentialInputSchema,
  wbStoreMutationSchema,
  wbStorePreflightReportSchema,
  wbStoreUpdateSchema,
  wbSystemSettingsPatchSchema,
  type WbPublicationPlan,
  type WbPublicationPlanInput,
  type WbStorePublication
} from '@n8n-media-review/shared';
import type { WbStoreRepository } from '../../repositories/wb-stores.js';
import { compileProductJsonWithAudit, type WbPublishingService } from '../wb-publishing/index.js';
import type { WbPresetService } from '../wb-presets/index.js';
import {
  classifyWbPublicationDispatchError,
  unknownDispatchReadbackError
} from '../wb-publication-dispatch.js';
import { WbTokenVault } from './token-vault.js';
import type { WbSourceMediaCleanupService } from '../wb-source-media/index.js';

type JsonRecord = Record<string, unknown>;

export class WbStoreService {
  constructor(
    readonly repository: WbStoreRepository,
    private readonly presets: WbPresetService,
    private readonly publishing: WbPublishingService,
    private readonly sourceMediaCleanup?: WbSourceMediaCleanupService,
    private readonly vault = new WbTokenVault()
  ) {}

  async settings() { return this.repository.getSettings(); }

  async updateSettings(input: unknown) {
    const parsed = wbSystemSettingsPatchSchema.safeParse(input);
    if (!parsed.success) throw validationError('无效的 WB 多店铺全局设置', parsed.error.issues);
    const current = await this.repository.getSettings();
    if (current.rowVersion !== parsed.data.rowVersion) {
      throw new AppError('VERSION_CONFLICT', 'WB 全局设置已被其他操作修改，请刷新后重试', {
        expected: parsed.data.rowVersion, actual: current.rowVersion
      }, 409);
    }
    const enabled = parsed.data.enabled ?? current.enabled;
    const rootDirectory = parsed.data.rootDirectory ?? current.rootDirectory;
    if (enabled !== current.enabled || rootDirectory !== current.rootDirectory) {
      await this.publishing.initializeSettings({ enabled, rootDirectory });
      const refreshed = await this.repository.getSettings();
      return this.repository.updateSettings({ ...parsed.data, rowVersion: refreshed.rowVersion });
    }
    return this.repository.updateSettings(parsed.data);
  }

  async listStores(includeArchived = false) {
    const items = await this.repository.listStores(includeArchived);
    return { items, total: items.length };
  }

  async createStore(input: unknown) {
    const parsed = wbStoreCreateSchema.safeParse(input);
    if (!parsed.success) throw validationError('无效的 WB 店铺配置', parsed.error.issues);
    if (parsed.data.defaultPresetId) await this.presets.get(parsed.data.defaultPresetId);
    return this.repository.createStore(parsed.data);
  }

  async updateStore(storeId: string, input: unknown) {
    const parsed = wbStoreUpdateSchema.safeParse(input);
    if (!parsed.success) throw validationError('无效的 WB 店铺配置', parsed.error.issues);
    if (parsed.data.defaultPresetId) await this.presets.get(parsed.data.defaultPresetId);
    return this.repository.updateStore(storeId, parsed.data);
  }

  async saveCredential(storeId: string, input: unknown) {
    const parsed = wbStoreCredentialInputSchema.safeParse(input);
    if (!parsed.success) {
      // Never attach the request body or token value to the error details.
      throw new AppError('CONFIG_INVALID', 'WB Token 或 rowVersion 格式无效');
    }
    const encrypted = this.vault.encrypt(parsed.data.token, `wb-store:${storeId}`);
    return this.repository.savePendingCredential(storeId, parsed.data.rowVersion, encrypted);
  }

  async preflight(storeId: string) {
    const context = await this.repository.beginPreflight(storeId);
    const requestRef = `preflight:${storeId}:${context.storeConfigVersion}:${context.credentialVersionId}`;
    const dispatched = await this.publishing.n8n.preflightStore({
      storeId,
      storeAlias: context.store.storeAlias,
      storeConfigVersion: context.storeConfigVersion,
      credentialVersionId: context.credentialVersionId,
      accountCurrency: context.store.accountCurrency,
      requestRef
    });
    return { store: context.store, accepted: dispatched.accepted, requestRef, ...(dispatched.message ? { message: dispatched.message } : {}) };
  }

  async applyPreflightReport(storeId: string, input: unknown) {
    const body = input && typeof input === 'object' && !Array.isArray(input) ? input as JsonRecord : {};
    const report = wbStorePreflightReportSchema.safeParse(body.report);
    const storeConfigVersion = Number(body.storeConfigVersion);
    const credentialVersionId = String(body.credentialVersionId || '');
    if (!report.success || !Number.isInteger(storeConfigVersion) || storeConfigVersion < 1
      || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(credentialVersionId)) {
      throw new AppError('CONFIG_INVALID', 'WB 店铺预检回写格式无效');
    }
    return this.repository.applyPreflightReport(storeId, storeConfigVersion, credentialVersionId, report.data);
  }

  async enable(storeId: string, input: unknown) {
    const parsed = wbStoreMutationSchema.safeParse(input);
    if (!parsed.success) throw validationError('缺少有效的 rowVersion', parsed.error.issues);
    return this.repository.setStoreEnabled(storeId, true, parsed.data.rowVersion);
  }

  async disable(storeId: string, input: unknown) {
    const parsed = wbStoreMutationSchema.safeParse(input);
    if (!parsed.success) throw validationError('缺少有效的 rowVersion', parsed.error.issues);
    return this.repository.setStoreEnabled(storeId, false, parsed.data.rowVersion);
  }

  async archive(storeId: string, input: unknown) {
    const parsed = wbStoreMutationSchema.safeParse(input);
    if (!parsed.success) throw validationError('缺少有效的 rowVersion', parsed.error.issues);
    return this.repository.archiveStore(storeId, parsed.data.rowVersion);
  }

  async publicationPlan(sku: string, input: unknown): Promise<WbPublicationPlan> {
    const parsed = wbPublicationPlanInputSchema.safeParse(input);
    if (!parsed.success) throw validationError('无效的 WB 多店铺发布计划', parsed.error.issues);
    return this.buildPlan(sku, parsed.data);
  }

  async createPublications(sku: string, input: unknown): Promise<{
    publications: WbStorePublication[];
    accepted: number;
    failed: number;
    failures: Array<{ storeId: string; storeAlias: string; code: string; message: string }>;
  }> {
    const parsed = wbPublicationCreateInputSchema.safeParse(input);
    if (!parsed.success) throw validationError('无效的 WB 多店铺发布请求', parsed.error.issues);
    const plan = await this.buildPlan(sku, parsed.data);
    if (plan.planHash !== parsed.data.planHash) {
      throw new AppError('VERSION_CONFLICT', '店铺、预设或草稿已变化，请重新生成发布计划', {
        expectedPlanHash: parsed.data.planHash,
        currentPlanHash: plan.planHash
      }, 409);
    }
    const blocked = plan.items.filter((item) => !item.ready);
    if (blocked.length) throw new AppError('WB_STORE_NOT_READY', '存在尚未就绪的 WB 店铺', {
      stores: blocked.map((item) => ({ storeId: item.storeId, storeAlias: item.storeAlias, blockers: item.blockers }))
    }, 409);
    const settings = await this.repository.getSettings();
    const context = await this.repository.getPlanningContext(sku, parsed.data.draftVersion, plan.items.map((item) => item.storeId));
    const cleanupBatch = this.sourceMediaCleanup ? await this.sourceMediaCleanup.registerManualBatch({
      sku,
      rootDirectory: settings.rootDirectory,
      planHash: plan.planHash,
      draftVersion: context.draftVersion,
      expectedStoreIds: plan.items.map((item) => item.storeId)
    }) : undefined;
    const publications: WbStorePublication[] = [];
    const failures: Array<{ storeId: string; storeAlias: string; code: string; message: string }> = [];
    for (const item of plan.items) {
      try {
        const presetId = item.presetId!;
        const materialized = await this.presets.materializeStoreListing(sku, presetId, {
          ...context.listingData,
          mediaAssets: context.mediaAssets,
          variantMedia: context.variantMedia
        });
        if (materialized.presetDefinitionHash !== item.presetDefinitionHash) {
          throw new AppError('VERSION_CONFLICT', 'WB 店铺默认预设在物化前发生变化，请重新确认发布计划', { storeId: item.storeId }, 409);
        }
        const configSnapshot = {
          draftVersion: context.draftVersion,
          planStoreIds: plan.items.map((planItem) => planItem.storeId),
          storeRowVersion: item.storeRowVersion,
          storeConfigVersion: item.storeConfigVersion,
          settingsRowVersion: settings.rowVersion,
          rootDirectory: settings.rootDirectory,
          warehouseId: item.warehouseId,
          autoPublishMode: item.autoPublishMode,
          presetId,
          presetRowVersion: materialized.preset.rowVersion,
          presetDefinitionHash: item.presetDefinitionHash,
          baseGeneratedVersionId: context.baseGeneratedVersionId || null
        };
        let publication = await this.repository.createMaterializedPublication({
          id: randomUUID(), sku, draftVersion: context.draftVersion,
          storeId: item.storeId, storeAlias: item.storeAlias, presetId,
          presetRowVersion: materialized.preset.rowVersion,
          presetSnapshot: {
            ...(materialized.presetSnapshot as unknown as JsonRecord),
            dependencySnapshot: materialized.dependencySnapshot
          },
          presetDefinitionHash: item.presetDefinitionHash,
          ...(item.credentialVersionId ? { credentialVersionId: item.credentialVersionId } : {}),
          configSnapshot,
          planHash: plan.planHash,
          materializationHash: item.materializationHash,
          categoryVersionId: materialized.category.versionId,
          draftData: context.listingData,
          mediaAssets: context.mediaAssets,
          variantMedia: context.variantMedia,
          productJsonFactory: ({ versionId, revision }) => {
            const compiled = compileProductJsonWithAudit({
              versionId, revision, sku, productName: context.productName, draftVersion: context.draftVersion,
              category: materialized.category, data: materialized.data,
              mediaAssets: context.mediaAssets, variantMedia: context.variantMedia
            });
            return {
              productJson: compiled.productJson as unknown as JsonRecord,
              generationWarnings: compiled.generationWarnings
            };
          }
        });
        if (cleanupBatch) await this.sourceMediaCleanup!.linkManualTarget(cleanupBatch, {
          storeId: item.storeId,
          publicationId: publication.id
        });
        publication = await this.dispatchPublication(sku, publication, item);
        publications.push(publication);
      } catch (error) {
        failures.push({
          storeId: item.storeId,
          storeAlias: item.storeAlias,
          code: error instanceof AppError ? error.code : 'WB_STORE_MATERIALIZATION_FAILED',
          message: error instanceof Error ? error.message : 'WB 店铺版本生成或派发失败'
        });
      }
    }
    const runtimeFailures = publications.filter((publication) => ['NEEDS_ATTENTION', 'FAILED'].includes(publication.status)).length;
    const failed = failures.length + runtimeFailures;
    return { publications, accepted: publications.length - runtimeFailures, failed, failures };
  }

  async listPublications(
    sku: string | undefined,
    input: { skus?: string[]; storeId?: string; status?: string; source?: string; compact?: boolean } = {}
  ) {
    const items = await this.repository.listPublications({ ...(sku ? { sku } : {}), ...input });
    return { items, total: items.length };
  }

  async getPublication(publicationId: string) {
    return this.repository.getPublication(publicationId);
  }

  async syncPublication(publicationId: string) {
    return this.repository.syncPublication(publicationId);
  }

  decryptGatewayCredential(credential: Parameters<WbTokenVault['decrypt']>[0], storeId: string): string {
    return this.vault.decrypt(credential, `wb-store:${storeId}`);
  }

  private async buildPlan(sku: string, input: WbPublicationPlanInput): Promise<WbPublicationPlan> {
    const context = await this.repository.getPlanningContext(sku, input.draftVersion, input.stores.map((selection) => selection.storeId));
    const settings = await this.repository.getSettings();
    const items = await Promise.all(context.stores.map(async (store) => {
      const presetId = store.defaultPresetId;
      let presetRowVersion: number | undefined;
      let presetDefinitionHash: string | undefined;
      let materializationHash: string | undefined;
      let preview: Awaited<ReturnType<WbPresetService['previewStoreListing']>> | undefined;
      const blockers = [...store.readiness.blockers];
      if (context.sourceMediaState === 'CLEANED') {
        blockers.push('公共媒体已在成功上品后清理，请重新投递媒体');
      }
      if (presetId) {
        try {
          preview = await this.presets.previewStoreListing(sku, presetId);
          presetRowVersion = preview.preset.rowVersion;
          presetDefinitionHash = preview.presetDefinitionHash;
          const frozenMaterial = {
            sku: context.sku,
            draftVersion: context.draftVersion,
            listingData: context.listingData,
            mediaAssets: context.mediaAssets,
            variantMedia: context.variantMedia,
            productIdentity: preview.productIdentity,
            descriptionSources: preview.descriptionSources,
            procurementSnapshot: preview.procurementSnapshot,
            settings: {
              rowVersion: settings.rowVersion,
              rootDirectory: settings.rootDirectory,
              timezone: settings.timezone,
              globalConcurrency: settings.globalConcurrency,
              enabled: settings.enabled
            },
            store: {
              id: store.id,
              rowVersion: store.rowVersion,
              configVersion: store.configVersion,
              credentialVersionId: store.credential.activeVersionId || null,
              warehouseId: store.warehouseId,
              defaultPresetId: store.defaultPresetId
            },
            presetDefinitionHash,
            presetRowVersion,
            dependencySnapshot: preview.dependencySnapshot,
            procurementSource: preview.procurementSource,
            packaging: preview.packaging
          };
          materializationHash = `sha256:${createHash('sha256').update(stableJson(frozenMaterial)).digest('hex')}`;
          const missingDefault = blockers.indexOf('店铺默认上品预设未配置');
          if (missingDefault >= 0) blockers.splice(missingDefault, 1);
        } catch (error) {
          blockers.push(error instanceof Error ? error.message : '店铺默认上品预设无法用于当前 SKU');
        }
      } else if (!blockers.includes('店铺默认上品预设未配置')) {
        blockers.push('店铺默认上品预设未配置');
      }
      return {
        storeId: store.id,
        storeAlias: store.storeAlias,
        displayName: store.displayName,
        ...(presetId ? { presetId } : {}),
        ...(preview ? { presetName: preview.preset.name } : {}),
        ...(presetDefinitionHash ? { presetDefinitionHash } : {}),
        ...(materializationHash ? { materializationHash } : {}),
        ...(preview ? {
          discountPercent: preview.discountPercent,
          expectedPriceCny: preview.expectedPriceCny,
          categoryKey: preview.categoryKey,
          categoryName: preview.categoryName,
          packaging: preview.packaging
        } : {}),
        autoPublishMode: store.autoPublishMode,
        ready: blockers.length === 0,
        blockers,
        storeRowVersion: store.rowVersion,
        storeConfigVersion: store.configVersion,
        ...(store.credential.activeVersionId ? { credentialVersionId: store.credential.activeVersionId } : {}),
        warehouseId: store.warehouseId,
        presetRowVersion
      };
    }));
    const canonical = {
      sku,
      draftVersion: context.draftVersion,
      baseGeneratedVersionId: context.baseGeneratedVersionId || null,
      settings: {
        rowVersion: settings.rowVersion,
        rootDirectory: settings.rootDirectory,
        timezone: settings.timezone,
        globalConcurrency: settings.globalConcurrency,
        enabled: settings.enabled
      },
      items: items.map((item) => ({
        storeId: item.storeId,
        storeAlias: item.storeAlias,
        presetId: item.presetId || null,
        presetDefinitionHash: item.presetDefinitionHash || null,
        materializationHash: item.materializationHash || null,
        presetRowVersion: item.presetRowVersion || null,
        storeRowVersion: item.storeRowVersion,
        storeConfigVersion: item.storeConfigVersion,
        credentialVersionId: item.credentialVersionId || null,
        warehouseId: item.warehouseId,
        autoPublishMode: item.autoPublishMode
      })).sort((left, right) => left.storeId.localeCompare(right.storeId))
    };
    return {
      planHash: `sha256:${createHash('sha256').update(stableJson(canonical)).digest('hex')}`,
      sku,
      draftVersion: context.draftVersion,
      createdAt: new Date().toISOString(),
      items: items.map(({ presetRowVersion: _presetRowVersion, ...item }) => ({
        ...item,
        presetDefinitionHash: item.presetDefinitionHash || `sha256:${'0'.repeat(64)}`,
        materializationHash: item.materializationHash || `sha256:${'0'.repeat(64)}`
      }))
    };
  }

  private async dispatchPublication(
    sku: string,
    publication: WbStorePublication,
    item: WbPublicationPlan['items'][number]
  ): Promise<WbStorePublication> {
    if (['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PAUSED'].includes(publication.status)) return publication;
    const taskId = publication.taskId || `${item.storeAlias}__${sku}__r${publication.revision}`;
    const mediaPolicy = item.autoPublishMode === 'COMPATIBLE_UPSERT' ? 'REPLACE_SELECTED' : 'MISSING_ONLY';
    const idempotencyKey = `${item.storeAlias}|${sku}|${publication.revision}${item.autoPublishMode === 'COMPATIBLE_UPSERT' ? `|${publication.id}` : ''}`;
    if (publication.status === 'DISPATCHING' || publication.status === 'NEEDS_ATTENTION') {
      try {
        const raw = await this.publishing.n8n.getJob(taskId);
        if (publication.status === 'NEEDS_ATTENTION') await this.repository.markPublicationDispatching(publication.id);
        return this.repository.markPublicationQueued(publication.id, taskId, raw);
      } catch (error) {
        if (!(error instanceof AppError && error.code === 'JOB_NOT_FOUND' && error.details?.deliveryUnknown === false)) {
          const unknown = unknownDispatchReadbackError(publication, error);
          return this.repository.markPublicationDispatchUnknown(publication.id, taskId, unknown.code, unknown.message);
        }
      }
    }
    let prepared;
    let mediaTargetVendorCodes: string[] = [];
    try {
      if (mediaPolicy === 'REPLACE_SELECTED') {
        mediaTargetVendorCodes = await this.publishing.storePublicationMediaTargetVendorCodes(
          sku,
          publication.generatedVersionId
        );
      }
      const packageInput = {
        sku,
        generatedVersionId: publication.generatedVersionId,
        revision: publication.revision,
        publicationId: publication.id,
        taskId,
        idempotencyKey,
        storeId: item.storeId,
        storeAlias: item.storeAlias,
        ...(item.credentialVersionId ? { credentialVersionId: item.credentialVersionId } : {}),
        storeConfigVersion: item.storeConfigVersion,
        warehouseId: item.warehouseId,
        submissionMode: item.autoPublishMode,
        mediaPolicy,
        ...(mediaTargetVendorCodes.length ? { mediaTargetVendorCodes } : {}),
        materializationHash: item.materializationHash,
        ...(item.autoPublishMode === 'COMPATIBLE_UPSERT' ? { automationRunId: publication.id } : {})
      } as const;
      prepared = await this.publishing.prepareStorePublicationPackage(packageInput);
      publication = await this.repository.recordPublicationPackage(publication.id, {
        packageRelPath: prepared.packageRelPath,
        packageSignature: prepared.packageSignature,
        materializationHash: item.materializationHash
      });
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'STORE_PACKAGE_PREPARATION_FAILED';
      const message = error instanceof Error ? error.message : 'WB 店铺发布目录准备失败';
      return this.repository.markPublicationFailed(publication.id, code, message);
    }
    if (publication.status !== 'DISPATCHING') await this.repository.markPublicationDispatching(publication.id);
    try {
      const task = await this.publishing.n8n.submitListing({
        folderName: sku,
        revision: publication.revision,
        generatedVersionId: publication.generatedVersionId,
        submissionMode: item.autoPublishMode,
        mediaPolicy,
        ...(mediaTargetVendorCodes.length ? { mediaTargetVendorCodes } : {}),
        ...(item.autoPublishMode === 'COMPATIBLE_UPSERT' ? { automationRunId: publication.id } : {}),
        storeId: item.storeId,
        storeAlias: item.storeAlias,
        publicationId: publication.id,
        credentialVersionId: item.credentialVersionId,
        storeConfigVersion: item.storeConfigVersion,
        warehouseId: item.warehouseId,
        idempotencyKey,
        packageRelPath: prepared.packageRelPath,
        packageSignature: prepared.packageSignature,
        materializationHash: item.materializationHash
      });
      return this.repository.markPublicationQueued(publication.id, task.taskId, task.raw);
    } catch (error) {
      const classified = classifyWbPublicationDispatchError(error, { publicationId: publication.id, taskId });
      if (classified.kind === 'REJECTED') {
        return this.repository.markPublicationFailed(publication.id, classified.code, classified.message);
      }
      return this.repository.markPublicationDispatchUnknown(publication.id, taskId, classified.code, classified.message);
    }
  }
}

function validationError(message: string, issues: unknown): AppError {
  return new AppError('CONFIG_INVALID', message, { issues });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
