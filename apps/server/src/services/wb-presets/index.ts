import { createHash, randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import {
  AppError,
  WB_PURCHASE_CHARACTERISTIC_BINDINGS,
  wbListingPresetDefinitionSchema,
  type PricingCalculationResult,
  type PricingProductSnapshot,
  type WbListingPresetDefinition
} from '@n8n-media-review/shared';
import type { ConfigService } from '../../config/service.js';
import type { PricingRepository } from '../../repositories/pricing.js';
import type { PurchaseRepository, ProductIdentityRecord } from '../../repositories/purchases.js';
import { resolveWbTnvedPolicy, type WbRepository } from '../../repositories/wb.js';
import {
  WbPresetRepository,
  type WbListingPresetRecord,
  type WbPresetDependencySnapshot,
  type WbPresetResolvedDependencies
} from '../../repositories/wb-presets.js';
import type { N8nWbClient } from '../wb-publishing/n8n-client.js';
import {
  applyWbPurchaseMeasurementProjection,
  createWbPurchaseMeasurements,
  projectWbPurchaseMeasurements
} from '../wb-purchase-measurements.js';
import { E003DescriptionSourceService } from './e003-description.js';
import { wbMaterialPresetDefinitionHash } from './material-hash.js';
import { WbTitleTranslationClient } from './title-translation.js';

const WB_COLOR_CHARACTERISTIC_ID = 14177449;

export type WbInitializationIssue = {
  code: string;
  message: string;
  field?: string;
  severity: 'WARNING' | 'ERROR';
  retryable: boolean;
};

type ResolvedPreset = {
  dependencies: WbPresetResolvedDependencies;
  snapshot?: WbPresetDependencySnapshot;
  issues: WbInitializationIssue[];
  kizMarked?: boolean;
};

export type WbGrossWeightResolution = {
  source: 'PROCUREMENT' | 'PRESET_FALLBACK';
  effectiveGrossWeightGrams: number;
  procurementGrossWeightGrams: number | null;
  presetGrossWeightGrams: number;
  procurementVersionId: string;
  procurementVersionNo: number;
  procurementCapturedAt: string;
};

export type WbPresetExecutionBinding = {
  schemaVersion: 2;
  presetId: string;
  presetName: string;
  presetRowVersion: number;
  boundAt: string;
  activationStartedAt: string;
  definitionHash: string;
  presetSnapshot: WbListingPresetDefinition;
  dependencySnapshot: WbPresetDependencySnapshot;
};

export type WbBoundPresetContext = {
  binding: WbPresetExecutionBinding;
  preset: WbListingPresetRecord;
  resolved: ResolvedPreset;
};

export class WbPresetService {
  readonly descriptions: E003DescriptionSourceService;
  readonly translations: WbTitleTranslationClient;
  private automationChangeHandler?: () => Promise<void> | void;

  constructor(
    readonly repository: WbPresetRepository,
    private readonly wb: WbRepository,
    private readonly purchases: PurchaseRepository,
    private readonly pricing: PricingRepository,
    private readonly n8n: N8nWbClient,
    config: ConfigService
  ) {
    this.descriptions = new E003DescriptionSourceService(config);
    this.translations = new WbTitleTranslationClient(repository);
  }

  async list() { return Promise.all((await this.repository.list()).map((preset) => this.decorate(preset))); }
  async get(id: string) { return this.decorate(await this.repository.get(id)); }
  setAutomationChangeHandler(handler: () => Promise<void> | void): void { this.automationChangeHandler = handler; }

  async getActiveAutoPreset() {
    const preset = await this.repository.getDefault();
    if (!preset?.autoPublishEnabled || !preset.autoPublishActivatedAt) return undefined;
    return this.decorate(preset);
  }

  createExecutionBinding(
    presetInput: Record<string, any>,
    boundAt = new Date().toISOString(),
    activationStartedAtInput?: string
  ): WbPresetExecutionBinding {
    const presetSnapshot = wbListingPresetDefinitionSchema.parse(stripRecordFields(presetInput as WbListingPresetRecord));
    const dependencySnapshot = parseDependencySnapshot(presetInput.dependencySnapshot);
    const source = {
      schemaVersion: 2 as const,
      presetId: String(presetInput.id || ''),
      presetName: String(presetInput.name || presetSnapshot.name),
      presetRowVersion: Number(presetInput.rowVersion || 0),
      boundAt,
      activationStartedAt: String(activationStartedAtInput || presetInput.autoPublishActivatedAt || ''),
      presetSnapshot,
      dependencySnapshot
    };
    if (!source.presetId || !Number.isInteger(source.presetRowVersion) || source.presetRowVersion < 1 || !source.activationStartedAt) {
      throw new AppError('CONFIG_INVALID', '当前默认自动上品预设缺少有效的绑定身份或激活时间', { presetId: source.presetId }, 409);
    }
    return { ...source, definitionHash: executionBindingHash(source) };
  }

  parseExecutionBinding(input: unknown): WbPresetExecutionBinding {
    const binding = asObject(input);
    const presetSnapshot = wbListingPresetDefinitionSchema.safeParse(binding.presetSnapshot);
    if (Number(binding.schemaVersion) !== 2 || !presetSnapshot.success) {
      throw new AppError('CONFIG_INVALID', '自动上品任务的预设绑定快照无效', { bindingSchemaVersion: binding.schemaVersion }, 409);
    }
    const parsed: WbPresetExecutionBinding = {
      schemaVersion: 2,
      presetId: String(binding.presetId || ''), presetName: String(binding.presetName || presetSnapshot.data.name),
      presetRowVersion: Number(binding.presetRowVersion || 0), boundAt: String(binding.boundAt || ''),
      activationStartedAt: String(binding.activationStartedAt || ''), definitionHash: String(binding.definitionHash || ''),
      presetSnapshot: presetSnapshot.data, dependencySnapshot: parseDependencySnapshot(binding.dependencySnapshot)
    };
    if (!parsed.presetId || !Number.isInteger(parsed.presetRowVersion) || parsed.presetRowVersion < 1
      || !Number.isFinite(Date.parse(parsed.boundAt)) || !Number.isFinite(Date.parse(parsed.activationStartedAt))) {
      throw new AppError('CONFIG_INVALID', '自动上品任务缺少完整的模板绑定信息', { presetId: parsed.presetId }, 409);
    }
    const expectedHash = executionBindingHash({ ...parsed, definitionHash: undefined } as Omit<WbPresetExecutionBinding, 'definitionHash'>);
    if (parsed.definitionHash !== expectedHash) {
      throw new AppError('CONFIG_INVALID', '自动上品任务的模板绑定快照校验失败', { expectedHash, actualHash: parsed.definitionHash }, 409);
    }
    return parsed;
  }

  legacyExecutionBinding(input: { presetId?: string; presetName?: string; presetRowVersion?: number; presetSnapshot?: Record<string, unknown>; createdAt: string }): WbPresetExecutionBinding {
    const snapshot = asObject(input.presetSnapshot);
    const parsed = wbListingPresetDefinitionSchema.safeParse(snapshot);
    if (!parsed.success) throw new AppError('CONFIG_INVALID', '历史自动上品任务缺少可用的预设快照', { issues: parsed.error.issues }, 409);
    const dependencySnapshot = parseDependencySnapshot(snapshot.dependencySnapshot);
    const source = {
      schemaVersion: 2 as const,
      presetId: String(input.presetId || snapshot.id || ''), presetName: String(input.presetName || snapshot.name || parsed.data.name),
      presetRowVersion: Number(input.presetRowVersion || snapshot.rowVersion || 0), boundAt: input.createdAt,
      activationStartedAt: String(snapshot.autoPublishActivatedAt || input.createdAt), presetSnapshot: parsed.data, dependencySnapshot
    };
    if (!source.presetId || !Number.isInteger(source.presetRowVersion) || source.presetRowVersion < 1) {
      throw new AppError('CONFIG_INVALID', '历史自动上品任务缺少模板身份，不能自动改绑当前默认模板', undefined, 409);
    }
    return { ...source, definitionHash: executionBindingHash(source) };
  }

  async resolveExecutionBinding(input: unknown, verifyTnved: boolean): Promise<WbBoundPresetContext> {
    const binding = this.parseExecutionBinding(input);
    const preset = presetRecordFromBinding(binding);
    const resolved = await this.resolve(preset, verifyTnved, binding.dependencySnapshot, true);
    return { binding, preset, resolved };
  }

  async create(input: unknown) {
    const parsed = parsePreset(input);
    assertNoSystemManagedPresetCharacteristics(parsed);
    const resolved = await this.resolve(parsed, true);
    const blocking = resolved.issues.filter((issue) => issue.severity === 'ERROR');
    if (blocking.length) throw new AppError('CONFIG_INVALID', 'WB 上品预设存在阻断问题', { issues: blocking }, 409);
    const preset = await this.repository.create(parsed, resolved.snapshot!, true);
    const output = await this.decorate(preset);
    await this.automationChangeHandler?.();
    return output;
  }

  async update(id: string, input: unknown) {
    const parsed = parsePreset(input);
    assertNoSystemManagedPresetCharacteristics(parsed);
    const resolved = await this.resolve(parsed, true);
    const blocking = resolved.issues.filter((issue) => issue.severity === 'ERROR');
    if (blocking.length) throw new AppError('CONFIG_INVALID', 'WB 上品预设存在阻断问题', { issues: blocking }, 409);
    const preset = await this.repository.update(id, input, resolved.snapshot!, true);
    const output = await this.decorate(preset);
    await this.automationChangeHandler?.();
    return output;
  }

  async clone(id: string, name?: string) {
    const source = await this.repository.get(id);
    const resolved = await this.resolve(source, false);
    if (!resolved.snapshot) throw new AppError('CONFIG_INVALID', '源预设的依赖已失效，不能复制', { issues: resolved.issues }, 409);
    const output = await this.decorate(await this.repository.clone(id, name, resolved.snapshot));
    await this.automationChangeHandler?.();
    return output;
  }

  async setDefault(id: string, rowVersion: number) {
    assertRowVersion(rowVersion);
    const current = await this.repository.get(id);
    const resolved = await this.resolve(current, true);
    const blocking = resolved.issues.filter((issue) => issue.severity === 'ERROR');
    if (blocking.length) throw new AppError('CONFIG_INVALID', '存在阻断问题的预设不能设为默认', { issues: blocking }, 409);
    const output = await this.decorate(await this.repository.setDefault(id, rowVersion));
    await this.automationChangeHandler?.();
    return output;
  }

  async delete(id: string, rowVersion: number) {
    assertRowVersion(rowVersion);
    const output = await this.repository.delete(id, rowVersion);
    await this.automationChangeHandler?.();
    return output;
  }

  async assertDefaultConfigured(): Promise<void> {
    const preset = await this.repository.getDefault();
    if (!preset) throw new AppError('WB_DEFAULT_PRESET_REQUIRED', '请先创建并设置一个默认的 WB 上品预设模板', undefined, 409);
    const resolved = await this.resolve(preset, false);
    const blocking = resolved.issues.filter((item) => item.severity === 'ERROR');
    if (!resolved.snapshot || blocking.length) {
      throw new AppError('CONFIG_INVALID', '默认 WB 上品预设已失效，请修复后再新建产品资料', { presetId: preset.id, issues: blocking }, 409);
    }
  }

  async descriptionSource(skuInput: string) {
    const identity = await this.requireIdentity(normalizeSku(skuInput));
    return this.descriptions.resolveVariants(
      identity.sku,
      identity.productName,
      descriptionIdentityVariants(identity).map((variant) => ({ variantId: variant.variantId, name: variant.name }))
    );
  }

  async createListing(skuInput: string, options: {
    automatic?: boolean;
    presetBinding?: WbPresetExecutionBinding;
    productVariantIds?: string[];
    operationRef?: string;
  } = {}) {
    const sku = normalizeSku(skuInput);
    const existing = await this.wb.getListing(sku).catch((error) => {
      if (error instanceof AppError && error.code === 'NOT_FOUND' && error.message.includes('草稿')) return undefined;
      throw error;
    });
    if (existing) return existing;
    const bound = options.presetBinding ? await this.resolveExecutionBinding(options.presetBinding, true) : undefined;
    const preset = bound?.preset || await this.repository.getDefault();
    if (!preset) throw new AppError('WB_DEFAULT_PRESET_REQUIRED', '请先创建并设置一个默认的 WB 上品预设模板', undefined, 409);
    const resolved = bound?.resolved || await this.resolve(preset, true);
    const blocking = resolved.issues.filter((issue) => issue.severity === 'ERROR');
    if (!resolved.snapshot || !resolved.dependencies.category || blocking.length) {
      throw new AppError('CONFIG_INVALID', bound ? '该自动任务绑定的 WB 上品预设快照已失效' : '默认 WB 上品预设已失效，请修复后再新建产品资料', { presetId: preset.id, issues: blocking }, 409);
    }
    const identity = filterIdentityVariants(
      await this.requireIdentity(sku),
      options.productVariantIds
    );
    const initialized = await this.buildInitialization(identity, preset, resolved);
    const created = await this.repository.createInitializedListing({
      sku,
      categoryKey: preset.categoryKey,
      categoryVersionId: resolved.dependencies.category.versionId,
      data: initialized.data,
      automatic: options.automatic === true,
      operationRef: options.operationRef
    });
    return created ? this.wb.getListing(sku) : this.wb.getListing(sku);
  }

  async createPublicMaterialListing(skuInput: string) {
    const sku = normalizeSku(skuInput);
    const existing = await this.wb.getListing(sku).catch((error) => {
      if (error instanceof AppError && error.code === 'NOT_FOUND' && error.message.includes('草稿')) return undefined;
      throw error;
    });
    if (existing) return existing;
    const identity = await this.requireIdentity(sku);
    const sourceVariants = descriptionIdentityVariants(identity);
    const variants = sourceVariants.map((variant, index) => {
      const vendorCode = `${sku}-${String(index + 1).padStart(2, '0')}`;
      return {
        variantId: randomUUID(),
        productVariantId: variant.variantId,
        productVariantName: variant.name,
        ...(variant.wbColor ? { productVariantColor: variant.wbColor } : {}),
        variantCode: vendorCode,
        vendorCode,
        characteristics: [],
        sizes: []
      };
    });
    await this.repository.createPublicMaterialListing({
      sku,
      data: {
        variants,
        initialization: {
          schemaVersion: 1,
          kind: 'PUBLIC_MATERIAL',
          createdAt: new Date().toISOString()
        },
        initializationIssues: []
      }
    });
    return this.wb.getListing(sku);
  }

  async previewStoreListing(skuInput: string, presetId: string) {
    const sku = normalizeSku(skuInput);
    const preset = await this.repository.get(presetId);
    const resolved = await this.resolve(preset, true, preset.dependencySnapshot, true);
    const blocking = resolved.issues.filter((issue) => issue.severity === 'ERROR');
    if (!resolved.dependencies.category || blocking.length) {
      throw new AppError('CONFIG_INVALID', '店铺默认 WB 上品预设已失效', { presetId, issues: blocking }, 409);
    }
    const identity = await this.requireIdentity(sku);
    const identityVariants = descriptionIdentityVariants(identity);
    const descriptions = await this.descriptions.resolveVariants(
      identity.sku,
      identity.productName,
      identityVariants.map((variant) => ({ variantId: variant.variantId, name: variant.name }))
    );
    const purchase = (await this.purchases.findPricingProducts({ kind: 'SKU', sku }))[0];
    if (!purchase) throw new AppError('NOT_FOUND', '没有找到该 SKU 的最新采购版本', { sku }, 404);
    const grossWeightResolution = resolveGrossWeight(purchase, preset.packaging.grossWeightGrams, new Date().toISOString());
    const pricing = await this.calculatePrice(identity, preset, preset.dependencySnapshot, {
      product: purchase,
      actualWeightGrams: grossWeightResolution.effectiveGrossWeightGrams
    });
    const category = resolved.dependencies.category;
    return {
      preset,
      presetSnapshot: stripRecordFields(preset),
      dependencySnapshot: preset.dependencySnapshot,
      presetDefinitionHash: wbMaterialPresetDefinitionHash({ presetSnapshot: preset, dependencySnapshot: preset.dependencySnapshot }),
      discountPercent: preset.discountPercent,
      expectedPriceCny: pricing.listingPriceCny,
      categoryKey: preset.categoryKey,
      categoryName: category.nameZh || category.nameRu,
      packaging: { ...preset.packaging, grossWeightGrams: grossWeightResolution.effectiveGrossWeightGrams },
      procurementSource: pricing.procurementSource,
      procurementSnapshot: purchase.procurement,
      productIdentity: {
        sku: identity.sku,
        productName: identity.productName,
        variants: identityVariants.map((variant) => ({
          variantId: variant.variantId,
          name: variant.name,
          ...(variant.wbColor ? { wbColor: variant.wbColor } : {})
        }))
      },
      descriptionSources: {
        status: descriptions.status,
        variantSources: descriptions.variantSources.map((item) => ({
          productVariantId: item.productVariantId,
          status: item.status,
          ...(item.source ? { source: item.source } : {})
        }))
      },
      categoryVersionId: category.versionId,
      issues: resolved.issues
    };
  }

  async materializeStoreListing(skuInput: string, presetId: string, existingListing: Record<string, unknown>) {
    const sku = normalizeSku(skuInput);
    const preset = await this.repository.get(presetId);
    const resolved = await this.resolve(preset, true, preset.dependencySnapshot, true);
    const blocking = resolved.issues.filter((issue) => issue.severity === 'ERROR');
    if (!resolved.dependencies.category || blocking.length) {
      throw new AppError('CONFIG_INVALID', '店铺默认 WB 上品预设已失效', { presetId, issues: blocking }, 409);
    }
    const initialized = await this.buildInitialization(await this.requireIdentity(sku), preset, resolved, existingListing);
    return {
      data: initialized.data,
      category: resolved.dependencies.category,
      preset,
      presetSnapshot: stripRecordFields(preset),
      dependencySnapshot: preset.dependencySnapshot,
      presetDefinitionHash: wbMaterialPresetDefinitionHash({ presetSnapshot: preset, dependencySnapshot: preset.dependencySnapshot })
    };
  }

  async rebuildListing(
    skuInput: string,
    binding: WbPresetExecutionBinding,
    operationRef?: string,
    allowGeneratedStoreFanout = false,
    generationFence?: { jobId: string; runId: string; rowVersion: number }
  ) {
    const sku = normalizeSku(skuInput);
    const existing = await this.wb.getListing(sku);
    const bound = await this.resolveExecutionBinding(binding, true);
    const blocking = bound.resolved.issues.filter((issue) => issue.severity === 'ERROR');
    if (!bound.resolved.snapshot || !bound.resolved.dependencies.category || blocking.length) {
      throw new AppError('CONFIG_INVALID', '该兼容任务绑定的 WB 上品预设快照已失效', { presetId: bound.preset.id, issues: blocking }, 409);
    }
    const identity = await this.requireIdentity(sku);
    const initialized = await this.buildInitialization(identity, bound.preset, bound.resolved, existing as Record<string, unknown>);
    await this.repository.replaceInitializedListing({
      sku,
      categoryKey: bound.preset.categoryKey,
      categoryVersionId: bound.resolved.dependencies.category.versionId,
      data: initialized.data,
      operationRef,
      allowGeneratedStoreFanout,
      generationFence
    });
    return this.wb.getListing(sku);
  }

  async initializeMissing(skuInput: string, draftVersion: number, options: { automatic?: boolean; operationRef?: string } = {}) {
    const sku = normalizeSku(skuInput);
    const listing = await this.wb.getListing(sku);
    if (!Number.isInteger(draftVersion) || draftVersion < 1) throw new AppError('CONFIG_INVALID', '缺少有效的 draftVersion');
    const initialization = asObject((listing as Record<string, any>).initialization);
    const snapshotInput = asObject(initialization.presetSnapshot);
    const parsed = wbListingPresetDefinitionSchema.safeParse(snapshotInput);
    if (!parsed.success) throw new AppError('CONFIG_INVALID', '该草稿没有可重试的预设快照', { issues: parsed.error.issues }, 409);
    const preset = { ...parsed.data, id: String(initialization.presetId || ''), rowVersion: Number(initialization.presetRowVersion || 1), dependencySnapshot: asObject(initialization.dependencySnapshot) } as WbListingPresetRecord;
    const identity = await this.requireIdentity(sku);
    const resolved = await this.resolve(preset, true, preset.dependencySnapshot, true);
    const originalVersions = asObject(initialization.resolvedVersions);
    const dependencyDrift = Boolean(resolved.snapshot && (
      originalVersions.pricingTemplateVersionId !== resolved.snapshot.pricingTemplateVersionId
      || originalVersions.shippingTemplateVersionId !== resolved.snapshot.shippingTemplateVersionId
      || originalVersions.categoryVersionId !== resolved.snapshot.categoryVersionId
    ));
    if (dependencyDrift) {
      resolved.issues.push(issue('PRESET_DEPENDENCY_DRIFT', '预设依赖版本已变化，重试不会使用不同版本覆盖原草稿，请新建资料或手工填写', undefined, 'ERROR', false));
    }
    const listingVariants = Array.isArray(listing.variants) ? listing.variants.map((value) => asObject(value)) : [];
    const expectedDescriptionVariantIds = new Set(descriptionIdentityVariants(identity).map((variant) => variant.variantId));
    const missingVariantDescriptions = listingVariants.filter((variant) => {
      const productVariantId = String(variant.productVariantId || '');
      return expectedDescriptionVariantIds.has(productVariantId) && !String(variant.descriptionRu || '').trim();
    });
    const requested = {
      price: !dependencyDrift && !(Number(listing.priceCny) > 0),
      title: !String(listing.titleRu || '').trim(),
      description: !String(listing.descriptionRu || '').trim() || missingVariantDescriptions.length > 0
    };
    const capturedGrossWeightGrams = storedGrossWeightGrams(initialization.grossWeightResolution);
    const retried = await this.buildRuntimeFields(
      identity,
      preset,
      requested,
      preset.dependencySnapshot,
      capturedGrossWeightGrams === undefined ? undefined : { actualWeightGrams: capturedGrossWeightGrams }
    );
    const retriedVariantDescriptions = asObject(retried.variantDescriptions);
    if (requested.description && Object.keys(retriedVariantDescriptions).length) {
      retried.patch.variants = listingVariants.map((variant) => {
        if (String(variant.descriptionRu || '').trim()) return variant;
        const descriptionRu = String(retriedVariantDescriptions[String(variant.productVariantId || '')] || '');
        return descriptionRu ? { ...variant, descriptionRu } : variant;
      });
    }
    const previousIssues = (Array.isArray(initialization.issues) ? initialization.issues : []).filter((candidate) => {
      const field = String(asObject(candidate).field || '');
      if (field === 'priceCny' && Number(listing.priceCny) > 0) return false;
      if (field === 'titleRu' && String(listing.titleRu || '').trim()) return false;
      if (field === 'descriptionRu' && String(listing.descriptionRu || '').trim()) return false;
      const variantMatch = field.match(/^variants\.([^.]+)\.descriptionRu$/);
      if (variantMatch && listingVariants.some((variant) => String(variant.productVariantId || '') === variantMatch[1] && String(variant.descriptionRu || '').trim())) return false;
      return true;
    });
    const issues = reconcileRetryIssues(previousIssues, resolved.issues, retried.issues, requested);
    const nextInitialization = { ...initialization, issues, lastRetriedAt: new Date().toISOString(), ...(retried.pricing ? { pricing: retried.pricing } : {}), ...(retried.titleSource ? { title: retried.titleSource } : {}), ...(retried.descriptionSource ? { description: retried.descriptionSource } : {}) };
    await this.repository.patchMissingListing({
      sku,
      draftVersion,
      patch: retried.patch,
      initialization: nextInitialization,
      automatic: options.automatic === true,
      operationRef: options.operationRef
    });
    return this.wb.getListing(sku);
  }

  private async decorate(preset: WbListingPresetRecord) {
    const resolved = await this.resolve(preset, false);
    const snapshot = preset.dependencySnapshot;
    const drift = Boolean(resolved.snapshot && (
      snapshot.pricingTemplateVersionId !== resolved.snapshot.pricingTemplateVersionId
      || snapshot.shippingTemplateVersionId !== resolved.snapshot.shippingTemplateVersionId
      || snapshot.categoryVersionId !== resolved.snapshot.categoryVersionId
    ));
    const broken = resolved.issues.some((item) => item.severity === 'ERROR');
    const categoryDependency = resolved.dependencies.category
      ? withoutLiveSchema(resolved.dependencies.category)
      : undefined;
    const resolvedDependencies = {
      ...(resolved.dependencies.pricing ? { pricing: { ...resolved.dependencies.pricing, snapshotVersionId: snapshot.pricingTemplateVersionId, snapshotVersionNo: snapshot.pricingTemplateVersionNo } } : {}),
      ...(resolved.dependencies.shipping ? { shipping: { ...resolved.dependencies.shipping, snapshotVersionId: snapshot.shippingTemplateVersionId, snapshotVersionNo: snapshot.shippingTemplateVersionNo } } : {}),
      ...(categoryDependency ? { category: { ...categoryDependency, snapshotVersionId: snapshot.categoryVersionId, snapshotVersionNo: snapshot.categoryVersionNo } } : {})
    };
    const { isDefault: _legacyIsDefault, ...publicPreset } = preset;
    void _legacyIsDefault;
    return {
      ...publicPreset,
      readiness: broken ? 'BROKEN' : drift ? 'DRIFT' : 'READY',
      issues: [...resolved.issues, ...(drift ? [issue('DEPENDENCY_VERSION_DRIFT', '定价、运费或类目模板已有新的发布版本；新建资料会跟随最新版本', undefined, 'WARNING', false)] : [])],
      resolvedDependencies
    };
  }

  private async resolve(
    definition: WbListingPresetDefinition,
    verifyTnved: boolean,
    expectedSnapshot?: WbPresetDependencySnapshot,
    boundExecution = false
  ): Promise<ResolvedPreset> {
    const dependencies = expectedSnapshot
      ? await this.repository.resolveDependenciesAtSnapshot(definition, expectedSnapshot)
      : await this.repository.resolveDependencies(definition);
    const issues: WbInitializationIssue[] = [];
    const pricing = dependencies.pricing;
    const shipping = dependencies.shipping;
    const category = dependencies.category;
    if (!pricing || (!boundExecution && !pricing.active)) issues.push(issue('PRICING_TEMPLATE_UNAVAILABLE', '定价模板不存在、未发布或已停用', 'pricingTemplateId', 'ERROR', false));
    else if (pricing.platformCode !== 'WB') issues.push(issue('PRICING_PLATFORM_MISMATCH', '定价模板必须属于 WB 平台', 'pricingTemplateId', 'ERROR', false));
    else if (String(pricing.definition.costCurrencyCode) !== 'CNY') issues.push(issue('PRICING_CURRENCY_MISMATCH', '定价模板成本币种必须为 CNY', 'pricingTemplateId', 'ERROR', false));
    if (!shipping || (!boundExecution && (!shipping.active || !shipping.carrierActive))) issues.push(issue('SHIPPING_TEMPLATE_UNAVAILABLE', '运费模板不存在、未发布或已停用', 'shippingTemplateId', 'ERROR', false));
    else if (shipping.platformCode !== 'WB') issues.push(issue('SHIPPING_PLATFORM_MISMATCH', '运费模板必须属于 WB 平台', 'shippingTemplateId', 'ERROR', false));
    if (!category || (!boundExecution && !category.active)) issues.push(issue('CATEGORY_TEMPLATE_UNAVAILABLE', 'WB 类目模板不存在、未发布或已停用', 'categoryKey', 'ERROR', false));
    let tnvedCharacteristicId: number | undefined;
    let tnvedRequired = false;
    if (category) {
      const configuredTnvedCharacteristicId = Number(asObject(category.formConfig.compliance).tnvedCharacteristicId || 0);
      const tnvedPolicy = resolveWbTnvedPolicy(category.formConfig, category.liveSchema);
      tnvedCharacteristicId = tnvedPolicy.characteristicId || undefined;
      tnvedRequired = tnvedPolicy.required;
      if (Number.isInteger(configuredTnvedCharacteristicId) && configuredTnvedCharacteristicId > 0 && !tnvedCharacteristicId) {
        issues.push(issue('CATEGORY_TNVED_FIELD_MISSING', '类目模板配置的 TNVED characteristic 不存在于已发布表单字段中', 'categoryKey', 'ERROR', false));
      }
      if (tnvedRequired && !definition.tnved) {
        issues.push(issue('TNVED_REQUIRED', 'TNVED为必填项目', 'tnved', 'ERROR', false));
      }
      if (String(category.formConfig.sizeMode || 'sized') !== 'sizeless' && definition.sizes.some((size) => !String(size.techSize || '').trim())) {
        issues.push(issue('TECH_SIZE_REQUIRED', '有尺码类目的每一行预设尺码都必须填写 techSize', 'sizes', 'ERROR', false));
      }
      validatePresetCharacteristicDefaults(definition, category, issues);
    }
    let selectedService: Record<string, any> | undefined;
    if (shipping) {
      const services = Array.isArray(shipping.definition.services) ? shipping.definition.services.map(asObject) : [];
      selectedService = services.find((service) => String(service.code || '').toUpperCase() === definition.shippingServiceCode);
      if (!selectedService) issues.push(issue('SHIPPING_SERVICE_NOT_FOUND', '服务渠道不属于当前运费模板的已发布版本', 'shippingServiceCode', 'ERROR', false));
      else {
        const supported = [...new Set((Array.isArray(selectedService.rules) ? selectedService.rules : []).flatMap((rule) => Array.isArray(asObject(rule).destinationCountryCodes) ? asObject(rule).destinationCountryCodes : []).map(String))];
        if (supported.length && !definition.destinationCountryCode) issues.push(issue('DESTINATION_REQUIRED', '所选服务渠道要求填写目的国家', 'destinationCountryCode', 'ERROR', false));
        if (definition.destinationCountryCode && supported.length && !supported.includes(definition.destinationCountryCode)) issues.push(issue('DESTINATION_UNSUPPORTED', '服务渠道不支持所选目的国家', 'destinationCountryCode', 'ERROR', false));
      }
    }
    let kizMarked: boolean | undefined;
    if (category && definition.tnved) {
      if (!tnvedCharacteristicId) {
        issues.push(issue('TNVED_NOT_SUPPORTED_BY_CATEGORY', '当前 WB 类目不支持 TNVED，请将预设中的 TNVED 留空', 'tnved', 'ERROR', false));
      } else if (verifyTnved) {
        try { kizMarked = await resolveTnvedKiz(this.n8n, category.subjectId, definition.tnved); }
        catch (error) { issues.push(issue('TNVED_INVALID', error instanceof Error ? error.message : '无法验证 TNVED', 'tnved', 'ERROR', true)); }
      }
    }
    if (!this.translations.supportsWorkflow(definition.titleTranslation.workflowId)) issues.push(issue('TITLE_TRANSLATION_WORKFLOW_UNSUPPORTED', '当前服务没有配置该标题翻译工作流 ID 的 webhook 映射', 'titleTranslation.workflowId', 'ERROR', false));
    else if (!this.translations.configured) issues.push(issue('TITLE_TRANSLATION_UNAVAILABLE', '标题翻译工作流尚未配置；预设可以保存，但新建时标题可能为空', 'titleTranslation.workflowId', 'WARNING', true));
    const snapshot = pricing && shipping && category ? {
      pricingTemplateVersionId: pricing.versionId, pricingTemplateVersionNo: pricing.versionNo,
      shippingTemplateVersionId: shipping.versionId, shippingTemplateVersionNo: shipping.versionNo,
      categoryVersionId: category.versionId, categoryVersionNo: category.versionNo,
      capturedAt: new Date().toISOString()
    } : undefined;
    if (expectedSnapshot && snapshot && (
      snapshot.pricingTemplateVersionId !== expectedSnapshot.pricingTemplateVersionId
      || snapshot.shippingTemplateVersionId !== expectedSnapshot.shippingTemplateVersionId
      || snapshot.categoryVersionId !== expectedSnapshot.categoryVersionId
    )) issues.push(issue('PRESET_DEPENDENCY_SNAPSHOT_MISMATCH', '自动上品任务的模板依赖快照不一致', undefined, 'ERROR', false));
    return { dependencies, snapshot, issues, ...(kizMarked === undefined ? {} : { kizMarked }) };
  }

  private async buildInitialization(
    identity: ProductIdentityRecord,
    preset: WbListingPresetRecord,
    resolved: ResolvedPreset,
    existingListing?: Record<string, unknown>
  ) {
    const category = resolved.dependencies.category!;
    const pricingProducts = await this.purchases.findPricingProducts({ kind: 'SKU', sku: identity.sku });
    const purchase = pricingProducts[0];
    if (!purchase) throw new AppError('NOT_FOUND', '没有找到该 SKU 的最新采购版本', { sku: identity.sku }, 404);
    const grossWeightResolution = resolveGrossWeight(
      purchase,
      preset.packaging.grossWeightGrams,
      new Date().toISOString()
    );
    const runtime = await this.buildRuntimeFields(
      identity,
      preset,
      { price: true, title: true, description: true },
      resolved.snapshot,
      { product: purchase, actualWeightGrams: grossWeightResolution.effectiveGrossWeightGrams }
    );
    const purchaseMeasurements = projectWbPurchaseMeasurements(
      createWbPurchaseMeasurements({
        procurementVersionId: purchase.procurement.id,
        procurementVersionNo: purchase.procurement.versionNo,
        productHeightCm: purchase.procurement.productHeightCm,
        productDepthCm: purchase.procurement.productDepthCm,
        productWidthCm: purchase.procurement.productWidthCm,
        netWeightGrams: purchase.procurement.netWeightGrams
      }),
      category.formConfig,
      category.liveSchema
    );
    const tnvedCharacteristicId = categoryTnvedCharacteristicId(category);
    const sharedCharacteristics = cloneCharacteristics(preset.sharedCharacteristics)
      .filter((characteristic) => characteristic.id !== tnvedCharacteristicId);
    if (tnvedCharacteristicId && preset.tnved) sharedCharacteristics.push({ id: tnvedCharacteristicId, value: [preset.tnved] });
    const sized = String(category.formConfig.sizeMode || 'sized') !== 'sizeless';
    const coloredVariants = identity.variants.filter((variant) => variant.wbColor);
    const sourceVariants = coloredVariants.length ? coloredVariants : identity.variants;
    const categorySupportsColor = Array.isArray(category.formConfig.fields)
      && category.formConfig.fields.some((field: any) => Number(field?.characteristicId) === WB_COLOR_CHARACTERISTIC_ID);
    const existingVariants = Array.isArray(existingListing?.variants)
      ? existingListing.variants.map((value) => asObject(value))
      : [];
    const usedExisting = new Set<Record<string, any>>();
    const byProductVariantId = new Map(existingVariants
      .filter((variant) => String(variant.productVariantId || ''))
      .map((variant) => [String(variant.productVariantId), variant]));
    const byColorKey = new Map<string, Record<string, any>[]>();
    for (const variant of existingVariants) {
      const colorKey = String(asObject(variant.productVariantColor).colorKey || '');
      if (colorKey) byColorKey.set(colorKey, [...(byColorKey.get(colorKey) || []), variant]);
    }
    let nextVendorSuffix = Math.max(0, ...existingVariants.map((variant) => {
      const match = String(variant.vendorCode || '').match(new RegExp(`^${identity.sku}-(\\d+)$`));
      return match ? Number(match[1]) : 0;
    })) + 1;
    const variantDescriptions = asObject(runtime.variantDescriptions);
    const variants = sourceVariants.map((variant) => {
      let previous = byProductVariantId.get(variant.variantId);
      if (!previous && variant.wbColor) {
        const matches = byColorKey.get(variant.wbColor.colorKey) || [];
        if (matches.length === 1) previous = matches[0];
      }
      if (previous) usedExisting.add(previous);
      const vendorCode = previous?.vendorCode
        ? String(previous.vendorCode)
        : `${identity.sku}-${String(nextVendorSuffix++).padStart(2, '0')}`;
      return {
      variantId: previous?.variantId ? String(previous.variantId) : randomUUID(), productVariantId: variant.variantId, productVariantName: variant.name,
      ...(variant.wbColor ? { productVariantColor: variant.wbColor } : {}),
      variantCode: previous?.variantCode ? String(previous.variantCode) : vendorCode,
      vendorCode,
      ...(String(variantDescriptions[variant.variantId] || '') ? { descriptionRu: String(variantDescriptions[variant.variantId]) } : {}),
      characteristics: (() => {
        const characteristics = cloneCharacteristics(preset.variantCharacteristics);
        if (!variant.wbColor || !categorySupportsColor) return characteristics;
        return [...characteristics.filter((item) => item.id !== WB_COLOR_CHARACTERISTIC_ID), { id: WB_COLOR_CHARACTERISTIC_ID, value: [variant.wbColor.nameRu] }];
      })(),
      sizes: (sized ? preset.sizes : [preset.sizes[0]!]).map((size) => ({
        sizeId: randomUUID(), ...(sized && size.techSize ? { techSize: size.techSize } : {}), ...(sized && size.wbSize ? { wbSize: size.wbSize } : {}),
        ...(sized && size.insoleLengthCm ? { insoleLengthCm: size.insoleLengthCm } : {}), barcode: '', stock: size.stock
      }))
    }; });
    const preservedVariants = existingVariants.filter((variant) => !usedExisting.has(variant));
    const compatibilityWarnings = preservedVariants.map((variant) => issue(
      'UNMANAGED_EXISTING_VARIANT_PRESERVED',
      `WB 已有变体 ${String(variant.vendorCode || '未知编码')} 不在当前 MerchRoute 产品变体中，本轮保留不动`,
      undefined,
      'WARNING',
      false
    ));
    const appliedAt = new Date().toISOString();
    const initialization = {
      presetId: preset.id, presetName: preset.name, presetRowVersion: preset.rowVersion, appliedAt,
      presetSnapshot: stripRecordFields(preset), dependencySnapshot: preset.dependencySnapshot,
      resolvedVersions: resolved.snapshot, grossWeightResolution, issues: [...resolved.issues, ...runtime.issues, ...compatibilityWarnings],
      ...(runtime.pricing ? { pricing: runtime.pricing } : {}), ...(runtime.titleSource ? { title: runtime.titleSource } : {}), ...(runtime.descriptionSource ? { description: runtime.descriptionSource } : {})
    };
    return {
      data: applyWbPurchaseMeasurementProjection({
        brand: preset.brand, titleRu: runtime.patch.titleRu || '', descriptionRu: runtime.patch.descriptionRu || '',
        packaging: { ...preset.packaging, grossWeightGrams: grossWeightResolution.effectiveGrossWeightGrams },
        priceCny: runtime.patch.priceCny || 0, discountPercent: preset.discountPercent,
        clubDiscount: preset.clubDiscount, videoUploadMode: categoryDefaultVideoUploadMode(category.formConfig),
        compliance: { tnved: preset.tnved, kizMarked: resolved.kizMarked === true },
        sharedCharacteristics, variants, initialization, initializationIssues: initialization.issues
      }, purchaseMeasurements)
    };
  }

  private async buildRuntimeFields(
    identity: ProductIdentityRecord,
    preset: WbListingPresetDefinition,
    requested: { price: boolean; title: boolean; description: boolean },
    expectedVersions?: WbPresetDependencySnapshot,
    pricingContext?: { product?: PricingProductSnapshot; actualWeightGrams?: number }
  ) {
    const patch: Record<string, unknown> = {};
    const issues: WbInitializationIssue[] = [];
    let pricingSummary: Record<string, unknown> | undefined;
    let titleSource: Record<string, unknown> | undefined;
    let descriptionSource: Record<string, unknown> | undefined;
    let variantDescriptions: Record<string, string> | undefined;
    if (requested.price) {
      try {
        const calculated = await this.calculatePrice(identity, preset, expectedVersions, pricingContext);
        patch.priceCny = calculated.listingPriceCny;
        pricingSummary = calculated;
        if (Math.abs(calculated.differenceCny) >= 0.01) {
          issues.push(issue('MERCHANT_DISCOUNT_PRICING_MISMATCH', '商家折扣与定价模板折扣率不同，预计折后价与定价目标成交价存在差额', 'discountPercent', 'WARNING', false));
        }
      } catch (error) { issues.push(issue('PRICE_INITIALIZATION_FAILED', errorMessage(error), 'priceCny', 'ERROR', true)); }
    }
    if (requested.title) {
      try {
        const requestHash = createHash('sha256').update(JSON.stringify({ sku: identity.sku, content: identity.productName, language: preset.titleTranslation.language, maxLength: preset.titleTranslation.maxLength, workflowId: preset.titleTranslation.workflowId })).digest('hex').slice(0, 20);
        const translated = await this.translations.translate({
          content: identity.productName, language: preset.titleTranslation.language, maxLength: preset.titleTranslation.maxLength,
          workflowId: preset.titleTranslation.workflowId, requestId: `wb-title-${identity.sku}-${requestHash}`
        });
        patch.titleRu = translated.contentTranslate;
        titleSource = { type: 'N8N_TRANSLATION', workflowId: preset.titleTranslation.workflowId, sourceProductName: identity.productName, language: preset.titleTranslation.language, cached: translated.cached, importedAt: new Date().toISOString() };
      } catch (error) { issues.push(issue('TITLE_TRANSLATION_FAILED', errorMessage(error), 'titleRu', 'ERROR', true)); }
    }
    if (requested.description) {
      try {
        const expectedVariants = descriptionIdentityVariants(identity);
        const descriptions = await this.descriptions.resolveVariants(
          identity.sku,
          identity.productName,
          expectedVariants.map((variant) => ({ variantId: variant.variantId, name: variant.name }))
        );
        variantDescriptions = {};
        for (const result of descriptions.variantSources) {
          const field = `variants.${result.productVariantId}.descriptionRu`;
          if (result.content && result.source) {
            variantDescriptions[result.productVariantId] = result.content;
            if (result.status === 'FALLBACK') {
              issues.push(issue('E003_DESCRIPTION_FALLBACK', `变体“${result.productVariantName}”的最新详情 TXT 不可用，已回退到上一份有效 E003 详情 TXT`, field, 'WARNING', false));
            }
          } else {
            issues.push(issue(
              result.status === 'AMBIGUOUS' ? 'E003_DESCRIPTION_AMBIGUOUS' : 'E003_DESCRIPTION_MISSING',
              result.message || `没有找到变体“${result.productVariantName}”的最新有效 E003 详情 TXT`,
              field,
              'WARNING',
              result.status !== 'AMBIGUOUS'
            ));
          }
        }
        const firstDescription = expectedVariants.map((variant) => variantDescriptions?.[variant.variantId]).find(Boolean);
        if (firstDescription) {
          patch.descriptionRu = firstDescription;
        }
        descriptionSource = {
          type: 'E003',
          status: descriptions.status,
          variantSources: descriptions.variantSources.map((result) => ({
            productVariantId: result.productVariantId,
            productVariantName: result.productVariantName,
            status: result.status,
            ...(result.source ? { ...result.source } : {}),
            ...(result.message ? { message: result.message } : {})
          })),
          importedAt: new Date().toISOString()
        };
      } catch (error) {
        issues.push(issue('E003_DESCRIPTION_MISSING', errorMessage(error), 'descriptionRu', 'WARNING', true));
      }
    }
    return { patch, issues, pricing: pricingSummary, titleSource, descriptionSource, variantDescriptions };
  }

  private async calculatePrice(
    identity: ProductIdentityRecord,
    preset: WbListingPresetDefinition,
    expectedVersions?: WbPresetDependencySnapshot,
    pricingContext?: { product?: PricingProductSnapshot; actualWeightGrams?: number }
  ) {
    const product = pricingContext?.product
      || (await this.purchases.findPricingProducts({ kind: 'SKU', sku: identity.sku }))[0];
    if (!product) throw new AppError('NOT_FOUND', '没有找到该 SKU 的采购成本资料', { sku: identity.sku }, 404);
    const actualWeightGrams = positiveNumber(pricingContext?.actualWeightGrams)
      ?? Number(preset.packaging.grossWeightGrams);
    const result = await this.pricing.calculate({
      pricingTemplateId: preset.pricingTemplateId,
      shippingTemplateIds: [preset.shippingTemplateId],
      item: {
        sku: identity.sku, productName: identity.productName, purchaseCost: product.procurement.purchasePrice,
        domesticFreight: product.procurement.courierFee, actualWeightGrams: String(actualWeightGrams),
        lengthCm: String(preset.packaging.lengthCm), widthCm: String(preset.packaging.widthCm), heightCm: String(preset.packaging.heightCm),
        ...(preset.destinationCountryCode ? { destinationCountryCode: preset.destinationCountryCode } : {})
      }
    }) as PricingCalculationResult;
    if (expectedVersions && result.pricingTemplate.versionId !== expectedVersions.pricingTemplateVersionId) {
      throw new AppError('VERSION_CONFLICT', '定价模板在初始化过程中发生版本变化，请重试', {
        expectedVersionId: expectedVersions.pricingTemplateVersionId,
        actualVersionId: result.pricingTemplate.versionId
      }, 409);
    }
    const option = result.options.find((candidate) => String((candidate.shipping as any).serviceCode || '').toUpperCase() === preset.shippingServiceCode);
    if (!option) throw new AppError('NO_ELIGIBLE_PRICING_OPTION', '指定服务渠道没有符合固定包装参数的报价', { serviceCode: preset.shippingServiceCode }, 409);
    const listing = moneyNumber(option.amounts.listing.costCurrency, 'CNY');
    const target = moneyNumber(option.amounts.targetSale.costCurrency, 'CNY');
    const estimated = new Decimal(listing).times(new Decimal(1).minus(new Decimal(preset.discountPercent).div(100))).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const difference = estimated.minus(target).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const shippingTemplate = asObject((option.shipping as any).template);
    if (expectedVersions && String(shippingTemplate.versionId || '') !== expectedVersions.shippingTemplateVersionId) {
      throw new AppError('VERSION_CONFLICT', '运费模板在初始化过程中发生版本变化，请重试', {
        expectedVersionId: expectedVersions.shippingTemplateVersionId,
        actualVersionId: shippingTemplate.versionId
      }, 409);
    }
    return {
      listingPriceCny: listing, targetSalePriceCny: target, merchantDiscountPercent: preset.discountPercent,
      estimatedDiscountedPriceCny: Number(estimated.toFixed(2)), differenceCny: Number(difference.toFixed(2)), currency: 'CNY' as const,
      pricingTemplateVersionNo: result.pricingTemplate.versionNo, shippingTemplateVersionNo: Number(shippingTemplate.versionNo || 0),
      shippingServiceCode: preset.shippingServiceCode,
      procurementSource: {
        procurementVersionId: product.procurement.id,
        procurementVersionNo: product.procurement.versionNo,
        purchasePrice: product.procurement.purchasePrice,
        domesticFreight: product.procurement.courierFee,
        currency: product.procurement.currency,
        capturedAt: product.procurement.createdAt
      }
    };
  }

  private async requireIdentity(sku: string) {
    const identity = await this.purchases.getProductIdentityBySku(sku);
    if (!identity) throw new AppError('NOT_FOUND', '产品 SKU 不存在', { sku }, 404);
    if (!identity.productName.trim()) throw new AppError('CONFIG_INVALID', '产品缺少受保护的产品名', { sku }, 409);
    if (!identity.variants.length) throw new AppError('CONFIG_INVALID', '产品没有可用的 MerchRoute 产品变体', { sku }, 409);
    return identity;
  }
}

function parsePreset(input: unknown): WbListingPresetDefinition {
  if (Object.hasOwn(asObject(input), 'videoUploadMode')) {
    throw new AppError(
      'CONFIG_INVALID',
      '上品预设不再支持“上传视频”设置，请在对应 WB 类目模板的“媒体、尺码与合规规则”中配置默认视频上传方式',
      { field: 'videoUploadMode', replacement: 'category.formConfig.media.defaultVideoUploadMode' },
      400
    );
  }
  const parsed = wbListingPresetDefinitionSchema.safeParse(input);
  if (!parsed.success) throw new AppError('CONFIG_INVALID', parsed.error.issues.map((item) => `${item.path.join('.')}: ${item.message}`).join('；'), { issues: parsed.error.issues });
  return parsed.data;
}

async function resolveTnvedKiz(n8n: N8nWbClient, subjectId: number, tnvedInput: string): Promise<boolean> {
  const tnved = String(tnvedInput || '').trim();
  if (!tnved) throw new Error('TNVED 编码不能为空');
  if (!/^\d{10}$/.test(tnved)) throw new Error('TNVED 必须为 10 位数字');
  const raw = await n8n.getDirectory('tnved', { subjectId, search: tnved, locale: 'ru' });
  const rows = directoryRows(raw);
  const found = rows.find((row) => String(row.tnved || '').trim() === tnved);
  if (!found) throw new Error(`WB TNVED 目录中未找到编码 ${tnved}`);
  const isKiz = parseBoolean(found.isKiz);
  if (isKiz === undefined) throw new Error(`WB TNVED ${tnved} 未返回有效的 isKiz`);
  return isKiz;
}

function categoryTnvedCharacteristicId(category: NonNullable<WbPresetResolvedDependencies['category']>): number | undefined {
  return resolveWbTnvedPolicy(category.formConfig, category.liveSchema).characteristicId || undefined;
}

function moneyNumber(input: { currencyCode: string; displayValue: string }, expectedCurrency: string): number {
  if (input.currencyCode !== expectedCurrency) throw new AppError('CURRENCY_MISMATCH', `预期 ${expectedCurrency}，实际为 ${input.currencyCode}`);
  const value = Number(input.displayValue);
  if (!Number.isFinite(value) || value <= 0) throw new AppError('CALCULATION_FAILED', '定价结果没有有效的上架价');
  return value;
}

function stripRecordFields(preset: WbListingPresetRecord): WbListingPresetDefinition {
  return {
    name: preset.name, description: preset.description, autoPublishEnabled: preset.autoPublishEnabled,
    autoPublishMode: preset.autoPublishMode, pricingTemplateId: preset.pricingTemplateId,
    shippingTemplateId: preset.shippingTemplateId, shippingServiceCode: preset.shippingServiceCode,
    ...(preset.destinationCountryCode ? { destinationCountryCode: preset.destinationCountryCode } : {}), packaging: preset.packaging,
    categoryKey: preset.categoryKey, discountPercent: preset.discountPercent, clubDiscount: preset.clubDiscount,
    tnved: preset.tnved,
    brand: preset.brand, titleTranslation: preset.titleTranslation, descriptionSource: 'E003',
    sharedCharacteristics: preset.sharedCharacteristics, variantCharacteristics: preset.variantCharacteristics, sizes: preset.sizes
  };
}

function parseDependencySnapshot(input: unknown): WbPresetDependencySnapshot {
  const value = asObject(input);
  const parsed: WbPresetDependencySnapshot = {
    pricingTemplateVersionId: String(value.pricingTemplateVersionId || ''),
    pricingTemplateVersionNo: Number(value.pricingTemplateVersionNo || 0),
    shippingTemplateVersionId: String(value.shippingTemplateVersionId || ''),
    shippingTemplateVersionNo: Number(value.shippingTemplateVersionNo || 0),
    categoryVersionId: String(value.categoryVersionId || ''),
    categoryVersionNo: Number(value.categoryVersionNo || 0),
    capturedAt: String(value.capturedAt || '')
  };
  if (![parsed.pricingTemplateVersionId, parsed.shippingTemplateVersionId, parsed.categoryVersionId].every((id) => /^[0-9a-f-]{36}$/i.test(id))
    || ![parsed.pricingTemplateVersionNo, parsed.shippingTemplateVersionNo, parsed.categoryVersionNo].every((version) => Number.isInteger(version) && version > 0)
    || !Number.isFinite(Date.parse(parsed.capturedAt))) {
    throw new AppError('CONFIG_INVALID', '自动上品任务缺少完整的定价、运费或类目版本快照', undefined, 409);
  }
  return parsed;
}

function presetRecordFromBinding(binding: WbPresetExecutionBinding): WbListingPresetRecord {
  return {
    ...binding.presetSnapshot,
    id: binding.presetId,
    name: binding.presetName,
    rowVersion: binding.presetRowVersion,
    isDefault: false,
    autoPublishActivatedAt: binding.activationStartedAt,
    dependencySnapshot: binding.dependencySnapshot,
    createdAt: binding.boundAt,
    updatedAt: binding.boundAt
  };
}

function executionBindingHash(input: Omit<WbPresetExecutionBinding, 'definitionHash'> | Record<string, unknown>): string {
  const value = { ...input } as Record<string, unknown>;
  delete value.definitionHash;
  return `sha256:${createHash('sha256').update(stableJson(value), 'utf8').digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function categoryDefaultVideoUploadMode(formConfigInput: unknown): 'ORIGINAL' | 'COMPRESSED_COPY' {
  const value = String(asObject(asObject(formConfigInput).media).defaultVideoUploadMode || 'COMPRESSED_COPY');
  return value === 'ORIGINAL' ? 'ORIGINAL' : 'COMPRESSED_COPY';
}

function validatePresetCharacteristicDefaults(
  definition: WbListingPresetDefinition,
  category: NonNullable<WbPresetResolvedDependencies['category']>,
  issues: WbInitializationIssue[]
): void {
  const fields = new Map<number, Record<string, any>>();
  for (const candidate of Array.isArray(category.formConfig.fields) ? category.formConfig.fields : []) {
    const field = asObject(candidate);
    const id = Number(field.characteristicId);
    if (Number.isInteger(id) && id > 0) fields.set(id, field);
  }
  const schema = presetCharacteristicSchemaMap(category.liveSchema);
  const seen = new Set<number>();
  for (const [property, expectedScope] of [
    ['sharedCharacteristics', 'shared'],
    ['variantCharacteristics', 'variant']
  ] as const) {
    for (const [index, characteristic] of definition[property].entries()) {
      const id = characteristic.id;
      const fieldPath = `${property}.${index}`;
      if (seen.has(id)) {
        issues.push(issue('PRESET_CHARACTERISTIC_DUPLICATE', `characteristic ${id} 在预设默认值中重复`, fieldPath, 'ERROR', false));
        continue;
      }
      seen.add(id);
      const field = fields.get(id);
      if (!field) {
        issues.push(issue('PRESET_CHARACTERISTIC_NOT_MANAGED', `characteristic ${id} 不属于当前已发布类目表单`, fieldPath, 'ERROR', false));
        continue;
      }
      if (String(field.scope || '') !== expectedScope) {
        issues.push(issue('PRESET_CHARACTERISTIC_SCOPE_MISMATCH', `characteristic ${id} 应配置在${expectedScope === 'shared' ? '共享' : '变体'}默认值中`, fieldPath, 'ERROR', false));
      }
      const descriptor = schema.get(id);
      if (!descriptor) {
        issues.push(issue('PRESET_CHARACTERISTIC_SCHEMA_MISSING', `characteristic ${id} 不存在于当前 live schema`, fieldPath, 'ERROR', false));
        continue;
      }
      validatePresetCharacteristicValue(characteristic.value, descriptor, id, fieldPath, issues);
    }
  }
}

function assertNoSystemManagedPresetCharacteristics(definition: WbListingPresetDefinition): void {
  const systemIds = new Set<number>(WB_PURCHASE_CHARACTERISTIC_BINDINGS.map((item) => item.characteristicId));
  const configured = [...definition.sharedCharacteristics, ...definition.variantCharacteristics]
    .map((item) => item.id)
    .filter((id) => systemIds.has(id));
  if (!configured.length) return;
  throw new AppError(
    'PRESET_CHARACTERISTIC_SYSTEM_MANAGED',
    '产品高度、深度、宽度和净重由采购管理最新版本自动提供，不能保存为上品预设默认值',
    { characteristicIds: [...new Set(configured)] },
    400
  );
}

function validatePresetCharacteristicValue(
  value: string | number | boolean | Array<string | number | boolean>,
  descriptor: Record<string, any>,
  id: number,
  fieldPath: string,
  issues: WbInitializationIssue[]
): void {
  const values = Array.isArray(value) ? value : [value];
  const rawCharcType = descriptor.charcType ?? descriptor.charc_type;
  const charcType = rawCharcType === undefined || rawCharcType === null || rawCharcType === '' ? undefined : Number(rawCharcType);
  if (charcType === 0) {
    issues.push(issue('PRESET_CHARACTERISTIC_DISABLED', `characteristic ${id} 已被 WB 标记为停用`, fieldPath, 'ERROR', false));
  } else if (charcType === 4) {
    const numeric = values.length === 1 && (typeof values[0] === 'number' || (typeof values[0] === 'string' && values[0].trim() !== ''))
      ? Number(values[0])
      : Number.NaN;
    if (!Number.isFinite(numeric)) {
      issues.push(issue('PRESET_CHARACTERISTIC_VALUE_INVALID', `数值型 characteristic ${id} 必须只有一个有效数字`, fieldPath, 'ERROR', false));
    }
  } else if (charcType === 1 && values.some((candidate) => typeof candidate !== 'string')) {
    issues.push(issue('PRESET_CHARACTERISTIC_VALUE_INVALID', `字符串型 characteristic ${id} 只能使用字符串或字符串数组`, fieldPath, 'ERROR', false));
  }
  const maxCount = Number(descriptor.maxCount || descriptor.max_count || 0);
  if (maxCount > 0 && values.length > maxCount) {
    issues.push(issue('PRESET_CHARACTERISTIC_MAX_COUNT', `characteristic ${id} 最多允许 ${maxCount} 个值`, fieldPath, 'ERROR', false));
  }
}

function presetCharacteristicSchemaMap(input: unknown): Map<number, Record<string, any>> {
  const root = asObject(input);
  const candidates = Array.isArray(input)
    ? input
    : Array.isArray(root.data)
      ? root.data
      : Array.isArray(root.characteristics)
        ? root.characteristics
        : [];
  const result = new Map<number, Record<string, any>>();
  for (const candidate of candidates) {
    const descriptor = asObject(candidate);
    const id = Number(descriptor.charcID || descriptor.id);
    if (Number.isInteger(id) && id > 0) result.set(id, descriptor);
  }
  return result;
}

function cloneCharacteristics(items: WbListingPresetDefinition['sharedCharacteristics']): WbListingPresetDefinition['sharedCharacteristics'] {
  return items.map((item) => ({ id: item.id, value: Array.isArray(item.value) ? [...item.value] : item.value }));
}

function withoutLiveSchema(category: NonNullable<WbPresetResolvedDependencies['category']>): Omit<NonNullable<WbPresetResolvedDependencies['category']>, 'liveSchema'> {
  return {
    categoryKey: category.categoryKey,
    nameRu: category.nameRu,
    nameZh: category.nameZh,
    subjectId: category.subjectId,
    active: category.active,
    versionId: category.versionId,
    versionNo: category.versionNo,
    formConfig: category.formConfig,
    schemaHash: category.schemaHash
  };
}

function directoryRows(input: unknown): Record<string, any>[] {
  if (Array.isArray(input)) return input.map(asObject);
  const root = asObject(input);
  for (const candidate of [root.data, root.items, root.result]) if (Array.isArray(candidate)) return candidate.map(asObject);
  return [];
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (['true', 'yes', 'да'].includes(normalized)) return true;
  if (['false', 'no', 'нет'].includes(normalized)) return false;
  return undefined;
}

function issue(code: string, message: string, field: string | undefined, severity: 'WARNING' | 'ERROR', retryable: boolean): WbInitializationIssue {
  return { code, message, ...(field ? { field } : {}), severity, retryable };
}

function descriptionIdentityVariants(identity: ProductIdentityRecord): ProductIdentityRecord['variants'] {
  const colored = identity.variants.filter((variant) => variant.wbColor);
  return colored.length ? colored : identity.variants;
}

export function filterIdentityVariants(
  identity: ProductIdentityRecord,
  productVariantIds?: string[]
): ProductIdentityRecord {
  if (!productVariantIds) return identity;
  const requested = new Set(productVariantIds.map(String).filter(Boolean));
  if (!requested.size) {
    throw new AppError('CONFIG_INVALID', '自动上品任务没有可用的本轮产品变体', { sku: identity.sku }, 409);
  }
  const variants = identity.variants.filter((variant) => requested.has(variant.variantId));
  const found = new Set(variants.map((variant) => variant.variantId));
  const missing = [...requested].filter((variantId) => !found.has(variantId));
  if (missing.length) {
    throw new AppError('CONFIG_INVALID', '自动上品任务引用的产品变体已不存在', {
      sku: identity.sku,
      productVariantIds: missing
    }, 409);
  }
  return { ...identity, variants };
}

function resolveGrossWeight(
  product: PricingProductSnapshot,
  presetGrossWeightGrams: number,
  procurementCapturedAt: string
): WbGrossWeightResolution {
  const procurementGrossWeightGrams = positiveNumber(product.procurement.grossWeightGrams) ?? null;
  return {
    source: procurementGrossWeightGrams === null ? 'PRESET_FALLBACK' : 'PROCUREMENT',
    effectiveGrossWeightGrams: procurementGrossWeightGrams ?? presetGrossWeightGrams,
    procurementGrossWeightGrams,
    presetGrossWeightGrams,
    procurementVersionId: product.procurement.id,
    procurementVersionNo: product.procurement.versionNo,
    procurementCapturedAt
  };
}

function storedGrossWeightGrams(input: unknown): number | undefined {
  const resolution = asObject(input);
  if (resolution.source !== 'PROCUREMENT' && resolution.source !== 'PRESET_FALLBACK') return undefined;
  return positiveNumber(resolution.effectiveGrossWeightGrams);
}

function positiveNumber(input: unknown): number | undefined {
  if (input === null || input === undefined || (typeof input === 'string' && !input.trim())) return undefined;
  const value = Number(input);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

const RESOLUTION_ISSUE_CODES = new Set([
  'PRICING_TEMPLATE_UNAVAILABLE', 'PRICING_PLATFORM_MISMATCH', 'PRICING_CURRENCY_MISMATCH',
  'SHIPPING_TEMPLATE_UNAVAILABLE', 'SHIPPING_PLATFORM_MISMATCH', 'CATEGORY_TEMPLATE_UNAVAILABLE',
  'CATEGORY_TNVED_FIELD_MISSING', 'TECH_SIZE_REQUIRED', 'SHIPPING_SERVICE_NOT_FOUND',
  'DESTINATION_REQUIRED', 'DESTINATION_UNSUPPORTED', 'TNVED_REQUIRED', 'TNVED_INVALID', 'TNVED_NOT_SUPPORTED_BY_CATEGORY',
  'TITLE_TRANSLATION_WORKFLOW_UNSUPPORTED', 'TITLE_TRANSLATION_UNAVAILABLE', 'PRESET_DEPENDENCY_DRIFT',
  'PRESET_CHARACTERISTIC_DUPLICATE', 'PRESET_CHARACTERISTIC_NOT_MANAGED', 'PRESET_CHARACTERISTIC_SCOPE_MISMATCH',
  'PRESET_CHARACTERISTIC_SCHEMA_MISSING', 'PRESET_CHARACTERISTIC_DISABLED', 'PRESET_CHARACTERISTIC_VALUE_INVALID',
  'PRESET_CHARACTERISTIC_MAX_COUNT'
]);

function reconcileRetryIssues(
  previous: unknown[],
  currentResolution: WbInitializationIssue[],
  currentRuntime: WbInitializationIssue[],
  requested: { price: boolean; title: boolean; description: boolean }
): WbInitializationIssue[] {
  const refreshedCodes = new Set(RESOLUTION_ISSUE_CODES);
  if (requested.price) {
    refreshedCodes.add('PRICE_INITIALIZATION_FAILED');
    refreshedCodes.add('MERCHANT_DISCOUNT_PRICING_MISMATCH');
  }
  if (requested.title) refreshedCodes.add('TITLE_TRANSLATION_FAILED');
  if (requested.description) {
    refreshedCodes.add('E003_DESCRIPTION_MISSING');
    refreshedCodes.add('E003_DESCRIPTION_AMBIGUOUS');
    refreshedCodes.add('E003_DESCRIPTION_FALLBACK');
  }
  const preserved = previous
    .map((candidate) => asObject(candidate))
    .filter((candidate) => !refreshedCodes.has(String(candidate.code || '')))
    .map((candidate) => candidate as WbInitializationIssue);
  const unique = new Map<string, WbInitializationIssue>();
  for (const candidate of [...preserved, ...currentResolution, ...currentRuntime]) {
    unique.set(`${candidate.code}:${candidate.field || ''}:${candidate.message}`, candidate);
  }
  return [...unique.values()];
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function assertRowVersion(value: number): void { if (!Number.isInteger(value) || value < 1) throw new AppError('CONFIG_INVALID', 'rowVersion 必须是正整数', undefined, 400); }
function normalizeSku(input: string): string { const sku = String(input || '').trim(); if (!/^\d{7}$/.test(sku)) throw new AppError('CONFIG_INVALID', 'SKU 必须是 7 位数字'); return sku; }
function asObject(value: unknown): Record<string, any> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}; }
