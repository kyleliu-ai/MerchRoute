import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import sharp from 'sharp';
import writeFileAtomic from 'write-file-atomic';
import {
  AppError,
  OZON_CONTENT_POLICY_V2,
  OZON_CONTENT_POLICY_V3,
  assertOzonTitle,
  OZON_CONTENT_POLICY_VERSION,
  OZON_TITLE_MAX_LENGTH,
  findMissingOzonRequiredAttributes,
  projectOzonPresetRequiredAttributeCoverage,
  hasOzonCjk,
  hasOzonInvalidPlatformCharacters,
  isOzonSystemMediaAttributeId,
  ozonAutoJobCanCancel,
  ozonJobHasRemoteProgress,
  ozonStoreAliasSchema,
  OZON_TITLE_TRANSLATION_WORKFLOW_ID,
  ozonListingDraftInputSchema,
  ozonLegacyPresetInputSchema,
  ozonSharedMaterialDraftInputSchema,
  ozonPricingResolutionSchema,
  ozonPresetInputSchema,
  ozonProductUrl,
  ozonProductSchema,
  ozonProductV2Schema,
  nextOzonVariantCode,
  stableOzonOfferId,
  validateOzonDescription,
  validateOzonTitle,
  type OzonActiveJobSummary,
  type OzonAttributeValueInput,
  type OzonCategoryAttribute,
  type OzonColorIdentity,
  type OzonCompatibleAppendInput,
  type OzonCompatibleAppendPlan,
  type OzonCompatibleAppendResult,
  type OzonListingDetail,
  type OzonListingDraft,
  type OzonListingDraftInput,
  type OzonListingInitialization,
  type OzonInitializationIssue,
  type OzonJobRecovery,
  type OzonManualJobDetail,
  type OzonManualPurchaseMeasurements,
  type OzonManualSubmissionResult,
  type OzonListingPriceProjection,
  type OzonMediaAsset,
  type OzonProductV2,
  type OzonProductMapping,
  type OzonProductLink,
  type OzonPreset,
  type OzonPresetInput,
  type OzonPlatformBusinessState,
  type OzonPlatformOfferDisplayState,
  type OzonPlatformOfferStatus,
  type OzonPlatformStatusRefreshResult,
  type OzonPricingResolution,
  type OzonPublishJob,
  type OzonTaskDirectoryStage,
  type OzonSystemSettings,
  type OzonVariantColorAuthority,
  type PricingCalculationItem
} from '@n8n-media-review/shared';
import type { FastifyBaseLogger } from 'fastify';
import type {
  OzonPlatformStatusRefreshLease,
  OzonKnownPrePlatformFailureRecoveryInput,
  OzonKnownPrePlatformFailureRecoveryChecks,
  OzonKnownPrePlatformFailureRecoveryResult,
  OzonKnownPostPlatformMinPriceRecoveryInput,
  OzonKnownPostPlatformMinPriceRecoveryChecks,
  OzonKnownPostPlatformMinPriceRecoveryResult,
  OzonCompatibleAppendPreparedArtifact,
  OzonRepository,
  OzonRuntimeClaimInput,
  OzonRuntimeJobListInput,
  OzonRuntimeLeaseInput,
  OzonRuntimeUpdateInput
} from '../../repositories/ozon.js';
import type { PurchaseRepository } from '../../repositories/purchases.js';
import type { PricingRepository } from '../../repositories/pricing.js';
import { enforceOzonOfferModelGroups } from '../../utils/ozon-sku-identity.js';
import { isPathInside, normalizedTaskPath, secureResolve, toApiRelativePath } from '../../utils/paths.js';
import {
  assertOzonManualPurchaseMeasurementsReady,
  categoryUsesOzonManualPurchaseMeasurements,
  createOzonManualPurchaseMeasurements,
  projectOzonManualPurchaseMeasurements,
  sameOzonManualPurchaseAttributes,
  sameOzonManualPurchaseMeasurementValues,
  type OzonManualPurchaseProjectionResult
} from '../ozon-manual-purchase-measurements.js';
import {
  applyOzonGrossWeightToDimensions,
  readOzonGrossWeightResolution,
  resolveOzonGrossWeight
} from '../ozon-gross-weight.js';
import type {
  E003DescriptionSourceService,
  E003VariantDescriptionsResult
} from '../wb-presets/e003-description.js';
import type {
  OzonTitleTranslationResult,
  OzonTitleTranslator
} from './title-translation.js';
import {
  completeOzonAutoMaterialSnapshot,
  createOzonCompatibleAppendManifestSignature,
  createOzonCompatibleAppendPlan,
  createOzonCompatibleIdentityPlan,
  isOzonAutoMaterialSnapshot,
  mergeCompatibleOzonMediaAssets,
  mergeCompatibleOzonOffers,
  normalizeOzonNoBrandForPlatform,
  prepareOzonManagedSharedAttributes
} from './material-preparation.js';
import {
  nextOzonNetworkRecovery,
  normalizeOzonNetworkError,
  OzonNetworkRequestError,
  parseRetryAfterMs
} from './network-recovery.js';
import {
  normalizeOzonRfbsStockMismatchCallback,
  readOzonP002Execution
} from './rfbs-stock-callback.js';
import { latestManifestImageOrderErrors, resolveManifestMediaOrder } from '../manifest-media-order.js';

export const OZON_SHARED_SOURCE_STORE_FIELDS = Object.freeze({
  storeAlias: '__STORE_SCOPED__',
  fulfillmentMode: 'FBS' as const,
  warehouseId: '__STORE_SCOPED__',
  accountCurrency: 'RUB' as const
});

type ManualOzonVariantDescription = Pick<
  OzonListingDraft['data']['offers'][number],
  'descriptionRu' | 'descriptionSource'
>;

type OzonHistoricalPreset = OzonPreset & {
  autoPublishEnabled: boolean;
  autoPublishMode: 'CREATE_ONLY' | 'COMPATIBLE_UPSERT';
  fulfillmentMode: 'FBS' | 'RFBS';
  warehouseId: string;
  currency: 'RUB' | 'CNY';
  isDefault: boolean;
};

type ManualOzonInitialization = {
  titleRu?: string;
  descriptionRu?: string;
  descriptionSource?: OzonListingDraft['data']['descriptionSource'];
  descriptionsByVariant: Map<string, ManualOzonVariantDescription>;
  initialization: OzonListingInitialization;
};

type OzonPublicSystemSettings = Omit<OzonSystemSettings,
  'defaultStoreAlias' | 'credentialReady' | 'sellerId' | 'sellerName' | 'accountCurrency'
  | 'lastPreflightAt' | 'lastPreflightStatus' | 'lastPreflightMessage'>;

type ManualOzonProductVariant = {
  variantId: string;
  name?: string | null;
  wbColor?: { colorKey: string; nameRu: string; nameZh: string };
  ozonColor?: OzonColorIdentity;
};

type ManualOzonPrices = { price: number; oldPrice: number; minPrice: number };
type ManualOzonPriceCalculation = {
  prices: ManualOzonPrices;
  pricingResolution: OzonPricingResolution;
};

type OzonCompatibleAppendContext = {
  plan: OzonCompatibleAppendPlan;
  listing: OzonListingDraft;
  preset?: OzonPreset;
  productIdentity: OzonCompatibleAppendProductIdentity;
  productVariants: ManualOzonProductVariant[];
  currentMediaAssets: OzonMediaAsset[];
  settings: OzonSystemSettings;
};

type OzonCompatibleAppendProductIdentity = {
  productName: string;
  productVariants: Array<{ variantId: string; name: string }>;
  hash: string;
};

export class OzonPublishingService {
  private readonly generationLocks = new Map<string, Promise<void>>();
  private readonly n8nExecutionReader: (
    executionId: string
  ) => Promise<Record<string, unknown> | undefined>;

  constructor(
    private readonly repository: OzonRepository,
    private readonly purchases: PurchaseRepository,
    private readonly logger: FastifyBaseLogger,
    private readonly pricing?: PricingRepository,
    private readonly descriptions?: Pick<E003DescriptionSourceService, 'resolveVariants'>,
    private readonly titleTranslator?: OzonTitleTranslator,
    n8nExecutionReader?: (executionId: string) => Promise<Record<string, unknown> | undefined>,
    private readonly compatibility: { canonicalizePath: (value: string) => string } = { canonicalizePath: (value) => value }
  ) {
    this.n8nExecutionReader = n8nExecutionReader ?? readOzonP002Execution;
  }

  async createListing(sku: string): Promise<OzonListingDraft> {
    const existing = await this.repository.getListing(sku).catch((error) => {
      if (error instanceof AppError && error.code === 'NOT_FOUND' && error.message.includes('草稿')) return undefined;
      throw error;
    });
    if (existing) return existing;
    await this.requireManagementEnabled();
    const purchase = await this.purchases.getPurchase(sku);
    const identity = await this.purchases.getProductIdentityBySku(purchase.sku);
    const selected = selectOzonListingProductVariants(identity?.variants || []);
    const variants = selected.length ? selected : [{ variantId: randomUUID(), name: '默认变体' }];
    const initialized = await this.resolveManualInitialization(
      purchase.sku,
      purchase.productName,
      undefined,
      variants,
      { title: false, description: true }
    );
    const offers = variants.map((variant, index) => {
      const variantCode = String(index + 1).padStart(2, '0');
      return {
        variantId: variant.variantId,
        productVariantId: variant.variantId,
        productVariantName: String(variant.name || variant.variantId),
        ...(variant.wbColor ? { productVariantColor: variant.wbColor } : {}),
        variantCode,
        offerId: stableOzonOfferId(purchase.sku, variantCode),
        barcode: '',
        modelGroup: purchase.sku,
        // Compatibility-only placeholders. Public shared-material APIs never
        // expose them; every store publication recalculates its own values.
        price: 1,
        oldPrice: 1,
        minPrice: 0,
        stock: 0,
        ...(initialized.descriptionsByVariant.get(variant.variantId) || {}),
        descriptionWarnings: [],
        attributes: [],
        media: []
      };
    });
    return this.repository.createListing(
      { sku: purchase.sku, productName: purchase.productName },
      undefined,
      {
        ...(initialized.titleRu ? { titleRu: initialized.titleRu } : {}),
        ...(initialized.descriptionRu ? {
          descriptionRu: initialized.descriptionRu,
          ...(initialized.descriptionSource ? { descriptionSource: initialized.descriptionSource } : {})
        } : {}),
        offers,
        initialization: initialized.initialization,
        currency: 'CNY'
      }
    );
  }

  private async buildManualOffers(
    sku: string,
    variants: ManualOzonProductVariant[],
    preset: OzonPreset,
    categoryAttributes: OzonCategoryAttribute[],
    prices: ManualOzonPrices,
    descriptionsByVariant: Map<string, ManualOzonVariantDescription>,
    existingOffers: OzonListingDraft['data']['offers'] = []
  ): Promise<OzonListingDraft['data']['offers']> {
    let activeOzonColors: Awaited<ReturnType<OzonRepository['searchCatalogDictionary']>> = [];
    try { activeOzonColors = await this.repository.searchCatalogDictionary('colors', { dictionaryId: 1494, limit: 2_000 }); } catch { /* Optional color mapping never blocks draft creation. */ }
    const activeOzonColorsByItemKey = new Map(activeOzonColors.map((color) => [color.itemKey, color]));
    const usedCodes = new Set(existingOffers.map((offer) => offer.variantCode));
    return variants.map((variant) => {
      const variantCode = nextOzonVariantCode(usedCodes);
      if (!variantCode) throw new AppError('VERSION_CONFLICT', 'OZON 稳定变体编码 01–99 已用完，不能继续追加', { sku }, 409);
      usedCodes.add(variantCode);
      const storedOzonColor = variant.ozonColor;
      const activeColorRow = storedOzonColor ? activeOzonColorsByItemKey.get(storedOzonColor.itemKey) : undefined;
      const activeOzonColor = storedOzonColor && activeColorRow ? {
        itemKey: activeColorRow.itemKey,
        dictionaryId: activeColorRow.dictionaryId,
        valueId: activeColorRow.valueId,
        nameRu: activeColorRow.nameRu,
        nameZh: activeColorRow.nameZh,
        source: storedOzonColor.source
      } satisfies OzonColorIdentity : undefined;
      return {
        variantId: variant.variantId,
        ...(variant.name ? {
          productVariantId: variant.variantId,
          productVariantName: variant.name,
          ...(variant.wbColor ? { productVariantColor: variant.wbColor } : {})
        } : {}),
        variantCode,
        offerId: stableOzonOfferId(sku, variantCode),
        barcode: '',
        modelGroup: sku,
        ...prices,
        stock: preset.defaultStock,
        ...(descriptionsByVariant.get(variant.variantId) || {}),
        descriptionWarnings: [],
        attributes: applyOzonVariantColorDefaults(
          withoutOzonSystemMediaAttributes(preset.variantAttributes),
          categoryAttributes,
          activeOzonColor
        ),
        media: []
      };
    });
  }

  async initializeMissing(sku: string, rowVersion: number): Promise<OzonListingDraft> {
    if (!Number.isInteger(rowVersion) || rowVersion < 1) {
      throw new AppError('CONFIG_INVALID', 'rowVersion 必须是正整数', undefined, 400);
    }
    const listing = await this.repository.getListing(sku);
    if (listing.rowVersion !== rowVersion) {
      throw new AppError('TASK_LOCKED', 'OZON 草稿版本已变化，请刷新后重试', {
        sku: listing.sku,
        expected: listing.rowVersion,
        actual: rowVersion
      }, 409);
    }
    if (!['DRAFT', 'READY'].includes(listing.status)) {
      throw new AppError('TASK_LOCKED', '当前 OZON 资料状态不允许自动补全', { sku: listing.sku, status: listing.status }, 409);
    }
    const previousInitialization = listing.data.initialization;
    const capturedPreset = readOzonPresetSnapshot(previousInitialization?.presetSnapshot);
    const preset = capturedPreset;
    const grossWeightResolution = readOzonGrossWeightResolution(previousInitialization?.grossWeightResolution);
    const identity = await this.purchases.getProductIdentityBySku(listing.sku);
    const productVariants = selectOzonListingProductVariants(identity?.variants || []);
    const storedVariants = listing.data.offers.map((offer) => ({
      variantId: offer.productVariantId || offer.variantId,
      name: offer.productVariantName || offer.variantCode
    }));
    const variants = productVariants.length
      ? productVariants
      : storedVariants.length
        ? storedVariants
        : [{ variantId: randomUUID(), name: '默认变体' }];
    const offersWithIdentity = backfillOzonOfferProductIdentity(listing.data.offers, productVariants);
    const missingTitle = !String(listing.data.titleRu || '').trim();
    const missingSharedDescription = !String(listing.data.descriptionRu || '').trim();
    const missingVariantIds = new Set(offersWithIdentity
      .filter((offer) => !String(offer.descriptionRu || '').trim())
      .map((offer) => offer.productVariantId || offer.variantId));
    const missingDescriptions = missingSharedDescription || missingVariantIds.size > 0;
    const missingPrices = Boolean(
      listing.data.currency === 'CNY'
      &&
      grossWeightResolution
      && capturedPreset
      && (offersWithIdentity.length === 0
        || previousInitialization?.issues.some((issue) => issue.code === 'OZON_PRICE_INITIALIZATION_FAILED'))
    );
    if (!missingTitle && !missingDescriptions && !missingPrices) {
      if (JSON.stringify(offersWithIdentity) === JSON.stringify(listing.data.offers)) return listing;
      return this.repository.updateListing(listing.sku, {
        ...listing.data,
        rowVersion,
        offers: offersWithIdentity
      }, { preserveGeneratedSources: true });
    }
    const resolved = await this.resolveManualInitialization(
      listing.sku,
      listing.productName,
      preset,
      variants,
      { title: missingTitle, description: missingDescriptions || missingPrices }
    );
    let offers = offersWithIdentity.map((offer) => {
      if (String(offer.descriptionRu || '').trim()) return offer;
      return { ...offer, ...(resolved.descriptionsByVariant.get(offer.productVariantId || offer.variantId) || {}) };
    });
    let pricesRecalculatedInCny = false;
    let recalculatedPricingResolution: OzonPricingResolution | undefined;
    const currentIssues = [...resolved.initialization.issues];
    if (missingPrices && capturedPreset && grossWeightResolution) {
      try {
        if (!this.pricing) {
          throw new AppError('DATABASE_UNAVAILABLE', '售价计算服务尚未初始化，无法重试 OZON 默认定价链', undefined, 503);
        }
        const purchase = await this.purchases.getPurchase(listing.sku);
        const procurement = purchase.procurementVersions?.find((candidate) => (
          candidate.id === grossWeightResolution.procurementVersionId
          && candidate.versionNo === grossWeightResolution.procurementVersionNo
        ));
        if (!procurement) {
          throw new AppError('VERSION_CONFLICT', '找不到草稿冻结的采购版本，不能补全价格', {
            sku: listing.sku,
            procurementVersionId: grossWeightResolution.procurementVersionId,
            procurementVersionNo: grossWeightResolution.procurementVersionNo
          }, 409);
        }
        const calculation = await calculateManualListingPrices(
          this.pricing,
          capturedPreset,
          listing.sku,
          listing.productName,
          procurement,
          grossWeightResolution.effectiveGrossWeightGrams,
          'CNY'
        );
        const categoryKey = String(listing.data.categoryKey || capturedPreset.categoryKey || '').trim();
        const category = categoryKey ? await this.repository.getCategory(categoryKey) : undefined;
        if (!category?.publishedVersion) throw new AppError('CONFIG_INVALID', '当前 OZON 类目模板尚未发布', { categoryKey }, 409);
        offers = await this.buildManualOffers(
          listing.sku,
          variants,
          capturedPreset,
          category.publishedVersion.snapshot.attributes,
          calculation.prices,
          resolved.descriptionsByVariant
        );
        pricesRecalculatedInCny = true;
        recalculatedPricingResolution = calculation.pricingResolution;
      } catch (error) {
        currentIssues.push(initializationIssue('OZON_PRICE_INITIALIZATION_FAILED', error, 'offers.price'));
      }
    }
    const titleRu = String(listing.data.titleRu || '').trim() || resolved.titleRu || '';
    const descriptionRu = String(listing.data.descriptionRu || '').trim() || resolved.descriptionRu || '';
    const issues = mergeOzonInitializationIssues(
      previousInitialization?.issues || [],
      currentIssues,
      titleRu,
      descriptionRu,
      offers
    );
    const complete = Boolean(
      titleRu
      && descriptionRu
      && offers.length > 0
      && offers.every((offer) => Number(offer.price) > 0 && String(offer.descriptionRu || '').trim())
    );
    const initialization: OzonListingInitialization = {
      ...previousInitialization,
      ...resolved.initialization,
      status: complete ? 'COMPLETE' : 'PARTIAL',
      initializedAt: previousInitialization?.initializedAt || resolved.initialization.initializedAt,
      lastRetriedAt: new Date().toISOString(),
      issues,
      ...(previousInitialization?.title || resolved.initialization.title
        ? { title: previousInitialization?.title || resolved.initialization.title }
        : {}),
      ...(previousInitialization?.description || resolved.initialization.description
        ? { description: previousInitialization?.description || resolved.initialization.description }
        : {}),
      ...(recalculatedPricingResolution ? { pricingResolution: recalculatedPricingResolution } : {})
    };
    const changed = titleRu !== String(listing.data.titleRu || '')
      || descriptionRu !== String(listing.data.descriptionRu || '')
      || JSON.stringify(offers) !== JSON.stringify(listing.data.offers)
      || JSON.stringify(initialization) !== JSON.stringify(previousInitialization);
    if (!changed) return listing;
    return this.repository.updateListing(listing.sku, {
      ...listing.data,
      rowVersion,
      titleRu,
      descriptionRu,
      ...(listing.data.descriptionSource || resolved.descriptionSource
        ? { descriptionSource: listing.data.descriptionSource || resolved.descriptionSource }
        : {}),
      offers,
      ...(pricesRecalculatedInCny ? { currency: 'CNY' as const } : {}),
      initialization
    }, { preserveGeneratedSources: true });
  }

  private async resolveManualInitialization(
    sku: string,
    productName: string,
    preset: OzonPreset | undefined,
    variants: Array<{ variantId: string; name?: string | null }>,
    requested: { title: boolean; description: boolean }
  ): Promise<ManualOzonInitialization> {
    const titleTranslation = preset?.titleTranslation || {
      workflowId: OZON_TITLE_TRANSLATION_WORKFLOW_ID,
      language: '俄文',
      maxLength: OZON_TITLE_MAX_LENGTH
    };
    const titleRequest = requested.title
      ? this.titleTranslator?.configured
        ? this.titleTranslator.translate({
            content: productName,
            language: titleTranslation.language,
            maxLength: titleTranslation.maxLength,
            workflowId: titleTranslation.workflowId,
            requestId: `ozon-title-${sku}-manual-${OZON_CONTENT_POLICY_VERSION}`,
            contentPolicyVersion: OZON_CONTENT_POLICY_VERSION
          })
        : Promise.reject(new AppError('CONFIG_INVALID', 'OZON 标题翻译工作流尚未配置', undefined, 503))
      : Promise.resolve(undefined);
    const descriptionRequest = requested.description
      ? this.descriptions
        ? this.descriptions.resolveVariants(
            sku,
            productName,
            variants.map((variant) => ({ variantId: variant.variantId, name: String(variant.name || variant.variantId) }))
          )
        : Promise.reject(new AppError('CONFIG_INVALID', 'E003 产品详情解析服务尚未配置', undefined, 503))
      : Promise.resolve(undefined);
    const [titleResult, descriptionResult] = await Promise.allSettled([titleRequest, descriptionRequest]);
    const issues: OzonInitializationIssue[] = [];
    let titleRu: string | undefined;
    let titleSource: OzonListingInitialization['title'];
    if (requested.title) {
      if (titleResult.status === 'fulfilled' && titleResult.value) {
        try {
          titleRu = validateGeneratedOzonTitle(titleResult.value, titleTranslation.maxLength);
          titleSource = {
            workflowId: titleTranslation.workflowId,
            language: titleTranslation.language,
            maxLength: titleTranslation.maxLength,
            cached: titleResult.value.cached,
            ...(titleResult.value.model ? { model: titleResult.value.model } : {})
          };
        } catch (error) {
          issues.push(initializationIssue('TITLE_TRANSLATION_INVALID', error, 'titleRu'));
        }
      } else {
        issues.push(initializationIssue(
          'TITLE_TRANSLATION_FAILED',
          titleResult.status === 'rejected' ? titleResult.reason : '标题翻译未返回内容',
          'titleRu'
        ));
      }
    }
    const descriptionsByVariant = new Map<string, ManualOzonVariantDescription>();
    let descriptionRu: string | undefined;
    let descriptionSource: OzonListingDraft['data']['descriptionSource'];
    let initializationDescription: OzonListingInitialization['description'];
    if (requested.description) {
      if (descriptionResult.status === 'fulfilled' && descriptionResult.value) {
        const result = descriptionResult.value;
        for (const variant of variants) {
          const variantResult = result.variantSources.find((candidate) => candidate.productVariantId === variant.variantId);
          if (!variantResult?.content) {
            issues.push({
              code: variantResult?.status === 'AMBIGUOUS' ? 'E003_DESCRIPTION_AMBIGUOUS' : 'E003_DESCRIPTION_MISSING',
              message: variantResult?.message || `没有找到变体“${String(variant.name || variant.variantId)}”的最新有效 E003 详情 TXT`,
              field: `offers.${variant.variantId}.descriptionRu`,
              retryable: true
            });
            continue;
          }
          try {
            const value = validateGeneratedOzonDescription(variantResult.content);
            const source = variantResult.source
              ? ozonDescriptionSourceFromE003(variantResult.source, variant.variantId)
              : { type: 'SHARED' as const, productVariantId: variant.variantId };
            descriptionsByVariant.set(variant.variantId, { descriptionRu: value, descriptionSource: source });
          } catch (error) {
            issues.push(initializationIssue('E003_DESCRIPTION_INVALID', error, `offers.${variant.variantId}.descriptionRu`));
          }
        }
        const primary = variants.map((variant) => descriptionsByVariant.get(variant.variantId)).find(Boolean);
        if (primary) {
          descriptionRu = primary.descriptionRu;
          descriptionSource = primary.descriptionSource?.type === 'E003'
            ? primary.descriptionSource
            : undefined;
        }
        if (result.source) {
          initializationDescription = {
            workflowCode: 'E003',
            executionId: result.source.executionId,
            fileName: result.source.fileName,
            sha256: result.source.sha256
          };
        }
        if (result.status === 'FALLBACK') {
          issues.push({
            code: 'E003_DESCRIPTION_FALLBACK',
            message: '最新详情 TXT 不可用，已回退使用上一份有效 E003 详情 TXT',
            field: 'descriptionRu',
            retryable: true
          });
        }
      } else {
        const reason = descriptionResult.status === 'rejected' ? descriptionResult.reason : 'E003 产品详情未返回内容';
        issues.push(initializationIssue('E003_DESCRIPTION_FAILED', reason, 'descriptionRu'));
        for (const variant of variants) {
          issues.push(initializationIssue('E003_DESCRIPTION_FAILED', reason, `offers.${variant.variantId}.descriptionRu`));
        }
      }
    }
    const complete = (!requested.title || Boolean(titleRu))
      && (!requested.description || variants.every((variant) => descriptionsByVariant.has(variant.variantId)));
    const initialization: OzonListingInitialization = {
      status: complete ? 'COMPLETE' : 'PARTIAL',
      initializedAt: new Date().toISOString(),
      issues,
      ...(titleSource ? { title: titleSource } : {}),
      ...(initializationDescription ? { description: initializationDescription } : {})
    };
    return { titleRu, descriptionRu, descriptionSource, descriptionsByVariant, initialization };
  }

  async getListing(sku: string): Promise<OzonListingDetail> {
    const listing = await this.repository.getListing(sku);
    const activeJob = await this.repository.findActiveJobBySku(listing.sku);
    const generatedProductSummary = await this.readGeneratedProductSummary(listing);
    const purchaseMeasurementProjection = await this.readManualPurchaseMeasurementProjection(listing);
    const priceProjection = await this.readManualPriceProjection(listing);
    return {
      listing,
      activeJob: activeJob ? activeJobSummary(activeJob) : undefined,
      canManualTakeover: Boolean(activeJob && this.repository.canManualTakeover(activeJob)),
      ...(priceProjection ? { priceProjection } : {}),
      ...(purchaseMeasurementProjection ? { purchaseMeasurementProjection } : {}),
      ...(generatedProductSummary ? { generatedProductSummary } : {})
    };
  }

  async takeOverAutomaticPreparationForManual(input: {
    sku: string;
    jobId: string;
    jobRowVersion: number;
    listingRowVersion: number;
  }): Promise<{ job: OzonPublishJob; listing: OzonListingDraft }> {
    await this.requireManagementEnabled();
    return this.repository.takeOverAutomaticPreparationForManual({
      jobId: input.jobId,
      sku: input.sku,
      expectedJobRowVersion: input.jobRowVersion,
      expectedListingRowVersion: input.listingRowVersion
    });
  }

  async compatibleAppendPlan(sku: string): Promise<OzonCompatibleAppendPlan> {
    throw legacyListingWriteReadOnly(sku);
  }

  private async prepareCompatibleAppendContext(sku: string): Promise<OzonCompatibleAppendContext> {
    const [listing, settings, readiness] = await Promise.all([
      this.repository.getListing(sku),
      this.repository.getSettings(),
      this.repository.compatibleAppendReadiness(sku)
    ]);
    const preset = readOzonPresetSnapshot(listing.data.initialization?.presetSnapshot);
    const blockers: string[] = [];
    if (!settings.enabled) blockers.push('OZON 上品管理未启用');
    if (!settings.rootDirectory) blockers.push('尚未配置 OZON 自动上品根目录');
    if (!settings.credentialReady) blockers.push('OZON 默认店铺凭据尚未通过预检');
    if (!settings.taskApiWebhookUrl) blockers.push('尚未配置 OZON 任务调度 Webhook');
    if (!settings.adminApiWebhookUrl) blockers.push('尚未配置 OZON 只读管理 Webhook');
    if (!preset) blockers.push('历史资料缺少冻结 OZON 上品预设');
    else if (preset.autoPublishMode !== 'COMPATIBLE_UPSERT') blockers.push('历史冻结预设不是“兼容既有商品”模式');
    if (readiness.activePlatformStatusRefreshLease) {
      blockers.push(`该 SKU 正在刷新 OZON 平台状态（租约至 ${readiness.activePlatformStatusRefreshLease.leaseExpiresAt}）`);
    }
    if (readiness.activeRuntimeJobLease) {
      blockers.push(`该 SKU 的任务 ${readiness.activeRuntimeJobLease.jobId} 正由运行时 ${readiness.activeRuntimeJobLease.leaseOwner} 执行`);
    }
    if (readiness.occupiedPublishSlot) {
      blockers.push(`OZON 平台单写槽正由任务 ${readiness.occupiedPublishSlot.jobId} 执行，请稍后重试`);
    }

    const [identity, activeJob] = await Promise.all([
      this.purchases.getProductIdentityBySku(listing.sku),
      this.repository.findActiveJobBySku(listing.sku)
    ]);
    if (!identity) blockers.push('PostgreSQL 中不存在该 SKU 的产品身份');
    if (activeJob) blockers.push(`该 SKU 已有进行中的 ${activeJob.source === 'AUTO' ? '自动' : '手动'}上品任务 ${activeJob.id}`);
    const productIdentity = createOzonCompatibleAppendProductIdentity(
      identity?.productName || '',
      identity?.variants || []
    );
    const productVariants = selectOzonListingProductVariants(identity?.variants || []) as ManualOzonProductVariant[];
    if (!productVariants.length) blockers.push('产品身份没有可用于 OZON 的变体');

    let categoryVersionId = '';
    if (!listing.data.categoryKey) {
      blockers.push('既有资料没有绑定 OZON 类目');
    } else {
      try {
        const category = await this.repository.getCategory(listing.data.categoryKey);
        categoryVersionId = category.publishedVersion?.id || '';
        if (!category.publishedVersion) blockers.push('既有资料绑定的 OZON 类目当前没有已发布版本');
        else if (listing.data.categoryVersionId !== category.publishedVersion.id) blockers.push('既有资料绑定的 OZON 类目版本已变化，不能兼容追加');
        if (preset?.categoryKey && preset.categoryKey !== listing.data.categoryKey) blockers.push('既有资料的类目与冻结预设不一致');
      } catch (error) {
        blockers.push(error instanceof Error ? error.message : '无法读取既有资料绑定的 OZON 类目');
      }
    }

    let currentMediaAssets: OzonMediaAsset[] = [];
    let manifestSignature = createOzonCompatibleAppendManifestSignature(currentMediaAssets);
    if (settings.rootDirectory) {
      const productRoot = this.productRoot(settings.rootDirectory, listing.sku);
      const representedVariantIds = new Set(listing.data.offers
        .map((offer) => String(offer.productVariantId || offer.variantId || '').trim())
        .filter(Boolean));
      const missingVariantIds = productVariants
        .map((variant) => variant.variantId)
        .filter((variantId) => !representedVariantIds.has(variantId));
      try {
        const { inspectOzonMediaManifest, uniqueManifestAssets } = await import('./auto-publishing.js');
        const manifestPath = path.join(productRoot, 'variants', 'variant-media-manifest.json');
        const first = await inspectOzonMediaManifest(
          manifestPath,
          listing.sku,
          identity?.productName || listing.productName,
          productVariants as any,
          missingVariantIds
        );
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const second = await inspectOzonMediaManifest(
          manifestPath,
          listing.sku,
          identity?.productName || listing.productName,
          productVariants as any,
          missingVariantIds
        );
        if (!first.signature || first.signature !== second.signature) blockers.push('媒体清单在稳定性双探测期间发生变化，请稍后重新检测');
        blockers.push(...second.issues);
        currentMediaAssets = uniqueManifestAssets(second.variants.flatMap((variant) => [...variant.images, ...variant.videos]));
        manifestSignature = second.signature
          ? `sha256:${second.signature}`
          : createOzonCompatibleAppendManifestSignature(currentMediaAssets);
      } catch (error) {
        blockers.push(error instanceof Error ? error.message : '当前 schemaVersion 2 媒体清单无法读取');
      }
    }
    const plan = createOzonCompatibleAppendPlan({
      listing,
      productVariants,
      currentMediaAssets,
      manifestSignature,
      blockers,
      binding: {
        ...createOzonCompatibleAppendSettingsBinding(settings),
        productIdentityHash: productIdentity.hash,
        presetId: preset?.id || null,
        presetRowVersion: preset?.rowVersion || null,
        categoryVersionId: categoryVersionId || null
      }
    });
    return { plan, listing, preset, productIdentity, productVariants, currentMediaAssets, settings };
  }

  private async prepareCompatibleAppendListing(
    context: OzonCompatibleAppendContext
  ): Promise<OzonListingDraft['data']> {
    const { listing, plan, preset, currentMediaAssets, settings } = context;
    if (!plan.canAppend || !preset) {
      throw new AppError(
        'VERSION_CONFLICT',
        plan.blockedReason || '当前 OZON 资料不能兼容追加',
        { sku: listing.sku, reasonCode: 'OZON_COMPATIBLE_APPEND_BLOCKED' },
        409
      );
    }
    if (!settings.rootDirectory) throw new AppError('CONFIG_INVALID', '尚未配置 OZON 自动上品根目录', undefined, 409);
    if (!this.pricing) throw new AppError('DATABASE_UNAVAILABLE', '售价计算服务尚未初始化，无法兼容追加 OZON 变体', undefined, 503);
    const categoryKey = listing.data.categoryKey;
    if (!categoryKey) throw new AppError('CONFIG_INVALID', '既有资料没有绑定 OZON 类目', undefined, 409);
    const [purchase, category] = await Promise.all([
      this.purchases.getPurchase(listing.sku),
      this.repository.getCategory(categoryKey)
    ]);
    if (!category.publishedVersion || category.publishedVersion.id !== listing.data.categoryVersionId) {
      throw new AppError('VERSION_CONFLICT', '既有资料绑定的 OZON 类目版本已变化，不能兼容追加', { sku: listing.sku }, 409);
    }
    const procurement = purchase.procurementVersions?.[0];
    if (!procurement) throw new AppError('CONFIG_INVALID', '产品没有可用于 OZON 售价计算的采购版本', { sku: listing.sku }, 409);
    const submitted = new Set(plan.newOffers.map((offer) => offer.variantId));
    const variants = context.productVariants.filter((variant) => submitted.has(variant.variantId));
    if (variants.length !== plan.newOffers.length) {
      throw new AppError('VERSION_CONFLICT', '新增变体计划与当前产品身份不一致，请重新检测', { sku: listing.sku }, 409);
    }
    const capturedAt = new Date().toISOString();
    const grossWeightResolution = resolveOzonGrossWeight(procurement, preset.dimensions, capturedAt);
    const [priceCalculation, initialized] = await Promise.all([
      calculateManualListingPrices(
        this.pricing,
        preset,
        listing.sku,
        listing.productName,
        procurement,
        grossWeightResolution.effectiveGrossWeightGrams,
        'CNY'
      ),
      this.resolveManualInitialization(
        listing.sku,
        listing.productName,
        preset,
        variants,
        { title: false, description: true }
      )
    ]);
    const missingDescriptions = variants.filter((variant) => !initialized.descriptionsByVariant.has(variant.variantId));
    if (missingDescriptions.length) {
      throw new AppError('CONFIG_INVALID', '新增 OZON 变体缺少可用的 E003 商品详情', {
        sku: listing.sku,
        variantIds: missingDescriptions.map((variant) => variant.variantId)
      }, 409);
    }
    const plannedOffers = await this.buildManualOffers(
      listing.sku,
      variants,
      preset,
      category.publishedVersion.snapshot.attributes,
      priceCalculation.prices,
      initialized.descriptionsByVariant,
      listing.data.offers
    );
    const plannedByVariant = new Map(plan.newOffers.map((offer) => [offer.variantId, offer]));
    const assetsByVariant = new Map<string, OzonMediaAsset[]>();
    for (const asset of currentMediaAssets) {
      if (!asset.productVariantId || asset.validationStatus !== 'VALID') continue;
      assetsByVariant.set(asset.productVariantId, [...(assetsByVariant.get(asset.productVariantId) || []), asset]);
    }
    const offersWithMedia = plannedOffers.map((offer) => {
      const variantId = String(offer.productVariantId || offer.variantId);
      const planned = plannedByVariant.get(variantId);
      if (!planned || planned.offerId !== offer.offerId) {
        throw new AppError('VERSION_CONFLICT', '新增 Offer 身份与确认计划不一致，请重新检测', {
          sku: listing.sku,
          variantId,
          expectedOfferId: planned?.offerId,
          actualOfferId: offer.offerId
        }, 409);
      }
      const mediaAssets = assetsByVariant.get(variantId) || [];
      const imageOrdering = resolveManifestMediaOrder(mediaAssets.filter((asset) => asset.kind === 'image'));
      if (!imageOrdering.ok) {
        throw new AppError(
          'MEDIA_MANIFEST_INVALID',
          `${String(offer.productVariantName || variantId)}：${imageOrdering.message}`,
          { sku: listing.sku, variantId, reason: imageOrdering.reason },
          409
        );
      }
      const images = imageOrdering.assets;
      const videos = mediaAssets.filter((asset) => asset.kind === 'video');
      if (!images.length || images.length > 15 || videos.length !== 1) {
        throw new AppError('VERSION_CONFLICT', '新增变体媒体与确认计划不一致，请重新检测', {
          sku: listing.sku,
          variantId,
          images: images.length,
          videos: videos.length
        }, 409);
      }
      return {
        ...offer,
        media: [...images, videos[0]!].map((asset, index) => ({
          assetId: asset.assetId,
          relativePath: asset.relativePath,
          kind: asset.kind,
          sortOrder: index,
          isPrimary: asset.kind === 'image' && index === 0
        }))
      };
    });
    const offers = mergeCompatibleOzonOffers(listing.data.offers, offersWithMedia, { allowNewOffers: true });
    const mediaAssets = mergeCompatibleOzonMediaAssets(listing.data.mediaAssets, currentMediaAssets, offers);
    const initialization: OzonListingInitialization = {
      ...(listing.data.initialization || { status: 'COMPLETE', initializedAt: capturedAt, issues: [] }),
      status: 'COMPLETE',
      issues: [],
      grossWeightResolution,
      presetSnapshot: createOzonPresetSnapshot(preset, capturedAt),
      pricingResolution: priceCalculation.pricingResolution
    };
    const data: OzonListingDraft['data'] = {
      ...listing.data,
      dimensions: applyOzonGrossWeightToDimensions(preset.dimensions, grossWeightResolution),
      currency: 'CNY',
      initialization,
      offers,
      mediaAssets,
      mediaSourceRoot: this.productRoot(settings.rootDirectory, listing.sku)
    };
    const preparedListing: OzonListingDraft = { ...listing, status: 'READY', data };
    await verifyOzonMediaAssetsCurrent(
      scopeOzonListingSubmission(preparedListing, plan.submittedOfferIds),
      this.productRoot(settings.rootDirectory, listing.sku)
    );
    return data;
  }

  private async assertCompatibleAppendRemoteAbsence(
    offerIds: string[],
    settings: OzonSystemSettings
  ): Promise<Record<string, unknown>> {
    if (!settings.adminApiWebhookUrl) {
      throw new AppError(
        'OZON_REMOTE_STATE_UNPROVEN',
        '尚未配置 OZON 只读管理 Webhook，无法证明新增 Offer 在平台不存在',
        { offerIds },
        502
      );
    }
    try {
      const response = await postJson(settings.adminApiWebhookUrl, { action: 'productStatus', offerIds });
      return {
        ...(normalizeOzonKnownRecoveryRemoteAbsence(offerIds, response) as unknown as Record<string, unknown>),
        storeAlias: settings.defaultStoreAlias
      };
    } catch (error) {
      if (error instanceof AppError && error.code === 'OZON_REMOTE_STATE_PRESENT') throw error;
      throw new AppError(
        'OZON_REMOTE_STATE_UNPROVEN',
        'OZON 只读查询未能明确证明所有新增 Offer 均不存在，已停止兼容追加',
        {
          offerIds,
          causeCode: error instanceof AppError ? error.code : normalizeOzonNetworkError(error)?.code,
          causeMessage: error instanceof Error ? error.message : String(error || '')
        },
        502
      );
    }
  }

  async refreshPlatformStatus(sku: string, rowVersion: number): Promise<OzonPlatformStatusRefreshResult> {
    const settings = await this.repository.getSettings();
    if (!settings.adminApiWebhookUrl) {
      throw new AppError('CONFIG_INVALID', '尚未配置 OZON 类目与系统配置 Webhook，无法读取平台商品状态', undefined, 409);
    }
    let lease: OzonPlatformStatusRefreshLease | undefined;
    let archivedJob: OzonPublishJob | undefined;
    let archive: Awaited<ReturnType<OzonPublishingService['archiveSucceededDirectory']>> | undefined;
    try {
      lease = await this.repository.acquirePlatformStatusRefresh(sku, rowVersion);
      if (lease.storeAlias !== settings.defaultStoreAlias) {
        throw new AppError('CONFIG_INVALID', '任务绑定店铺与当前 OZON 默认店铺不一致，已停止状态刷新', {
          sku: lease.listing.sku,
          taskStoreAlias: lease.storeAlias,
          defaultStoreAlias: settings.defaultStoreAlias
        }, 409);
      }
      const response = await postJson(settings.adminApiWebhookUrl, {
        action: 'productStatus',
        offerIds: lease.offerIds
      });
      await this.repository.renewPlatformStatusRefresh(lease.leaseToken);
      const normalized = normalizeOzonPlatformStatusRefresh(lease, response);
      const remoteJob = lease.job
        && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(lease.job.state)
        && ozonJobHasRemoteProgress(lease.job)
        ? lease.job
        : undefined;
      let jobState: OzonRuntimeUpdateInput['state'] | undefined;
      let errorCode: string | undefined;
      let errorMessage: string | undefined;
      if (remoteJob) {
        // P003/人工刷新只负责只读状态与映射回读。活动远端任务的阶段、错误与终态
        // 只能由 P002 的逐 Offer 最终合同推进，避免跳过媒体/价格/库存一致性验收。
        jobState = remoteJob.state;
        errorCode = remoteJob.lastErrorCode;
        errorMessage = remoteJob.lastErrorMessage;
      }
      const refreshWarnings = remoteJob
        ? [...new Set([...normalized.warnings, '活动任务仍需通过 P002 逐 Offer 最终验收，平台状态刷新未改变任务阶段'])]
        : normalized.warnings;
      const committed = await this.repository.commitPlatformStatusRefresh(lease.listing.sku, {
        leaseToken: lease.leaseToken,
        listingRowVersion: lease.listing.rowVersion,
        ...(lease.job ? { jobRowVersion: lease.job.rowVersion } : {}),
        readAt: normalized.readAt,
        businessState: normalized.businessState,
        offers: normalized.offers,
        warnings: refreshWarnings,
        stageStates: remoteJob ? remoteJob.stageStates : normalized.stageStates,
        ...(jobState ? { jobState } : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        ...(archive ? { archive } : {})
      });
      return {
        listing: committed.listing,
        ...(committed.job ? { job: committed.job } : {}),
        storeAlias: lease.storeAlias,
        businessState: normalized.businessState,
        offers: normalized.offers,
        warnings: refreshWarnings,
        refreshedAt: normalized.readAt,
        changed: committed.changed
      };
    } catch (error) {
      let rollbackFailure: unknown;
      if (archive && archivedJob) {
        try {
          await this.rollbackPlatformStatusArchive(archivedJob, archive);
        } catch (rollbackError) {
          rollbackFailure = rollbackError;
          this.logger.error({ err: rollbackError, sku: archivedJob?.sku, jobId: archivedJob?.id }, '回滚 OZON 平台状态刷新目录归档失败');
        }
      }
      if (lease) {
        const normalizedError = platformStatusRefreshError(error);
        await this.repository.failPlatformStatusRefresh(lease.listing.sku, lease.leaseToken, normalizedError)
          .catch((releaseError) => this.logger.error({ err: releaseError, sku: lease?.listing.sku }, '释放 OZON 平台状态刷新租约失败'));
      }
      if (rollbackFailure) {
        throw new AppError('VERSION_CONFLICT', '平台状态已读取，但成功目录归档后的数据库提交失败且无法安全回滚', {
          sku: archivedJob?.sku,
          jobId: archivedJob?.id,
          workRelPath: archive?.workRelPath
        }, 409);
      }
      if (error instanceof AppError) throw error;
      const normalizedError = platformStatusRefreshError(error);
      throw new AppError(
        normalizedError.code,
        'OZON 平台商品状态读取失败，原有状态已保留',
        { sku, reason: normalizedError.message },
        502
      );
    }
  }

  async getManualJobDetail(sku: string, id: string): Promise<OzonManualJobDetail> {
    const job = await this.repository.getJob(id, 'MANUAL');
    if (job.sku !== sku) throw new AppError('NOT_FOUND', '该手动 OZON 任务不属于当前 SKU', { sku, id }, 404);
    return { job, recovery: ozonJobRecovery(job) };
  }

  async listRuntimeJobs(input: Omit<OzonRuntimeJobListInput, 'remoteOnly'>): Promise<{
    items: OzonPublishJob[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const settings = await this.repository.getSettings();
    const result = await this.repository.listRuntimeJobs({
      ...input,
      remoteOnly: !settings.enabled
    });
    return {
      ...result,
      items: result.items.map((job) => withRuntimePaths(job, settings.rootDirectory, this.compatibility.canonicalizePath))
    };
  }

  async getRuntimeJob(id: string): Promise<OzonPublishJob> {
    const [job, settings] = await Promise.all([
      this.repository.getJob(id),
      this.repository.getSettings()
    ]);
    if (!settings.enabled && !ozonJobHasRemoteProgress(job)) throw ozonManagementDisabledError();
    return withRuntimePaths(job, settings.rootDirectory, this.compatibility.canonicalizePath);
  }

  async claimRuntimeJob(input: OzonRuntimeClaimInput): Promise<{ items: OzonPublishJob[] }> {
    const settings = await this.repository.getSettings();
    const job = await this.repository.claimRuntimeJob({ ...input, remoteOnly: !settings.enabled });
    return { items: job ? [withRuntimePaths(job, settings.rootDirectory, this.compatibility.canonicalizePath)] : [] };
  }

  async renewRuntimeLease(id: string, input: OzonRuntimeLeaseInput): Promise<{ job: OzonPublishJob }> {
    return { job: await this.repository.renewRuntimeLease(id, input) };
  }

  async releaseRuntimeLease(
    id: string,
    input: Omit<OzonRuntimeLeaseInput, 'leaseSeconds'>
  ): Promise<{ job: OzonPublishJob }> {
    return { job: await this.repository.releaseRuntimeLease(id, input) };
  }

  async listHistoricalNetworkRecoveryCandidates(limit?: number): Promise<{ items: OzonPublishJob[] }> {
    const [items, settings] = await Promise.all([
      this.repository.listHistoricalNetworkRecoveryCandidates(limit),
      this.repository.getSettings()
    ]);
    return { items: items.map((job) => withRuntimePaths(job, settings.rootDirectory, this.compatibility.canonicalizePath)) };
  }

  async recoverHistoricalNetworkJob(id: string, rowVersion: number): Promise<{ job: OzonPublishJob }> {
    const [persistedCurrent, settings] = await Promise.all([this.repository.getJob(id), this.repository.getSettings()]);
    const current = withRuntimePaths(persistedCurrent, settings.rootDirectory, this.compatibility.canonicalizePath);
    if (current.rowVersion !== rowVersion) {
      throw new AppError('TASK_LOCKED', 'OZON 上品任务状态已变化，请刷新后重试', {
        id,
        expected: current.rowVersion,
        actual: rowVersion
      }, 409);
    }
    if (!this.repository.isHistoricalNetworkRecoveryCandidate(current)) {
      throw new AppError('CONFIG_INVALID', '该任务不是可自动原地恢复的网络失败候选', {
        id,
        state: current.state,
        errorCode: current.lastErrorCode
      }, 409);
    }
    const recovered = await this.repository.recoverHistoricalNetworkJob(
        id,
        rowVersion,
        (lockedJob) => this.clearTerminalDirectoryMarker(withRuntimePaths(lockedJob, settings.rootDirectory, this.compatibility.canonicalizePath))
      );
    return { job: withRuntimePaths(recovered, settings.rootDirectory, this.compatibility.canonicalizePath) };
  }

  async recoverKnownPrePlatformFailure(
    id: string,
    input: OzonKnownPrePlatformFailureRecoveryInput
  ): Promise<OzonKnownPrePlatformFailureRecoveryResult> {
    const [persistedJob, settings] = await Promise.all([this.repository.getJob(id), this.repository.getSettings()]);
    const runtimeProjection = legacyRuntimePathProjection(persistedJob, settings.rootDirectory, this.compatibility.canonicalizePath);
    const preview = await this.repository.recoverKnownPrePlatformFailure(id, { ...input, dryRun: true }, undefined, runtimeProjection);
    if (preview.status === 'ALREADY_RECOVERED') {
      return { ...preview, job: withRuntimePaths(preview.job, settings.rootDirectory, this.compatibility.canonicalizePath) };
    }
    const previewChecks = await this.validateKnownPrePlatformFailureChecks(preview.job, input.reason);
    if (input.dryRun) return { ...preview, checks: previewChecks };

    let committedChecks: OzonKnownPrePlatformFailureRecoveryChecks | undefined;
    const recovered = await this.repository.recoverKnownPrePlatformFailure(
      id,
      input,
      async (lockedJob) => {
        committedChecks = await this.validateKnownPrePlatformFailureChecks(lockedJob, input.reason);
        if (input.reason === 'IMPORT_INTENT_URL_MISSING'
          || input.reason === 'DESCRIPTION_KEYWORD_STUFFING_FALSE_POSITIVE_V1_TO_V2') {
          await this.clearTerminalDirectoryMarker(lockedJob);
        }
        return committedChecks;
      },
      runtimeProjection
    );
    return {
      ...recovered,
      job: withRuntimePaths(recovered.job, settings.rootDirectory, this.compatibility.canonicalizePath),
      ...(committedChecks ? { checks: committedChecks } : {})
    };
  }

  async recoverKnownPostPlatformMinPriceFailure(
    id: string,
    input: OzonKnownPostPlatformMinPriceRecoveryInput
  ): Promise<OzonKnownPostPlatformMinPriceRecoveryResult> {
    const [persistedJob, settings] = await Promise.all([this.repository.getJob(id), this.repository.getSettings()]);
    const runtimeProjection = legacyRuntimePathProjection(persistedJob, settings.rootDirectory, this.compatibility.canonicalizePath);
    const preview = await this.repository.recoverKnownPostPlatformMinPriceFailure(id, {
      ...input,
      dryRun: true
    }, undefined, runtimeProjection);
    if (preview.status === 'ALREADY_RECOVERED') {
      return { ...preview, job: withRuntimePaths(preview.job, settings.rootDirectory, this.compatibility.canonicalizePath) };
    }
    const previewMappings = await this.repository.listProductMappingsForSku(
      preview.job.storeAlias,
      preview.job.sku
    );
    const previewChecks = await this.validateKnownPostPlatformMinPriceChecks(
      preview.job,
      previewMappings
    );
    const previewWithChecks = {
      ...preview,
      proposed: {
        ...preview.proposed,
        workRelPath: previewChecks.productJson.resolvedWorkRelPath,
        directoryStage: previewChecks.productJson.resolvedDirectoryStage
      },
      checks: previewChecks
    };
    if (input.dryRun) return previewWithChecks;

    let committedChecks: OzonKnownPostPlatformMinPriceRecoveryChecks | undefined;
    const recovered = await this.repository.recoverKnownPostPlatformMinPriceFailure(
      id,
      input,
      async (locked) => {
        committedChecks = await this.validateKnownPostPlatformMinPriceChecks(
          locked.job,
          locked.mappings
        );
        return committedChecks;
      },
      runtimeProjection
    );
    return {
      ...recovered,
      job: withRuntimePaths(recovered.job, settings.rootDirectory, this.compatibility.canonicalizePath),
      ...(committedChecks ? { checks: committedChecks } : {})
    };
  }

  private async validateKnownPostPlatformMinPriceChecks(
    job: OzonPublishJob,
    storedMappings: OzonProductMapping[]
  ): Promise<OzonKnownPostPlatformMinPriceRecoveryChecks> {
    const settings = await this.repository.getSettings();
    if (!settings.adminApiWebhookUrl || !settings.preflightWebhookUrl) {
      throw new AppError(
        'OZON_REMOTE_STATE_UNPROVEN',
        '缺少 OZON P003 商品状态或 C001/A001 权威价格只读 Webhook，禁止最低价故障恢复',
        { jobId: job.id },
        409
      );
    }
    const productJson = await this.validateKnownPostPlatformProductJson(job, this.compatibility.canonicalizePath(settings.rootDirectory));
    const product = normalizeKnownPostPlatformPriceProduct(productJson.product, job);
    let remoteProducts: OzonKnownPostPlatformMinPriceRecoveryChecks['remoteProducts'];
    try {
      const response = await postJson(settings.adminApiWebhookUrl, {
        action: 'productStatus',
        offerIds: job.offerIds
      });
      remoteProducts = normalizeKnownPostPlatformRemoteProducts(job, storedMappings, response);
    } catch (error) {
      if (error instanceof AppError && error.code === 'OZON_REMOTE_STATE_UNPROVEN') throw error;
      throw new AppError(
        'OZON_REMOTE_STATE_UNPROVEN',
        'OZON P003 只读查询未能证明全部原 Offer 与商品映射仍然存在',
        {
          jobId: job.id,
          causeCode: error instanceof AppError ? error.code : normalizeOzonNetworkError(error)?.code,
          causeMessage: error instanceof Error ? error.message : String(error || '')
        },
        409
      );
    }
    let pricesRead: OzonKnownPostPlatformMinPriceRecoveryChecks['pricesRead'];
    try {
      const responses = await Promise.all(product.offers.map(async (offer) => ({
        offer,
        response: await postJson(settings.preflightWebhookUrl, {
          action: 'preflight',
          offerId: offer.offerId
        })
      })));
      pricesRead = normalizeKnownPostPlatformPricesRead(product.currency, responses);
    } catch (error) {
      if (error instanceof AppError && error.code === 'OZON_REMOTE_PRICE_UNPROVEN') throw error;
      throw new AppError(
        'OZON_REMOTE_PRICE_UNPROVEN',
        'OZON C001/A001 pricesRead 未能证明唯一差异为 min_price=0',
        {
          jobId: job.id,
          causeCode: error instanceof AppError ? error.code : normalizeOzonNetworkError(error)?.code,
          causeMessage: error instanceof Error ? error.message : String(error || '')
        },
        409
      );
    }
    return {
      remoteProducts,
      pricesRead,
      productJson: productJson.check,
      routing: {
        resumeState: 'IMPORTING',
        schedulerMode: 'RECONCILE_IMPORT',
        importProductReachable: false
      }
    };
  }

  private async validateKnownPostPlatformProductJson(
    job: OzonPublishJob,
    rootDirectory: string
  ): Promise<{
    product: unknown;
    check: OzonKnownPostPlatformMinPriceRecoveryChecks['productJson'];
  }> {
    if (!rootDirectory || job.directoryStage !== 'PROCESSING' || !job.workRelPath
      || !job.taskFolder || !job.directorySignature || !job.revision) {
      throw new AppError('VERSION_CONFLICT', '最低价恢复任务缺少 processing 目录、taskFolder、revision 或签名', {
        jobId: job.id
      }, 409);
    }
    const rootReal = await realpath(rootDirectory).catch(() => '');
    if (!rootReal) {
      throw new AppError('VERSION_CONFLICT', 'OZON 任务根目录不存在，无法验证最低价恢复 product.json', {
        jobId: job.id
      }, 409);
    }
    const persistedPath = resolveLifecyclePath(rootReal, job.workRelPath);
    const persistedInfo = await lstat(persistedPath).catch(() => undefined);
    const scope = archiveDirectoryScope(job);
    const successes = await findSucceededTaskDirectories(rootReal, scope.lifecycleFolder);
    if (persistedInfo && (!persistedInfo.isDirectory() || persistedInfo.isSymbolicLink())) {
      throw new AppError('VERSION_CONFLICT', 'OZON 持久化任务目录不是安全目录', {
        jobId: job.id,
        workRelPath: job.workRelPath
      }, 409);
    }
    if (persistedInfo && successes.length) {
      throw new AppError('VERSION_CONFLICT', 'OZON processing 与 success 同时存在同一最低价恢复任务目录', {
        jobId: job.id,
        successPaths: successes.map((entry) => entry.relativePath)
      }, 409);
    }
    if (!persistedInfo && successes.length !== 1) {
      throw new AppError('VERSION_CONFLICT', 'OZON stale processing 任务无法唯一解析到一个 success 目录', {
        jobId: job.id,
        successPaths: successes.map((entry) => entry.relativePath)
      }, 409);
    }
    const selected = persistedInfo
      ? { absolutePath: await resolveExistingLifecycleDirectory(rootReal, job.workRelPath), relativePath: job.workRelPath }
      : successes[0]!;
    const expected = {
      jobId: job.id,
      sku: job.sku,
      revision: Number(job.revision),
      signature: job.directorySignature
    };
    const integrityMode = productJsonIntegrityModeForJob(job);
    const marker = await readAndValidateTaskMarker(selected.absolutePath, expected, integrityMode);
    await readAndValidateReadyMarker(selected.absolutePath, expected);
    const product = await validateProductJsonSignature(selected.absolutePath, job.directorySignature, marker.integrityMode);
    const resolvedStage = selected.relativePath.startsWith('success/') ? 'SUCCESS' : 'PROCESSING';
    return {
      product,
      check: {
        status: 'MATCHED',
        checkedAt: new Date().toISOString(),
        expectedSignature: job.directorySignature,
        resolvedDirectoryStage: resolvedStage,
        resolvedWorkRelPath: selected.relativePath,
        resolvedWorkDirectory: selected.absolutePath,
        resolvedProductJsonPath: path.join(selected.absolutePath, 'product.json'),
        location: persistedInfo ? 'PERSISTED' : 'UNIQUE_ORPHAN_SUCCESS'
      }
    };
  }

  private async validateKnownPrePlatformFailureChecks(
    job: OzonPublishJob,
    reason: OzonKnownPrePlatformFailureRecoveryInput['reason']
  ): Promise<OzonKnownPrePlatformFailureRecoveryChecks> {
    const checkedAt = new Date().toISOString();
    const lateTitleRecovery = reason === 'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200'
      && job.state === 'SUBMITTING'
      && job.offerIds.length > 0;
    if (reason === 'TITLE_TRANSLATION_MAX_LENGTH_60_TO_200' && !lateTitleRecovery) {
      return {
        remoteState: { status: 'NOT_APPLICABLE', offerIds: [], checkedAt },
        productJson: { status: 'NOT_APPLICABLE', checkedAt }
      };
    }
    const remoteState = await this.assertKnownRecoveryRemoteStateEmpty(job.offerIds);
    const validatedProductJson = await this.validateKnownRecoveryProductJson(job);
    if (lateTitleRecovery) {
      this.validateKnownLateTitleProductContract(job, validatedProductJson.product);
    }
    return {
      remoteState,
      productJson: validatedProductJson.check,
      ...(reason === 'DESCRIPTION_KEYWORD_STUFFING_FALSE_POSITIVE_V1_TO_V2'
        ? { contentPolicy: this.validateKnownRecoveryDescriptionPolicy(validatedProductJson.product) }
        : {})
    };
  }

  private async assertKnownRecoveryRemoteStateEmpty(
    offerIds: string[]
  ): Promise<OzonKnownPrePlatformFailureRecoveryChecks['remoteState']> {
    const settings = await this.repository.getSettings();
    if (!settings.adminApiWebhookUrl) {
      throw new AppError(
        'OZON_REMOTE_STATE_UNPROVEN',
        '尚未配置 OZON 只读管理 Webhook，无法证明目标 Offer 在平台不存在',
        { offerIds },
        409
      );
    }
    try {
      const response = await postJson(settings.adminApiWebhookUrl, { action: 'productStatus', offerIds });
      return normalizeOzonKnownRecoveryRemoteAbsence(offerIds, response);
    } catch (error) {
      if (error instanceof AppError && ['OZON_REMOTE_STATE_PRESENT', 'OZON_REMOTE_STATE_UNPROVEN'].includes(error.code)) {
        throw error;
      }
      throw new AppError(
        'OZON_REMOTE_STATE_UNPROVEN',
        'OZON 只读查询未能证明目标 Offer 在平台不存在，禁止原地恢复',
        {
          offerIds,
          causeCode: error instanceof AppError ? error.code : normalizeOzonNetworkError(error)?.code,
          causeMessage: error instanceof Error ? error.message : String(error || '')
        },
        409
      );
    }
  }

  private async validateKnownRecoveryProductJson(
    job: OzonPublishJob
  ): Promise<{
    check: OzonKnownPrePlatformFailureRecoveryChecks['productJson'];
    product: unknown;
  }> {
    if (job.directoryStage !== 'PROCESSING' || !job.workRelPath || !job.directorySignature) {
      throw new AppError('VERSION_CONFLICT', '恢复任务缺少 processing 目录或 product.json 签名', { jobId: job.id }, 409);
    }
    const settings = await this.repository.getSettings();
    if (!settings.rootDirectory) {
      throw new AppError('VERSION_CONFLICT', 'OZON 任务根目录未配置，无法验证 product.json 签名', { jobId: job.id }, 409);
    }
    const rootReal = await realpath(this.compatibility.canonicalizePath(settings.rootDirectory)).catch(() => '');
    if (!rootReal) {
      throw new AppError('VERSION_CONFLICT', 'OZON 任务根目录不存在，无法验证 product.json 签名', { jobId: job.id }, 409);
    }
    const directory = await resolveExistingLifecycleDirectory(rootReal, job.workRelPath).catch(() => '');
    if (!directory) {
      throw new AppError('VERSION_CONFLICT', 'OZON processing 目录不存在，无法验证 product.json 签名', {
        jobId: job.id,
        workRelPath: job.workRelPath
      }, 409);
    }
    const product = await validateProductJsonSignature(directory, job.directorySignature, productJsonIntegrityModeForJob(job));
    return {
      check: {
        status: 'MATCHED',
        checkedAt: new Date().toISOString(),
        expectedSignature: job.directorySignature
      },
      product
    };
  }

  private validateKnownLateTitleProductContract(job: OzonPublishJob, product: unknown): void {
    if (!isRecordValue(product)
      || String(product.productCode || '') !== job.sku
      || Number(product.revision || 0) !== Number(job.revision || 0)
      || !Array.isArray(product.offers)
      || !product.offers.every(isRecordValue)) {
      throw new AppError(
        'VERSION_CONFLICT',
        'OZON 标题晚期恢复的 product.json 身份与原任务不一致',
        { jobId: job.id, sku: job.sku, revision: job.revision },
        409
      );
    }
    const productOfferIds = product.offers.map((offer) => String(offer.offerId || '').trim()).filter(Boolean);
    if (productOfferIds.length !== product.offers.length
      || new Set(productOfferIds).size !== productOfferIds.length
      || !sameStringSet(productOfferIds, job.offerIds)) {
      throw new AppError(
        'VERSION_CONFLICT',
        'OZON 标题晚期恢复的 product.json Offer 集合与原任务不一致',
        { jobId: job.id, expectedOfferIds: job.offerIds, actualOfferIds: productOfferIds },
        409
      );
    }
  }

  private validateKnownRecoveryDescriptionPolicy(
    product: unknown
  ): NonNullable<OzonKnownPrePlatformFailureRecoveryChecks['contentPolicy']> {
    if (!isRecordValue(product)
      || typeof product.descriptionRu !== 'string'
      || !Array.isArray(product.offers)
      || product.offers.length === 0
      || !product.offers.every(isRecordValue)) {
      throw new AppError(
        'VERSION_CONFLICT',
        'OZON 任务 product.json 缺少可验证的产品/变体详情合同',
        undefined,
        409
      );
    }
    const descriptions = [
      { field: 'descriptionRu', value: product.descriptionRu },
      ...product.offers.map((offer, index) => ({
        field: `offers.${index}.descriptionRu`,
        value: offer.descriptionRu || product.descriptionRu
      }))
    ];
    let legacyFalsePositive = false;
    for (const description of descriptions) {
      if (typeof description.value !== 'string') {
        throw new AppError('VERSION_CONFLICT', 'OZON 任务 product.json 变体详情结构无效', {
          field: description.field
        }, 409);
      }
      // This recovery is intentionally the frozen v1 -> v2 compatibility path.
      // It must not silently follow the current policy when v3 (or later) ships.
      const policy = validateOzonDescription(description.value, OZON_CONTENT_POLICY_V2);
      if (!policy.valid) {
        throw new AppError('CONFIG_INVALID', 'OZON 任务详情仍不符合内容策略 v2，禁止按词频误报恢复', {
          field: description.field,
          policyVersion: OZON_CONTENT_POLICY_V2,
          issues: policy.issues
        }, 409);
      }
      if (!policy.issues.includes('KEYWORD_STUFFING')
        && hasLegacyOzonDescriptionKeywordStuffing(description.value)) {
        legacyFalsePositive = true;
      }
    }
    if (!legacyFalsePositive) {
      throw new AppError(
        'CONFIG_INVALID',
        'OZON 任务详情不具备内容策略 v1 全文词频误报特征，禁止二次恢复',
        { policyVersion: OZON_CONTENT_POLICY_V2 },
        409
      );
    }
    return {
      status: 'MATCHED',
      policyVersion: OZON_CONTENT_POLICY_V2,
      legacyFalsePositive: true
    };
  }

  async recordRuntimeUpdate(
    id: string,
    input: OzonRuntimeUpdateInput
  ): Promise<{ job: OzonPublishJob; mappings: OzonProductMapping[]; mapping?: OzonProductMapping }> {
    const current = await this.repository.getJob(id);
    assertOzonRecoveryHoldReleased(current);
    await this.repository.assertPlatformStatusRefreshNotLeased(current.sku, current.id);
    if (current.state === 'SUCCEEDED') {
      assertSucceededReplay(current, input);
      await this.clearSucceededTerminalDirectoryMarkers(current);
      const mappings = current.ozonProductLinks.map((link) => ({
        storeAlias: current.storeAlias,
        offerId: link.offerId,
        sku: current.sku,
        ozonProductId: link.ozonProductId,
        ozonSku: link.ozonSku,
        lastAppliedRevision: current.revision || 0,
        status: 'SUCCEEDED',
        updatedAt: current.updatedAt
      }));
      return { job: current, mappings, ...(mappings[0] ? { mapping: mappings[0] } : {}) };
    }
    const settings = await this.repository.getSettings();
    const incomingRemoteProgress = Boolean(
      stringValue(input.taskId)
      || stringValue(input.importTaskId)
      || stringValue(input.ozonProductId)
      || ['SUBMITTING', 'UPLOADING_MEDIA', 'IMPORTING', 'VERIFYING_IMAGES', 'UPDATING_PRICE', 'UPDATING_STOCK', 'MODERATING'].includes(input.state)
    );
    if (!settings.enabled && !ozonJobHasRemoteProgress(current) && !incomingRemoteProgress) throw ozonManagementDisabledError();
    if (current.rowVersion !== input.rowVersion) {
      throw new AppError('TASK_LOCKED', 'OZON 上品任务状态已变化，请刷新后重试', {
        jobId: id,
        expected: current.rowVersion,
        actual: input.rowVersion
      }, 409);
    }
    let normalized = { ...input };
    const rfbsMismatchExecutionId = input.state === 'NEEDS_ATTENTION'
      && input.errorCode === 'OZON_FINAL_READBACK_MISMATCH'
      && input.eventType === 'OZON_FINAL_READBACK_MISMATCH'
      ? /^n8n:ozon:p002:(\d+)$/.exec(String(input.leaseOwner || ''))?.[1]
      : undefined;
    if (rfbsMismatchExecutionId) {
      const authority = await this.repository.getRfbsStockNormalizationAuthority(current.id);
      const execution = await this.n8nExecutionReader(rfbsMismatchExecutionId);
      const candidate = execution
        ? normalizeOzonRfbsStockMismatchCallback(authority, input, execution)
        : undefined;
      if (candidate) {
        normalized = candidate;
      } else {
        this.logger.warn?.({ jobId: current.id, sku: current.sku }, 'OZON RFBS 聚合库存回调缺少同轮原始 stocksRead 证明，保持人工处理');
      }
    }
    let archived: Awaited<ReturnType<OzonPublishingService['archiveSucceededDirectory']>> | undefined;
    try {
      if (normalized.state === 'SUCCEEDED') {
        assertCompleteRuntimeMappings(current, normalized);
        archived = await this.archiveSucceededDirectory(current, normalized);
        normalized = {
          ...normalized,
          revision: archived.revision,
          taskFolder: archived.taskFolder,
          workRelPath: archived.workRelPath,
          directoryStage: 'SUCCESS',
          directorySignature: archived.directorySignature,
          jobPayload: {
            ...(normalized.jobPayload || {}),
            videoCacheCleanedAt: archived.videoCacheCleanedAt,
            revision: archived.revision,
            taskFolder: archived.taskFolder,
            workRelPath: archived.workRelPath,
            directoryStage: 'SUCCESS',
            directorySignature: archived.directorySignature
          }
        };
      } else if (normalized.state === 'FAILED' || normalized.state === 'CANCELLED' || normalized.state === 'NEEDS_ATTENTION') {
        await this.writeTerminalDirectoryMarker(current, normalized.state);
      } else if (current.state === 'NEEDS_ATTENTION' && isActiveRuntimeState(normalized.state)) {
        await this.clearTerminalDirectoryMarker(current);
      }
      const result = await this.repository.recordN8nUpdate(id, normalized);
      if (normalized.state === 'SUCCEEDED') {
        await this.clearSucceededTerminalDirectoryMarkers(result.job);
      }
      return result;
    } catch (error) {
      if (!archived?.moved) throw error;

      // The filesystem rename happens before the PostgreSQL CAS. A plain
      // transport/driver error can mean COMMIT was accepted but its response
      // was lost. Never compensate that unknown outcome from a single stale
      // read: keep success in place so a later idempotent replay can converge.
      const transactionDefinitelyRejected = error instanceof AppError;
      let durable: OzonPublishJob;
      try {
        durable = await this.repository.getJob(id);
      } catch (readbackError) {
        throw new AppError('OZON_DIRECTORY_ARCHIVE_COMMIT_UNKNOWN', 'OZON 成功目录已归档，但数据库提交结果无法读回；已保留归档目录并停止重放', {
          jobId: id,
          archivedWorkRelPath: archived.workRelPath,
          causeMessage: error instanceof Error ? error.message : String(error || ''),
          readbackMessage: readbackError instanceof Error ? readbackError.message : String(readbackError || '')
        }, 503);
      }
      if (durable.state === 'SUCCEEDED'
        && durable.directoryStage === 'SUCCESS'
        && durable.workRelPath === archived.workRelPath) {
        assertSucceededReplay(durable, normalized);
        await this.clearSucceededTerminalDirectoryMarkers(durable);
        const mappings = durable.ozonProductLinks.map((link) => ({
          storeAlias: durable.storeAlias,
          offerId: link.offerId,
          sku: durable.sku,
          ozonProductId: link.ozonProductId,
          ozonSku: link.ozonSku,
          lastAppliedRevision: durable.revision || 0,
          status: 'SUCCEEDED' as const,
          updatedAt: durable.updatedAt
        }));
        return { job: durable, mappings, ...(mappings[0] ? { mapping: mappings[0] } : {}) };
      }
      if (!transactionDefinitelyRejected) {
        throw new AppError('OZON_DIRECTORY_ARCHIVE_COMMIT_UNKNOWN', 'OZON 成功目录已归档，但数据库提交结果仍未知；已保留归档目录并停止回滚', {
          jobId: id,
          archivedWorkRelPath: archived.workRelPath,
          durableState: durable.state,
          durableDirectoryStage: durable.directoryStage,
          durableWorkRelPath: durable.workRelPath,
          causeMessage: error instanceof Error ? error.message : String(error || '')
        }, 503);
      }
      const stillReferencesOriginalDirectory = durable.directoryStage === current.directoryStage
        && durable.workRelPath === current.workRelPath;
      if (!stillReferencesOriginalDirectory) {
        throw new AppError('OZON_DIRECTORY_ARCHIVE_COMMIT_UNKNOWN', 'OZON 成功目录已归档，但数据库任务已发生并发变化；已保留归档目录并停止重放', {
          jobId: id,
          archivedWorkRelPath: archived.workRelPath,
          durableState: durable.state,
          durableDirectoryStage: durable.directoryStage,
          durableWorkRelPath: durable.workRelPath
        }, 409);
      }
      try {
        await this.rollbackPlatformStatusArchive(current, archived);
      } catch (rollbackError) {
        this.logger.error({ err: rollbackError, sku: current.sku, jobId: current.id }, '回滚 OZON 运行时成功目录归档失败');
        throw new AppError('VERSION_CONFLICT', 'OZON 成功目录归档后的数据库提交失败，且无法安全回滚目录', {
          jobId: id,
          archivedWorkRelPath: archived.workRelPath,
          causeMessage: error instanceof Error ? error.message : String(error || ''),
          rollbackMessage: rollbackError instanceof Error ? rollbackError.message : String(rollbackError || '')
        }, 409);
      }
      throw error;
    }
  }

  async cancelJob(id: string, source: 'MANUAL' | 'AUTO'): Promise<OzonPublishJob> {
    const job = await this.repository.getJob(id, source);
    if (source === 'AUTO') {
      if (!ozonAutoJobCanCancel(job)) {
        throw new AppError('TASK_LOCKED', 'OZON 自动上品任务已进入远程阶段或当前状态不允许取消', {
          id,
          state: job.state,
          taskId: job.taskId,
          importTaskId: job.importTaskId,
          ozonProductId: job.ozonProductId,
          directoryStage: job.directoryStage
        }, 409);
      }
      return this.repository.cancel(id, source, job.rowVersion);
    }
    if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(job.state)) {
      await this.writeTerminalDirectoryMarker(job, 'CANCELLED');
    }
    return this.repository.cancel(id, source);
  }

  async recheckJob(id: string, source: 'MANUAL' | 'AUTO', expectedRowVersion?: number): Promise<OzonPublishJob> {
    const job = await this.repository.getJob(id, source);
    assertOzonRecoveryHoldReleased(job);
    if (!['NEEDS_ATTENTION', 'FAILED', 'MODERATING', 'WAITING_MEDIA'].includes(job.state)) {
      throw new AppError('CONFIG_INVALID', '当前 OZON 任务状态不支持重新检查', { id, state: job.state }, 409);
    }
    if (expectedRowVersion !== undefined && job.rowVersion !== expectedRowVersion) {
      throw new AppError('TASK_LOCKED', 'OZON 任务状态已变化，请刷新后重试', {
        id,
        expected: job.rowVersion,
        actual: expectedRowVersion
      }, 409);
    }
    const settings = await this.repository.getSettings();
    const enteredRemoteStage = ozonJobHasRemoteProgress(job);
    if (!settings.enabled && !enteredRemoteStage) throw ozonManagementDisabledError();
    const canDispatch = Boolean(
      settings.credentialReady
      && settings.taskApiWebhookUrl
      && (settings.enabled || enteredRemoteStage)
    );
    const resumeState = remoteResumeState(job);
    if (canDispatch && resumeState) {
      const now = new Date();
      const recoveredWriteProgress = retryableFailedWriteProgress(job);
      const result = await this.recordRuntimeUpdate(job.id, {
        rowVersion: job.rowVersion,
        state: resumeState,
        eventType: 'JOB_REMOTE_PROGRESS_RECHECKED',
        message: resumeState === 'IMPORTING'
          ? '继续复用既有 OZON 导入任务，恢复价格、库存和最终读回'
          : '继续复用既有 OZON 商品进度，恢复最终读回',
        importTaskId: job.importTaskId,
        errorCode: undefined,
        errorMessage: undefined,
        nextAttemptAt: now.toISOString(),
        stageStates: resumeState === 'IMPORTING'
          ? { import: 'SUCCESS', moderation: 'PENDING', stock: 'PENDING_RETRY' }
          : { moderation: 'RUNNING' },
        jobPayload: {
          ...(recoveredWriteProgress ? { priceStockWriteProgress: recoveredWriteProgress } : {}),
          priceStockConsistencyRetry: 0,
          priceStockRetryStartedAt: now.toISOString(),
          priceStockRetryDeadlineAt: new Date(now.getTime() + OZON_PRICE_STOCK_RETRY_WINDOW_MS).toISOString(),
          finalVerificationLeaseUntil: null,
          manualRecoveryRequestedAt: now.toISOString(),
          recoveredFrom: job.lastErrorCode || job.state
        }
      });
      return result.job;
    }
    if (!settings.enabled) return this.repository.recheck(id, source, expectedRowVersion);
    const revision = Number(job.revision || job.payload?.revision || 0);
    const signature = String(job.directorySignature || job.payload?.directorySignature || job.payload?.signature || '').trim();
    const taskFolder = revision > 0 ? `${job.sku}__r${revision}` : '';
    if (!canDispatch || job.directoryStage === 'PROCESSING' || !revision || !signature || !taskFolder) {
      return this.repository.recheck(id, source, expectedRowVersion);
    }
    const productJsonPath = settings.rootDirectory
      ? path.join(settings.rootDirectory, 'inbox', job.sku, 'product.json')
      : '';
    const jobPayload = job.payload || {};
    const offerContract = parseAutomaticOfferContract(jobPayload);
    const dispatchOfferIds = offerContract?.submittedOfferIds || job.offerIds;
    const offerContractMetadata = offerContract ? {
      offerContractVersion: jobPayload.offerContractVersion,
      offerContractHash: jobPayload.offerContractHash,
      expectedOfferIds: offerContract.expectedOfferIds,
      submittedOfferIds: offerContract.submittedOfferIds,
      publishOfferIds: offerContract.publishOfferIds,
      expectedOfferSnapshots: jobPayload.expectedOfferSnapshots
    } : {};
    try {
      const response = await postJson(settings.taskApiWebhookUrl, {
        action: 'enqueue',
        jobId: job.id,
        sku: job.sku,
        revision,
        signature,
        offerIds: dispatchOfferIds,
        ...offerContractMetadata,
        storeAlias: job.storeAlias,
        productJsonPath
      });
      const claimed = claimedDirectoryMetadata(response, {
        taskFolder,
        workRelPath: portableRelativePath('inbox', job.sku),
        directoryStage: 'INBOX',
        directorySignature: signature
      });
      return this.repository.transitionJob(job.id, {
        rowVersion: job.rowVersion,
        state: 'SUBMITTING',
        eventType: 'N8N_REDISPATCHED',
        message: '任务目录已由 n8n 幂等恢复并重新进入调度流程',
        taskId: stringValue(response.taskId || response.task_id),
        payload: { accepted: response.accepted !== false, recovery: true },
        jobPayload: {
          revision,
          offerIds: job.offerIds,
          ...offerContractMetadata,
          storeAlias: job.storeAlias,
          ...claimed
        },
        offerIds: job.offerIds,
        storeAlias: job.storeAlias,
        revision,
        ...claimed,
        errorCode: undefined,
        errorMessage: undefined,
        nextAttemptAt: null,
        networkRecovery: null
      });
    } catch (error) {
      if (!normalizeOzonNetworkError(error)) throw error;
      const current = await this.repository.getJob(job.id);
      if (ozonJobHasRemoteProgress(current)) return current;
      const networkRecovery = nextOzonNetworkRecovery(current, {
        phase: 'N8N_DISPATCH',
        resumeState: 'READY',
        error,
        checkpoint: {
          jobId: job.id,
          sku: job.sku,
          revision,
          signature,
          offerIds: dispatchOfferIds,
          ...offerContractMetadata,
          storeAlias: job.storeAlias,
          taskFolder
        }
      });
      await this.clearTerminalDirectoryMarker(current);
      return this.repository.transitionJob(current.id, {
        rowVersion: current.rowVersion,
        state: 'READY',
        eventType: 'NETWORK_RETRY_SCHEDULED',
        message: 'n8n 暂时不可达；原任务已进入网络恢复队列',
        errorCode: networkRecovery.errorCode,
        errorMessage: networkRecovery.errorMessage,
        nextAttemptAt: networkRecovery.nextAttemptAt,
        incrementRetry: true,
        networkRecovery
      });
    }
  }

  async returnManualJobToEdit(
    sku: string,
    id: string,
    input: { jobRowVersion: number; listingRowVersion: number }
  ): Promise<{ job: OzonPublishJob; listing: OzonListingDraft; recovery: Record<string, unknown> }> {
    const [job, listing, settings] = await Promise.all([
      this.repository.getJob(id, 'MANUAL'),
      this.repository.getListing(sku),
      this.repository.getSettings()
    ]);
    if (job.sku !== sku) throw new AppError('NOT_FOUND', '该手动 OZON 任务不属于当前 SKU', { sku, id }, 404);
    const returnedToEdit = job.state === 'CANCELLED' && job.payload?.returnedToEdit && typeof job.payload.returnedToEdit === 'object';
    if (!returnedToEdit && !['FAILED', 'NEEDS_ATTENTION'].includes(job.state)) {
      throw new AppError('CONFIG_INVALID', '只有失败或需要处理的手动任务才能返回编辑', { id, state: job.state }, 409);
    }
    if (!returnedToEdit && (job.rowVersion !== input.jobRowVersion || listing.rowVersion !== input.listingRowVersion)) {
      throw new AppError('TASK_LOCKED', '任务或草稿版本已变化，请刷新后重试', {
        jobExpected: job.rowVersion,
        jobActual: input.jobRowVersion,
        listingExpected: listing.rowVersion,
        listingActual: input.listingRowVersion
      }, 409);
    }
    if (!settings.rootDirectory || job.directoryStage !== 'PROCESSING' || !job.workRelPath || !job.taskFolder) {
      throw new AppError('VERSION_CONFLICT', '失败任务缺少可恢复的 processing 目录信息', { id }, 409);
    }
    const revision = Number(job.revision || job.payload?.revision || 0);
    const signature = String(job.directorySignature || job.payload?.directorySignature || '').trim();
    const expectedTaskFolder = `${sku}__r${revision}`;
    const scope = archiveDirectoryScope(job);
    const expectedProcessingPath = `processing/${scope.lifecycleFolder}`;
    if (!revision || !signature || job.taskFolder !== expectedTaskFolder || job.workRelPath.replaceAll('\\', '/') !== expectedProcessingPath) {
      throw new AppError('VERSION_CONFLICT', '失败任务的 SKU、revision 或目录签名不匹配', { id }, 409);
    }
    const rootReal = await realpath(this.compatibility.canonicalizePath(settings.rootDirectory));
    const source = await resolveExistingLifecycleDirectory(rootReal, job.workRelPath);
    const marker = await readAndValidateTaskMarker(
      source,
      { jobId: id, sku, revision, signature },
      productJsonIntegrityModeForJob(job)
    );
    await validateProductJsonSignature(source, signature, marker.integrityMode);
    const targetRelPath = scope.storeScoped
      ? portableRelativePath(scope.inboxPrefix, 'inbox', sku)
      : portableRelativePath('inbox', sku);
    const target = resolveLifecyclePath(rootReal, targetRelPath);
    const restored = await restoreOzonVariantsForEditing({ rootReal, source, target, jobId: id, sku, revision, signature });
    const recovery = {
      mode: restored.mode,
      sourceWorkRelPath: job.workRelPath,
      targetWorkRelPath: targetRelPath,
      assetCount: restored.assetCount,
      signature,
      restoredAt: restored.restoredAt
    };
    if (returnedToEdit) return { job, listing, recovery };
    let result: { job: OzonPublishJob; listing: OzonListingDraft };
    try {
      result = await this.repository.returnManualJobToEdit({
        id,
        sku,
        jobRowVersion: input.jobRowVersion,
        listingRowVersion: input.listingRowVersion,
        recovery
      });
    } catch (error) {
      if (restored.created) await rm(target, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    await this.writeTerminalDirectoryMarker(result.job, 'CANCELLED');
    return { ...result, recovery };
  }

  async updateListing(sku: string, input: unknown): Promise<OzonListingDraft> {
    const rawBody = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const requestedCurrency = String(rawBody.currency ?? 'CNY').trim().toUpperCase();
    if (requestedCurrency !== 'CNY') {
      throw new AppError(
        'CONFIG_INVALID',
        '手动 OZON 上品资料必须使用账户上品币种 CNY 保存；请刷新后使用 CNY 价格重试',
        { currency: requestedCurrency || null, expectedCurrency: 'CNY' },
        409
      );
    }
    const current = await this.repository.getListing(sku);
    if (current.data.currency === 'RUB') {
      const projection = await this.readManualPriceProjection(current);
      if (projection?.status !== 'RECALCULATED') {
        throw new AppError(
          'CONFIG_INVALID',
          '历史 RUB 草稿缺少可验证的 CNY 定价基线，禁止将原 RUB 数值直接标记为 CNY',
          { sku, projectionStatus: projection?.status || 'UNAVAILABLE', reason: projection?.reason },
          409
        );
      }
    }
    const settings = await this.repository.getSettings();
    const clientBody: Record<string, unknown> = { ...rawBody, currency: 'CNY' as const };
    delete clientBody.purchaseMeasurements;
    if (clientBody.initialization && typeof clientBody.initialization === 'object' && !Array.isArray(clientBody.initialization)) {
      const initialization = { ...(clientBody.initialization as Record<string, unknown>) };
      delete initialization.grossWeightResolution;
      delete initialization.presetSnapshot;
      delete initialization.pricingResolution;
      clientBody.initialization = initialization;
    }
    const candidate = {
      ...clientBody,
      mediaSourceRoot: settings.rootDirectory ? this.productRoot(settings.rootDirectory, sku) : ''
    };
    const parsed = ozonListingDraftInputSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new AppError(
        'CONFIG_INVALID',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；'),
        { issues: parsed.error.issues },
        409
      );
    }
    const category = parsed.data.categoryKey
      ? await this.repository.getCategory(parsed.data.categoryKey)
      : undefined;
    const categoryAttributes = category?.publishedVersion?.snapshot.attributes || [];
    if (!categoryUsesOzonManualPurchaseMeasurements(categoryAttributes)) {
      return this.repository.updateListing(sku, parsed.data);
    }
    const purchase = await this.purchases.getPurchase(sku);
    const procurement = purchase.procurementVersions?.[0];
    if (!procurement) {
      throw new AppError('CONFIG_INVALID', '采购管理尚无可用采购版本，无法获取产品尺寸与净重', { sku }, 409);
    }
    const purchaseMeasurements = createOzonManualPurchaseMeasurements(procurement);
    const projection = projectOzonManualPurchaseMeasurements(
      parsed.data.sharedAttributes,
      categoryAttributes,
      purchaseMeasurements
    );
    return this.repository.updateListing(sku, {
      ...parsed.data,
      purchaseMeasurements,
      sharedAttributes: projection.attributes
    });
  }

  async updateSharedMaterial(sku: string, input: unknown): Promise<OzonListingDraft> {
    const parsed = ozonSharedMaterialDraftInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new AppError(
        'CONFIG_INVALID',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；'),
        { issues: parsed.error.issues },
        409
      );
    }
    const current = await this.repository.getListing(sku);
    const assets = new Map((current.data.mediaAssets || []).map((asset) => [asset.assetId, asset]));
    for (const [variantIndex, variant] of parsed.data.variants.entries()) {
      for (const [mediaIndex, reference] of variant.media.entries()) {
        const asset = assets.get(reference.assetId);
        if (!asset || asset.relativePath !== reference.relativePath || asset.kind !== reference.kind) {
          throw new AppError('CONFIG_INVALID', '公共素材引用了不存在或已变化的媒体资源', {
            variantIndex,
            mediaIndex,
            assetId: reference.assetId
          }, 409);
        }
        if (asset.validationStatus !== 'VALID') {
          throw new AppError('CONFIG_INVALID', '公共素材不能使用校验失败的媒体资源', {
            variantIndex,
            mediaIndex,
            assetId: reference.assetId
          }, 409);
        }
      }
    }
    const existingByProductVariantId = new Map(current.data.offers.map((offer) => [
      String(offer.productVariantId || offer.variantId),
      offer
    ]));
    const usedCodes = new Set(current.data.offers.map((offer) => offer.variantCode));
    const offers: OzonListingDraft['data']['offers'] = parsed.data.variants.map((variant) => {
      const existing = existingByProductVariantId.get(variant.productVariantId);
      const variantCode = existing?.variantCode || nextOzonVariantCode(usedCodes);
      if (!variantCode) {
        throw new AppError('CONFIG_INVALID', 'OZON 公共素材最多支持 99 个稳定产品变体', { sku }, 409);
      }
      usedCodes.add(variantCode);
      return {
        variantId: existing?.variantId || variant.variantId,
        productVariantId: variant.productVariantId,
        productVariantName: variant.productVariantName,
        ...(variant.productVariantColor ? { productVariantColor: variant.productVariantColor } : {}),
        variantCode,
        offerId: existing?.offerId || stableOzonOfferId(current.sku, variantCode),
        barcode: existing?.barcode || '',
        modelGroup: current.sku,
        // Compatibility-only placeholders. They are never read by the new
        // publication path; each store materializes authoritative values.
        price: Number(existing?.price || 1),
        ...(existing?.oldPrice !== undefined ? { oldPrice: existing.oldPrice } : {}),
        ...(existing?.minPrice !== undefined ? { minPrice: existing.minPrice } : {}),
        stock: Number(existing?.stock || 0),
        descriptionRu: variant.descriptionRu || parsed.data.descriptionRu,
        ...(variant.descriptionSource ? { descriptionSource: variant.descriptionSource } : {}),
        descriptionWarnings: [],
        attributes: existing?.attributes || [],
        media: variant.media.map((reference, sortOrder) => ({
          ...reference,
          sortOrder,
          isPrimary: reference.kind === 'image'
            && variant.media.findIndex((candidate) => candidate.kind === 'image') === sortOrder
        }))
      };
    });
    return this.repository.updateListing(current.sku, {
      ...current.data,
      rowVersion: parsed.data.rowVersion,
      descriptionRu: parsed.data.descriptionRu,
      ...(parsed.data.descriptionSource ? { descriptionSource: parsed.data.descriptionSource } : {}),
      offers
    }, { preserveGeneratedSources: true });
  }

  async scanMedia(
    sku: string,
    rowVersion: number
  ): Promise<{
    listing: OzonListingDraft;
    mediaAssets: OzonMediaAsset[];
    mediaDirectory: string;
    removedReferences: number;
    changed: boolean;
  }> {
    await this.requireManagementEnabled();
    const listing = await this.repository.getListing(sku);
    if (listing.rowVersion !== rowVersion) {
      throw new AppError('TASK_LOCKED', 'OZON 草稿版本已变化，请刷新后重新扫描媒体', { sku, expected: listing.rowVersion, actual: rowVersion }, 409);
    }
    const settings = await this.repository.getSettings();
    if (!settings.rootDirectory) throw new AppError('CONFIG_INVALID', '尚未配置 OZON 自动上品根目录', undefined, 409);
    await this.initializeRoot(settings.rootDirectory);
    const productRoot = this.productRoot(settings.rootDirectory, listing.sku);
    const mediaDirectory = path.join(productRoot, 'variants');
    const mediaAssets = await scanOzonMediaDirectory(productRoot, mediaDirectory);
    const assetsById = new Map(mediaAssets.map((asset) => [asset.assetId, asset]));
    const assetsByPath = new Map(mediaAssets.map((asset) => [normalizedRelativePath(asset.relativePath), asset]));
    let removedReferences = 0;
    const offers = listing.data.offers.map((offer) => ({
      ...offer,
      media: offer.media.flatMap((reference) => {
        const asset = assetsById.get(reference.assetId) || assetsByPath.get(normalizedRelativePath(reference.relativePath));
        if (!asset || asset.validationStatus !== 'VALID' || asset.kind !== reference.kind) {
          removedReferences += 1;
          return [];
        }
        return [{
          assetId: asset.assetId,
          relativePath: asset.relativePath,
          kind: asset.kind,
          sortOrder: reference.sortOrder,
          isPrimary: reference.isPrimary
        }];
      }).map((reference, index, references) => ({
        ...reference,
        sortOrder: index,
        isPrimary: reference.kind === 'image' && references.findIndex((candidate) => candidate.kind === 'image') === index
      }))
    }));
    const changed = hasOzonMediaScanChanged(listing, mediaAssets, offers, productRoot);
    if (!changed) {
      const latest = await this.repository.getListing(sku);
      if (latest.rowVersion !== rowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 草稿版本已变化，请刷新后重新扫描媒体', {
          sku,
          expected: latest.rowVersion,
          actual: rowVersion
        }, 409);
      }
      return { listing: latest, mediaAssets, mediaDirectory, removedReferences, changed: false };
    }
    const updated = await this.repository.updateListing(listing.sku, {
      ...listing.data,
      rowVersion,
      offers,
      mediaAssets,
      mediaSourceRoot: productRoot
    } satisfies OzonListingDraftInput);
    await rm(path.join(productRoot, '_READY'), { force: true }).catch(() => undefined);
    return { listing: updated, mediaAssets, mediaDirectory, removedReferences, changed: true };
  }

  async resolveMedia(sku: string, assetId: string): Promise<{ asset: OzonMediaAsset; filePath: string }> {
    const listing = await this.repository.getListing(sku);
    const asset = listing.data.mediaAssets.find((candidate) => candidate.assetId === assetId);
    if (!asset) throw new AppError('NOT_FOUND', 'OZON 共享媒体资源不存在，请重新扫描目录', { sku, assetId }, 404);
    if (asset.validationStatus !== 'VALID') throw new AppError('CONFIG_INVALID', asset.validationError || 'OZON 共享媒体资源校验失败', { sku, assetId }, 409);
    const settings = await this.repository.getSettings();
    if (!settings.rootDirectory) throw new AppError('CONFIG_INVALID', '尚未配置 OZON 自动上品根目录', undefined, 409);
    const productRoot = this.productRoot(settings.rootDirectory, listing.sku);
    const variantsRoot = path.join(productRoot, 'variants');
    const filePath = await secureResolve(productRoot, asset.relativePath);
    const resolvedVariantsRoot = await realpath(variantsRoot).catch(() => '');
    if (!resolvedVariantsRoot || !isPathInside(resolvedVariantsRoot, filePath)) {
      throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON 媒体文件不在当前 SKU 的 variants 目录中', { relativePath: asset.relativePath }, 403);
    }
    return { asset, filePath };
  }

  async updateSettings(input: unknown): Promise<{ settings: OzonPublicSystemSettings; readiness: Awaited<ReturnType<OzonPublishingService['readiness']>> }> {
    const body = input as Record<string, unknown>;
    if (body.rootDirectory) await this.assertRootDirectory(String(body.rootDirectory), Boolean(body.enabled));
    const settings = await this.repository.updateSettings(input);
    if (settings.enabled && settings.rootDirectory) await this.initializeRoot(settings.rootDirectory);
    return { settings: publicOzonSystemSettings(settings), readiness: await this.readiness(false) };
  }

  async synchronizeRootDirectory(rootDirectory: string): Promise<OzonSystemSettings> {
    const normalized = normalizePortablePath(rootDirectory);
    const current = await this.repository.getSettings();
    if (normalizePortablePath(current.rootDirectory) === normalized) return current;
    await this.assertRootDirectory(rootDirectory, false);
    return this.repository.updateSettings({
      rowVersion: current.rowVersion,
      enabled: current.enabled,
      rootDirectory,
      taskApiWebhookUrl: current.taskApiWebhookUrl,
      adminApiWebhookUrl: current.adminApiWebhookUrl,
      preflightWebhookUrl: current.preflightWebhookUrl,
      imageUploaderWorkflowId: current.imageUploaderWorkflowId,
      storeGatewayWorkflowId: current.storeGatewayWorkflowId,
      imageUploadConcurrency: current.imageUploadConcurrency,
      videoUploadConcurrency: current.videoUploadConcurrency,
      videoPrewarmEnabled: current.videoPrewarmEnabled
    });
  }

  async readiness(runNetworkCheck: boolean): Promise<{
    ready: boolean;
    mediaReady: boolean;
    databaseReady: boolean;
    rootReady: boolean;
    workflowReady: boolean;
    videoUploadReady: boolean;
    settings: OzonPublicSystemSettings;
    issues: string[];
    mediaIssues: string[];
  }> {
    const settings = await this.repository.getSettings();
    const issues: string[] = [];
    const mediaIssues: string[] = [];
    const databaseReady = this.repository.configured;
    if (!settings.enabled) issues.push('OZON 上品管理未启用');
    if (!databaseReady) mediaIssues.push('OZON 上品管理尚未配置 PostgreSQL DATABASE_URL');
    let rootReady = false;
    if (!settings.rootDirectory) {
      issues.push('尚未配置 OZON 自动上品根目录');
      mediaIssues.push('尚未配置 OZON 自动上品根目录');
    }
    else {
      const info = await lstat(settings.rootDirectory).catch(() => undefined);
      rootReady = Boolean(info?.isDirectory() && !info.isSymbolicLink());
      if (!rootReady) {
        issues.push('OZON 自动上品根目录不存在或不是安全目录');
        mediaIssues.push('OZON 自动上品根目录不存在或不是安全目录');
      }
    }
    const workflowReady = Boolean(
      settings.taskApiWebhookUrl
      && settings.preflightWebhookUrl
      && settings.imageUploaderWorkflowId
      && settings.storeGatewayWorkflowId
    );
    if (!workflowReady) issues.push('OZON n8n 工作流或 Webhook 配置尚未同步');
    void runNetworkCheck;
    const latest = settings;
    return {
      ready: Boolean(latest.enabled && databaseReady && rootReady && workflowReady),
      mediaReady: Boolean(databaseReady && rootReady),
      databaseReady,
      rootReady,
      workflowReady,
      videoUploadReady: latest.videoUploadReady,
      settings: publicOzonSystemSettings(latest),
      issues,
      mediaIssues
    };
  }

  async initializeRoot(rootDirectory: string): Promise<{ rootDirectory: string; directories: string[] }> {
    await this.assertRootDirectory(rootDirectory, true);
    const directories = ['', 'inbox', 'processing', 'success', 'failed', '.locks', 'errors'].map((name) => name ? path.join(rootDirectory, name) : rootDirectory);
    for (const directory of directories) await mkdir(directory, { recursive: true });
    const probe = path.join(rootDirectory, `.merchroute-ozon-probe-${process.pid}-${Date.now()}`);
    try {
      await writeFileAtomic(probe, 'ok', { encoding: 'utf8' });
    } finally {
      await rm(probe, { force: true }).catch(() => undefined);
    }
    return { rootDirectory, directories };
  }

  async generate(sku: string, rowVersion: number): Promise<{
    listing: OzonListingDraft;
    productJson: OzonProductV2;
    productJsonPath: string;
    readyMarker: string;
    signature: string;
  }> {
    await this.requireManagementEnabled();
    return this.withGenerationLock(sku, async () => {
      const synchronized = await this.synchronizeManualPurchaseMeasurements(sku, rowVersion);
      assertOzonManualPurchaseMeasurementsReady(synchronized.projection || { issues: [] });
      return this.generateUnlocked(sku, synchronized.listing.rowVersion);
    });
  }

  /**
   * Builds and validates the current immutable source product without writing
   * a schedulable legacy inbox marker. OZON multistore persists the returned
   * product under shared/<sku>/<generatedVersionId> itself.
   */
  async buildSharedProduct(sku: string, rowVersion: number): Promise<{
    listing: OzonListingDraft;
    productJson: OzonProductV2;
    sourceMediaDirectory: string;
  }> {
    await this.requireManagementEnabled();
    return this.withGenerationLock(sku, async () => {
      const listing = await this.repository.getListing(sku);
      if (listing.rowVersion !== rowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 草稿版本已变化，请重新生成发布计划', {
          sku,
          expected: listing.rowVersion,
          actual: rowVersion
        }, 409);
      }
      const contentPolicyVersion = listing.contentPolicyVersion;
      if (contentPolicyVersion !== OZON_CONTENT_POLICY_V2 && contentPolicyVersion !== OZON_CONTENT_POLICY_V3) {
        throw new AppError('VERSION_CONFLICT', 'OZON 公共素材缺少可执行的冻结内容策略版本', {
          sku,
          contentPolicyVersion: contentPolicyVersion || 'MISSING'
        }, 409);
      }
      const settings = await this.repository.getSettings();
      const generated = await this.generateUnlocked(sku, rowVersion, undefined, {
        preparedListing: listing,
        settings,
        skipArtifactWrite: true,
        storeNeutralSource: true
      });
      return {
        listing: generated.listing,
        productJson: generated.productJson,
        sourceMediaDirectory: this.productRoot(settings.rootDirectory, sku)
      };
    });
  }

  async resolveVariantColorAuthority(sku: string, rowVersion: number): Promise<OzonVariantColorAuthority> {
    const listing = await this.repository.getListing(sku);
    if (listing.rowVersion !== rowVersion) {
      throw new AppError('VERSION_CONFLICT', 'OZON 公共素材版本已变化，请重新生成发布计划', {
        sku,
        expected: listing.rowVersion,
        actual: rowVersion
      }, 409);
    }
    return this.resolveVariantColorAuthorityForListing(listing, ozonSharedMaterialVariants(listing));
  }

  /** Materializes a complete, store-neutral product from public material and one frozen store preset. */
  async buildStorePresetProduct(
    sku: string,
    rowVersion: number,
    presetDefinition: unknown,
    targetCurrency: 'RUB' | 'CNY',
    presetBinding: { id: string; name: string; rowVersion: number },
    frozenVariantColorAuthority?: OzonVariantColorAuthority
  ): Promise<{
    listing: OzonListingDraft;
    productJson: OzonProductV2;
    sourceMediaDirectory: string;
  }> {
    const parsedPreset = ozonPresetInputSchema.safeParse(presetDefinition);
    if (!parsedPreset.success) {
      throw new AppError('CONFIG_INVALID', 'OZON 店铺默认预设商品蓝图无效', { issues: parsedPreset.error.issues }, 409);
    }
    if (!this.pricing) throw new AppError('DATABASE_UNAVAILABLE', '售价计算服务尚未初始化，不能物化 OZON 店铺商品', undefined, 503);
    if (!this.titleTranslator?.configured) throw new AppError('CONFIG_INVALID', 'OZON 标题翻译工作流尚未配置', undefined, 503);
    const pricingService = this.pricing;
    const titleTranslator = this.titleTranslator;
    return this.withGenerationLock(sku, async () => {
      const [listing, purchase] = await Promise.all([
        this.repository.getListing(sku),
        this.purchases.getPurchase(sku)
      ]);
      if (listing.rowVersion !== rowVersion) {
        throw new AppError('VERSION_CONFLICT', 'OZON 公共素材版本已变化，请重新生成发布计划', {
          sku,
          expected: listing.rowVersion,
          actual: rowVersion
        }, 409);
      }
      const contentPolicyVersion = listing.contentPolicyVersion;
      if (contentPolicyVersion !== OZON_CONTENT_POLICY_V2 && contentPolicyVersion !== OZON_CONTENT_POLICY_V3) {
        throw new AppError('VERSION_CONFLICT', 'OZON 公共素材缺少可执行的冻结内容策略版本', {
          sku,
          contentPolicyVersion: contentPolicyVersion || 'MISSING'
        }, 409);
      }
      const preset = parsedPreset.data;
      const category = await this.repository.getCategory(preset.categoryKey);
      const published = category.publishedVersion;
      if (!published) throw new AppError('CONFIG_INVALID', '店铺默认预设引用的 OZON 类目尚未发布', { categoryKey: preset.categoryKey }, 409);
      const requiredAttributeCoverage = projectOzonPresetRequiredAttributeCoverage(published.snapshot, preset);
      const missingPresetRequiredAttributes = requiredAttributeCoverage.filter((attribute) => !attribute.covered);
      if (missingPresetRequiredAttributes.length) {
        throw new AppError(
          'CONFIG_INVALID',
          `OZON 店铺默认预设缺少必填目录属性：${missingPresetRequiredAttributes.map((attribute) => (
            `${attribute.nameZh || attribute.nameRu || attribute.name} / ${attribute.nameRu || attribute.name} · #${attribute.attributeId}`
          )).join('；')}`,
          {
            categoryKey: preset.categoryKey,
            presetId: presetBinding.id,
            missingRequiredAttributes: missingPresetRequiredAttributes,
            requiredAttributeCoverage
          },
          409
        );
      }
      const procurement = purchase.procurementVersions?.[0];
      if (!procurement) throw new AppError('CONFIG_INVALID', '产品没有可用于 OZON 物化的采购版本', { sku }, 409);
      const sourceVariants = ozonSharedMaterialVariants(listing);
      if (!sourceVariants.length) throw new AppError('CONFIG_INVALID', 'OZON 公共素材至少需要一个产品变体', { sku }, 409);
      const variantColorAuthority = frozenVariantColorAuthority
        ? assertOzonVariantColorAuthority(frozenVariantColorAuthority)
        : await this.resolveVariantColorAuthorityForListing(listing, sourceVariants);
      assertOzonVariantColorCategoryCompatibility(published.snapshot.attributes, variantColorAuthority, {
        sku,
        categoryKey: preset.categoryKey,
        presetId: presetBinding.id
      });
      const colorByProductVariantId = new Map(
        variantColorAuthority.variants.map((variant) => [variant.productVariantId, variant] as const)
      );
      const grossWeightResolution = resolveOzonGrossWeight(procurement, preset.dimensions);
      const pricing = await calculateManualListingPrices(
        pricingService,
        preset as unknown as OzonPreset,
        listing.sku,
        listing.productName,
        procurement,
        grossWeightResolution.effectiveGrossWeightGrams,
        targetCurrency
      );
      const translation = await titleTranslator.translate({
        content: listing.productName,
        language: preset.titleTranslation.language,
        maxLength: preset.titleTranslation.maxLength,
        workflowId: preset.titleTranslation.workflowId,
        requestId: `ozon-title-${listing.sku}-${presetBinding.id}-r${presetBinding.rowVersion}-${contentPolicyVersion}`,
        contentPolicyVersion,
        ...(published.snapshot.nameRu ? { productTypeRu: published.snapshot.nameRu } : {})
      });
      const titleRu = validateGeneratedOzonTitle(translation, preset.titleTranslation.maxLength);
      const descriptionRu = String(listing.data.descriptionRu || sourceVariants.find((variant) => variant.descriptionRu)?.descriptionRu || '').trim();
      if (!descriptionRu) throw new AppError('CONFIG_INVALID', 'OZON 公共素材缺少可共享俄文商品详情', { sku }, 409);
      let sharedAttributes = cloneOzonAttributes(preset.sharedAttributes);
      let purchaseMeasurements: OzonManualPurchaseMeasurements | undefined;
      if (categoryUsesOzonManualPurchaseMeasurements(published.snapshot.attributes)) {
        purchaseMeasurements = createOzonManualPurchaseMeasurements(procurement);
        const projection = projectOzonManualPurchaseMeasurements(
          sharedAttributes,
          published.snapshot.attributes,
          purchaseMeasurements
        );
        assertOzonManualPurchaseMeasurementsReady(projection);
        sharedAttributes = projection.attributes;
      }
      const seeds = expandOzonStorePresetSeeds(sourceVariants, preset);
      const offerIds = deriveOzonStorePresetOfferIds(listing, preset);
      const offers: OzonListingDraft['data']['offers'] = seeds.map((seed, seedIndex) => {
        const color = colorByProductVariantId.get(seed.productVariantId);
        if (variantColorAuthority.variants.length && !color) {
          throw new AppError('OZON_VARIANT_COLOR_REQUIRED', 'E001 审核颜色快照缺少当前 OZON 商品变体', {
            sku,
            productVariantId: seed.productVariantId,
            productVariantName: seed.productVariantName,
            presetId: presetBinding.id
          }, 409);
        }
        return {
          variantId: seed.variantId,
          productVariantId: seed.productVariantId,
          productVariantName: seed.productVariantName,
          ...(seed.productVariantColor ? { productVariantColor: seed.productVariantColor } : {}),
          variantCode: offerIds[seedIndex]!.slice(`${listing.sku}-`.length),
          offerId: offerIds[seedIndex]!,
          barcode: '',
          modelGroup: listing.sku,
          ...pricing.prices,
          stock: seed.stock,
          descriptionRu: seed.descriptionRu || descriptionRu,
          ...(seed.descriptionSource ? { descriptionSource: seed.descriptionSource } : {}),
          descriptionWarnings: [],
          attributes: applyOzonVariantColorDefaults(
            mergeOzonPresetVariantAttributes(preset.variantAttributes, seed.sizeAttribute),
            published.snapshot.attributes,
            color
          ),
          media: seed.media
        };
      });
      const capturedAt = new Date().toISOString();
      const preparedListing: OzonListingDraft = {
        ...listing,
        data: {
          categoryKey: preset.categoryKey,
          categoryVersionId: published.id,
          fulfillmentMode: 'FBS',
          warehouseId: OZON_SHARED_SOURCE_STORE_FIELDS.warehouseId,
          currency: targetCurrency,
          vat: preset.vat,
          titleRu,
          descriptionRu,
          ...(listing.data.descriptionSource ? { descriptionSource: listing.data.descriptionSource } : {}),
          descriptionWarnings: [],
          initialization: {
            status: 'COMPLETE',
            initializedAt: capturedAt,
            issues: [],
            grossWeightResolution,
            presetSnapshot: {
              presetId: presetBinding.id,
              presetName: presetBinding.name,
              presetRowVersion: presetBinding.rowVersion,
              capturedAt,
              definition: preset
            },
            pricingResolution: pricing.pricingResolution,
            title: {
              workflowId: preset.titleTranslation.workflowId,
              language: preset.titleTranslation.language,
              maxLength: preset.titleTranslation.maxLength,
              cached: translation.cached,
              ...(translation.model ? { model: translation.model } : {})
            }
          },
          brand: '无品牌',
          dimensions: applyOzonGrossWeightToDimensions(preset.dimensions, grossWeightResolution),
          ...(purchaseMeasurements ? { purchaseMeasurements } : {}),
          sharedAttributes,
          offers,
          mediaAssets: listing.data.mediaAssets,
          mediaSourceRoot: listing.data.mediaSourceRoot,
          videoUploadMode: published.snapshot.media?.defaultVideoUploadMode || 'COMPRESSED_COPY'
        }
      };
      const settings = await this.repository.getSettings();
      const generated = await this.generateUnlocked(sku, rowVersion, undefined, {
        preparedListing,
        settings,
        skipArtifactWrite: true,
        storeNeutralSource: true
      });
      return {
        listing: generated.listing,
        productJson: generated.productJson,
        sourceMediaDirectory: this.productRoot(settings.rootDirectory, sku)
      };
    });
  }

  private async resolveVariantColorAuthorityForListing(
    listing: OzonListingDraft,
    sourceVariants: OzonSharedMaterialVariant[]
  ): Promise<OzonVariantColorAuthority> {
    const realVariants = sourceVariants.filter((variant) => variant.productVariantName.trim() !== '默认变体');
    if (!realVariants.length) return createOzonVariantColorAuthority([]);
    const identity = await this.purchases.getProductIdentityBySku(listing.sku);
    const identityById = new Map((identity?.variants || []).map((variant) => [variant.variantId, variant] as const));
    const variants = await Promise.all(realVariants.map(async (variant) => {
      const productVariant = identityById.get(variant.productVariantId);
      const color = productVariant?.ozonColor;
      if (!productVariant || !color) {
        throw new AppError('OZON_VARIANT_COLOR_REQUIRED', 'OZON 商品变体缺少 E001 审核确定的颜色目录身份', {
          sku: listing.sku,
          productVariantId: variant.productVariantId,
          productVariantName: variant.productVariantName
        }, 409);
      }
      let active;
      try {
        active = await this.repository.getActiveCatalogDictionaryValue('colors', color.dictionaryId, color.valueId);
      } catch (error) {
        throw new AppError('OZON_VARIANT_COLOR_INCOMPATIBLE', 'E001 审核颜色在当前 OZON 目录中不存在或已停用', {
          sku: listing.sku,
          productVariantId: variant.productVariantId,
          productVariantName: variant.productVariantName,
          itemKey: color.itemKey,
          dictionaryId: color.dictionaryId,
          valueId: color.valueId,
          causeCode: error instanceof AppError ? error.code : undefined
        }, 409);
      }
      if (active.attributeId !== 10096
        || active.itemKey !== color.itemKey
        || active.dictionaryId !== color.dictionaryId
        || active.valueId !== color.valueId
        || active.nameRu !== color.nameRu
        || active.nameZh !== color.nameZh) {
        throw new AppError('OZON_VARIANT_COLOR_INCOMPATIBLE', 'E001 审核颜色身份与当前 OZON 目录值不一致', {
          sku: listing.sku,
          productVariantId: variant.productVariantId,
          productVariantName: variant.productVariantName,
          expected: color,
          actual: active
        }, 409);
      }
      return {
        productVariantId: variant.productVariantId,
        itemKey: color.itemKey,
        dictionaryId: color.dictionaryId,
        valueId: color.valueId,
        nameRu: color.nameRu,
        source: color.source
      };
    }));
    return createOzonVariantColorAuthority(variants);
  }

  async calculateStorePresetPrices(
    sku: string,
    presetDefinition: unknown,
    targetCurrency: 'RUB' | 'CNY'
  ): Promise<{ currency: 'RUB' | 'CNY'; price: number; oldPrice: number; minPrice: number }> {
    const parsed = ozonPresetInputSchema.safeParse(presetDefinition);
    if (!parsed.success) {
      throw new AppError('CONFIG_INVALID', 'OZON 店铺默认预设定价合同无效', { issues: parsed.error.issues }, 409);
    }
    if (!this.pricing) {
      throw new AppError('DATABASE_UNAVAILABLE', '售价计算服务尚未初始化，不能物化 OZON 店铺价格', undefined, 503);
    }
    const purchase = await this.purchases.getPurchase(sku);
    const procurement = purchase.procurementVersions?.[0];
    if (!procurement) throw new AppError('CONFIG_INVALID', '产品没有可用于 OZON 售价计算的采购版本', { sku }, 409);
    const resolution = resolveOzonGrossWeight(procurement, parsed.data.dimensions);
    const calculation = await calculateManualListingPrices(
      this.pricing,
      parsed.data as unknown as OzonPreset,
      purchase.sku,
      purchase.productName,
      procurement,
      resolution.effectiveGrossWeightGrams,
      targetCurrency,
      false
    );
    return { currency: targetCurrency, ...calculation.prices };
  }

  private async generateAutomatic(
    sku: string,
    rowVersion: number,
    publishOfferIds?: string[],
    frozenSettings?: OzonSystemSettings
  ): ReturnType<OzonPublishingService['generate']> {
    const currentSettings = await this.requireManagementEnabled();
    if (frozenSettings) assertSameAutomaticSettings(currentSettings, frozenSettings, sku);
    return this.withGenerationLock(sku, async () => {
      const synchronized = await this.synchronizeManualPurchaseMeasurements(sku, rowVersion);
      assertOzonManualPurchaseMeasurementsReady(synchronized.projection || { issues: [] });
      return this.generateUnlocked(sku, synchronized.listing.rowVersion, publishOfferIds, {
        ...(frozenSettings ? { settings: frozenSettings } : {})
      });
    });
  }

  private async generateUnlocked(
    sku: string,
    rowVersion: number,
    publishOfferIds?: string[],
    options: {
      preparedListing?: OzonListingDraft;
      archiveUnboundRound?: boolean;
      settings?: OzonSystemSettings;
      skipArtifactWrite?: boolean;
      storeNeutralSource?: boolean;
    } = {}
  ): Promise<{
    listing: OzonListingDraft;
    productJson: OzonProductV2;
    productJsonPath: string;
    readyMarker: string;
    signature: string;
  }> {
    const preview = options.preparedListing || await this.repository.getListing(sku);
    if (preview.rowVersion !== rowVersion) {
      throw new AppError('TASK_LOCKED', 'OZON 草稿版本已变化，请刷新后重新生成', { sku, expected: preview.rowVersion, actual: rowVersion }, 409);
    }
    const categoryKey = preview.data.categoryKey;
    if (!categoryKey) throw new AppError('CONFIG_INVALID', '请选择 OZON 类目模板');
    const category = await this.repository.getCategory(categoryKey);
    const published = category.publishedVersion;
    if (!published) throw new AppError('CONFIG_INVALID', '所选 OZON 类目模板尚未发布', { categoryKey }, 409);
    const submissionPreview = scopeOzonListingSubmission(preview, publishOfferIds);
    const descriptionPlan = prepareOzonDescriptionPlan(submissionPreview);
    assertNoUserManagedOzonSystemMediaAttributes(submissionPreview);
    const platformBrand = manualListingPlatformBrand(submissionPreview.data.brand, submissionPreview.data.sharedAttributes);
    const platformSharedAttributes = manualListingPlatformAttributes(
      submissionPreview.data.sharedAttributes,
      published.snapshot.attributes,
      submissionPreview.sku,
      category.typeId,
      submissionPreview.data.titleRu,
      descriptionPlan.shared.value,
      submissionPreview.data.brand
    );
    const platformOfferAttributes = submissionPreview.data.offers.map((offer) => withoutOzonSystemMediaAttributes(offer.attributes));
    assertOzonPlatformText(platformBrand, 'brand', 'OZON 品牌');
    assertOzonPlatformAttributes(platformSharedAttributes, 'sharedAttributes');
    platformOfferAttributes.forEach((attributes, index) => assertOzonPlatformAttributes(attributes, `offers.${index}.attributes`));
    const currentSettings = await this.repository.getSettings();
    if (options.settings) {
      assertSameAutomaticSettings(currentSettings, options.settings, sku, !options.storeNeutralSource);
    }
    const settings = options.settings || currentSettings;
    if (!settings.rootDirectory) throw new AppError('CONFIG_INVALID', '尚未配置 OZON 自动上品根目录', undefined, 409);
    if (options.preparedListing) {
      const rootInfo = await lstat(settings.rootDirectory).catch(() => undefined);
      if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new AppError('CONFIG_INVALID', 'OZON 自动上品根目录不存在或不可安全读取', undefined, 409);
      }
    } else {
      await this.initializeRoot(settings.rootDirectory);
    }
    const videoContract = resolveOzonVideoContract(published.snapshot.attributes, {
      categoryKey,
      categoryVersionId: published.id
    });
    const configuredWarehouseId = String(submissionPreview.data.warehouseId || '').trim();
    const storeContext: { warehouseId: string; accountCurrency: 'RUB' | 'CNY' } = options.storeNeutralSource
      ? OZON_SHARED_SOURCE_STORE_FIELDS
      : /^\d+$/.test(configuredWarehouseId)
        ? { warehouseId: configuredWarehouseId, accountCurrency: submissionPreview.data.currency }
        : await this.resolveStoreContext(configuredWarehouseId, submissionPreview.data.fulfillmentMode);
    // The first media read is intentionally before reserveSubmissionRevision: a
    // missing, changed or unsafe source must not consume a listing revision.
    const previewVerifiedMedia = await this.verifyMediaCurrent(submissionPreview, settings.rootDirectory);
    const listing = options.preparedListing || await this.repository.reserveSubmissionRevision(sku, rowVersion);
    const submissionListing = scopeOzonListingSubmission(listing, publishOfferIds);
    // Manual generation is checked again after the CAS reservation to close the
    // filesystem TOCTOU window. Compatible append already runs inside the atomic
    // repository callback, so its preview check is the in-transaction recheck.
    const verifiedMedia = options.preparedListing
      ? previewVerifiedMedia
      : await this.verifyMediaCurrent(submissionListing, settings.rootDirectory);
    if (videoContract.videoPolicy.mode === 'COVER_ONLY') {
      this.logger.warn({
        categoryKey,
        categoryVersionId: published.id,
        missingAttributeIds: videoContract.missingIntroductionAttributeIds
      }, 'OZON 类目不支持完整产品介绍视频属性，已降级为仅视频封面');
    }
    const mergeDescriptionWarnings = (...groups: Array<NonNullable<OzonListingDraft['data']['descriptionWarnings']> | undefined>) => {
      const byIdentity = new Map<string, NonNullable<OzonListingDraft['data']['descriptionWarnings']>[number]>();
      for (const warning of groups.flatMap((group) => group || [])) {
        if (!warning.removedFragments.length) continue;
        byIdentity.set(`${warning.fieldPath}:${warning.beforeSha256}:${warning.afterSha256}`, warning);
      }
      return [...byIdentity.values()];
    };
    const payload = {
      schemaVersion: 2,
      storeAlias: options.storeNeutralSource ? OZON_SHARED_SOURCE_STORE_FIELDS.storeAlias : settings.defaultStoreAlias,
      productCode: listing.sku,
      productName: listing.productName,
      revision: listing.revision,
      fulfillmentMode: options.storeNeutralSource ? OZON_SHARED_SOURCE_STORE_FIELDS.fulfillmentMode : submissionListing.data.fulfillmentMode,
      warehouseId: storeContext.warehouseId,
      category: {
        categoryKey,
        descriptionCategoryId: category.descriptionCategoryId,
        typeId: category.typeId,
        templateVersion: published.versionNo,
        schemaHash: published.schemaHash
      },
      currency: storeContext.accountCurrency,
      vat: submissionListing.data.vat,
      titleRu: submissionListing.data.titleRu,
      descriptionRu: descriptionPlan.shared.value,
      descriptionWarnings: mergeDescriptionWarnings(listing.data.descriptionWarnings, descriptionPlan.shared.warnings),
      brand: platformBrand,
      videoUploadMode: submissionListing.data.videoUploadMode,
      runtime: {
        imageUploadConcurrency: settings.imageUploadConcurrency,
        videoUploadConcurrency: settings.videoUploadConcurrency,
        videoPrewarmEnabled: false,
        videoCompressionProfileVersion: 'ozon-h264-aac-v1'
      },
      mediaCapabilities: videoContract.mediaCapabilities,
      videoPolicy: videoContract.videoPolicy,
      dimensions: submissionListing.data.dimensions,
      sharedAttributes: platformSharedAttributes.map((attribute) => attribute.attributeId === 4191
        ? { ...attribute, values: [{ value: descriptionPlan.shared.value }] }
        : attribute),
      mediaAssets: productMediaAssets(submissionListing, verifiedMedia.videoDurationSecondsByAssetId),
      offers: enforceOzonOfferModelGroups(submissionListing.data.offers, listing.sku).map((offer, index) => {
        const planned = descriptionPlan.offers[index]!;
        return {
          ...offer,
          titleRu: submissionListing.data.titleRu,
          descriptionRu: planned.value,
          ...(offer.descriptionSource ? { descriptionSource: offer.descriptionSource } : {}),
          descriptionWarnings: mergeDescriptionWarnings(offer.descriptionWarnings, planned.warnings),
          attributes: platformOfferAttributes[index]!.map((attribute) => attribute.attributeId === 4191
            ? { ...attribute, values: [{ value: planned.value }] }
            : attribute)
        };
      })
    };
    const parsed = ozonProductV2Schema.safeParse(payload);
    if (!parsed.success) {
      throw new AppError('CONFIG_INVALID', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；'), { issues: parsed.error.issues }, 409);
    }
    const missingRequiredAttributes = findMissingOzonRequiredAttributes(
      published.snapshot.attributes,
      parsed.data.sharedAttributes,
      parsed.data.offers
    );
    if (missingRequiredAttributes.length) {
      const attributesById = new Map(published.snapshot.attributes.map((attribute) => [attribute.id, attribute]));
      const missingRequiredAttributeDetails = missingRequiredAttributes.map((offer) => ({
        ...offer,
        attributes: offer.attributeIds.map((attributeId) => {
          const attribute = attributesById.get(attributeId);
          return {
            attributeId,
            name: String(attribute?.name || ''),
            nameRu: String(attribute?.nameRu || attribute?.name || ''),
            nameZh: String(attribute?.nameZh || '')
          };
        })
      }));
      throw new AppError(
        'CONFIG_INVALID',
        missingRequiredAttributeDetails
          .map((offer) => `${offer.offerId}: 缺少必填目录属性 ${offer.attributes.map((attribute) => (
            `${attribute.nameZh || attribute.nameRu || attribute.name} / ${attribute.nameRu || attribute.name} · #${attribute.attributeId}`
          )).join('、')}`)
          .join('；'),
        { missingRequiredAttributes: missingRequiredAttributeDetails },
        409
      );
    }
    const serialized = `${JSON.stringify(parsed.data, null, 2)}\n`;
    const signature = `sha256:${createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex')}`;
    if (options.skipArtifactWrite) {
      return { listing, productJson: parsed.data, productJsonPath: '', readyMarker: '', signature };
    }
    const productDirectory = path.join(settings.rootDirectory, 'inbox', listing.sku);
    const prepared = await prepareOzonInboxRound({
      rootDirectory: settings.rootDirectory,
      productDirectory,
      sku: listing.sku,
      revision: listing.revision,
      signature,
      findBoundJob: (existingRevision, existingSignature) => (
        this.repository.findInboxRoundJob(listing.sku, existingRevision, existingSignature)
      ),
      archiveUnbound: options.archiveUnboundRound !== false
    });
    if (prepared.archivedPath) {
      await this.repository.recordInboxRoundReleased(listing.sku, {
        existingRevision: prepared.archivedRound?.existingRevision || 0,
        existingSignature: prepared.archivedRound?.existingSignature || '',
        replacedByRevision: listing.revision,
        replacedBySignature: signature,
        archivedPath: prepared.archivedPath,
        reason: prepared.archivedRound?.reason || 'STALE_INBOX_ROUND'
      });
      this.logger.warn({
        sku: listing.sku,
        revision: listing.revision,
        archivedPath: prepared.archivedPath
      }, '已归档未绑定任务的过期 OZON product.json');
    }
    await mkdir(productDirectory, { recursive: true });
    const productJsonPath = path.join(productDirectory, 'product.json');
    const readyMarker = path.join(productDirectory, '_READY');
    try {
      await writeFileAtomic(productJsonPath, serialized, { encoding: 'utf8' });
      await writeFileAtomic(readyMarker, `${JSON.stringify({
        sku: listing.sku,
        revision: listing.revision,
        signature,
        generatedAt: new Date().toISOString()
      })}\n`, { encoding: 'utf8' });
    } catch (error) {
      await removeGeneratedOzonArtifactIfOwned({ productJsonPath, readyMarker, signature });
      throw error;
    }
    return { listing, productJson: parsed.data, productJsonPath, readyMarker, signature };
  }

  async compatibleAppend(
    sku: string,
    input: OzonCompatibleAppendInput
  ): Promise<OzonCompatibleAppendResult> {
    throw legacyListingWriteReadOnly(sku);
    await this.requireManagementEnabled();
    return this.withGenerationLock(sku, async () => {
      const context = await this.prepareCompatibleAppendContext(sku);
      const { plan, preset, settings } = context;
      if (input.rowVersion !== plan.rowVersion) {
        throw new AppError('TASK_LOCKED', 'OZON 资料版本已变化，请重新检测兼容追加', {
          sku: plan.sku,
          expected: plan.rowVersion,
          actual: input.rowVersion
        }, 409);
      }
      if (input.planHash !== plan.planHash) {
        throw new AppError('TASK_LOCKED', 'OZON 兼容追加计划已变化，请重新检测并确认', {
          sku: plan.sku,
          expectedPlanHash: plan.planHash,
          actualPlanHash: input.planHash
        }, 409);
      }
      if (!plan.canAppend || !preset) {
        throw new AppError('VERSION_CONFLICT', plan.blockedReason || '当前 OZON 资料不能兼容追加', {
          sku: plan.sku,
          reasonCode: 'OZON_COMPATIBLE_APPEND_BLOCKED'
        }, 409);
      }
      const categoryVersionId = String(context.listing.data.categoryVersionId || '').trim();
      if (!categoryVersionId) {
        throw new AppError('VERSION_CONFLICT', '既有资料缺少 OZON 类目版本，不能兼容追加', { sku: plan.sku }, 409);
      }
      const canDispatch = Boolean(settings.enabled && settings.credentialReady && settings.taskApiWebhookUrl);
      if (!canDispatch) {
        throw new AppError('VERSION_CONFLICT', 'OZON 全局配置、默认店铺凭据或任务调度 Webhook 尚未就绪', {
          sku: plan.sku,
          reasonCode: 'OZON_COMPATIBLE_APPEND_RUNTIME_NOT_READY'
        }, 409);
      }
      const listingData = await this.prepareCompatibleAppendListing(context);
      const expectedOfferIds = [...plan.preservedOfferIds, ...plan.submittedOfferIds];
      const { createExpectedOzonOfferSnapshots } = await import('./auto-publishing.js');
      const expectedOfferSnapshots = createExpectedOzonOfferSnapshots(
        listingData.offers,
        listingData.mediaAssets,
        plan.submittedOfferIds,
        context.listing.ozonProductLinks || []
      );
      const offerContractVersion = 1 as const;
      const offerContractHash = `sha256:${createHash('sha256').update(stableOzonJson({
        offerContractVersion,
        expectedOfferIds,
        submittedOfferIds: plan.submittedOfferIds,
        publishOfferIds: plan.submittedOfferIds,
        expectedOfferSnapshots
      })).digest('hex')}`;
      const remoteAbsenceEvidence = await this.assertCompatibleAppendRemoteAbsence(plan.submittedOfferIds, settings);
      let preparedArtifact: OzonCompatibleAppendPreparedArtifact | undefined;
      let preparedJobId: string | undefined;
      let committed: Awaited<ReturnType<OzonRepository['createCompatibleAppendManualJob']>>;
      try {
        committed = await this.repository.createCompatibleAppendManualJob({
          sku: plan.sku,
          rowVersion: plan.rowVersion,
          listingData,
          storeAlias: settings.defaultStoreAlias,
          state: 'WAITING_MEDIA',
          planHash: plan.planHash,
          manifestSignature: plan.manifestSignature,
          expectedPresetId: preset.id,
          expectedPresetRowVersion: preset.rowVersion,
          expectedCategoryVersionId: categoryVersionId,
          expectedSettingsRowVersion: settings.rowVersion,
          expectedRootDirectory: settings.rootDirectory,
          expectedStoreAlias: settings.defaultStoreAlias,
          expectedProductIdentityHash: context.productIdentity.hash,
          expectedProductName: context.productIdentity.productName,
          expectedProductVariants: context.productIdentity.productVariants,
          offerContractVersion,
          offerContractHash,
          expectedOfferSnapshots,
          preservedOfferIds: plan.preservedOfferIds,
          submittedOfferIds: plan.submittedOfferIds,
          expectedOfferIds,
          remoteAbsenceEvidence
        }, async ({ listing, revision, jobId }) => {
          preparedJobId = jobId;
          const generated = await this.generateUnlocked(plan.sku, listing.rowVersion, plan.submittedOfferIds, {
            preparedListing: listing,
            archiveUnboundRound: false,
            settings
          });
          preparedArtifact = {
            signature: generated.signature,
            productJsonPath: generated.productJsonPath,
            readyMarker: generated.readyMarker,
            taskFolder: `${plan.sku}__r${revision}`,
            workRelPath: portableRelativePath('inbox', plan.sku)
          };
          const generatedOfferIds = generated.productJson.offers.map((offer) => offer.offerId);
          if (JSON.stringify(generatedOfferIds) !== JSON.stringify(plan.submittedOfferIds)) {
            throw new AppError('VERSION_CONFLICT', 'OZON 兼容追加 product.json 与确认计划不一致', {
              sku: plan.sku,
              generatedOfferIds,
              submittedOfferIds: plan.submittedOfferIds
            }, 409);
          }
          return preparedArtifact;
        });
      } catch (error) {
        if (preparedArtifact && preparedJobId) {
          let confirmedUncommitted = false;
          try {
            await this.repository.getJob(preparedJobId);
          } catch (lookupError) {
            confirmedUncommitted = lookupError instanceof AppError && lookupError.code === 'NOT_FOUND';
            if (!confirmedUncommitted) {
              this.logger.warn({ err: lookupError, sku: plan.sku, jobId: preparedJobId }, '无法确认 OZON 兼容追加事务状态，已保留签名产物等待核对');
            }
          }
          if (confirmedUncommitted) {
            await removeGeneratedOzonArtifactIfOwned(preparedArtifact);
          }
        }
        throw error;
      }

      let job = committed.job;
      const result = (dispatched: boolean): OzonCompatibleAppendResult => ({
        mode: 'COMPATIBLE_APPEND',
        job,
        listing: committed.listing,
        dispatched,
        preservedOfferIds: plan.preservedOfferIds,
        submittedOfferIds: plan.submittedOfferIds,
        variants: plan.newOffers.map((offer) => ({
          variantId: offer.variantId,
          variantName: offer.variantName,
          offerId: offer.offerId
        }))
      });
      try {
        const response = await postJson(settings.taskApiWebhookUrl, {
          action: 'enqueue',
          jobId: job.id,
          sku: plan.sku,
          revision: committed.listing.revision,
          signature: committed.artifact.signature,
          offerIds: plan.submittedOfferIds,
          expectedOfferIds,
          submittedOfferIds: plan.submittedOfferIds,
          publishOfferIds: plan.submittedOfferIds,
          expectedOfferSnapshots,
          offerContractVersion,
          offerContractHash,
          storeAlias: settings.defaultStoreAlias,
          productJsonPath: committed.artifact.productJsonPath
        });
        const claimed = claimedDirectoryMetadata(response, {
          taskFolder: committed.artifact.taskFolder,
          workRelPath: committed.artifact.workRelPath,
          directoryStage: 'INBOX',
          directorySignature: committed.artifact.signature
        });
        job = await this.repository.transitionJob(job.id, {
          rowVersion: job.rowVersion,
          state: 'SUBMITTING',
          eventType: 'N8N_DISPATCHED',
          message: 'OZON 兼容追加任务已提交到 n8n 调度工作流',
          taskId: stringValue(response.taskId || response.task_id),
          payload: { accepted: response.accepted !== false, mode: 'COMPATIBLE_APPEND' },
          jobPayload: {
            mode: 'COMPATIBLE_APPEND',
            planHash: plan.planHash,
            manifestSignature: plan.manifestSignature,
            revision: committed.listing.revision,
            offerIds: expectedOfferIds,
            expectedOfferIds,
            preservedOfferIds: plan.preservedOfferIds,
            submittedOfferIds: plan.submittedOfferIds,
            publishOfferIds: plan.submittedOfferIds,
            expectedOfferSnapshots,
            offerContractVersion,
            offerContractHash,
            storeAlias: settings.defaultStoreAlias,
            ...claimed
          },
          offerIds: expectedOfferIds,
          storeAlias: settings.defaultStoreAlias,
          revision: committed.listing.revision,
          ...claimed,
          errorCode: undefined,
          errorMessage: undefined,
          nextAttemptAt: null,
          networkRecovery: null
        });
        return result(true);
      } catch (error) {
        this.logger.warn({ err: error, sku: plan.sku, jobId: job.id }, 'OZON 兼容追加 n8n 调度失败');
        const current = await this.repository.getJob(job.id);
        if (ozonJobHasRemoteProgress(current)) {
          job = current;
          return result(true);
        }
        const networkError = normalizeOzonNetworkError(error);
        if (networkError) {
          const networkRecovery = nextOzonNetworkRecovery(current, {
            phase: 'N8N_DISPATCH',
            resumeState: 'READY',
            error,
            checkpoint: {
              mode: 'COMPATIBLE_APPEND',
              jobId: current.id,
              sku: plan.sku,
              revision: committed.listing.revision,
              signature: committed.artifact.signature,
              offerIds: plan.submittedOfferIds,
              expectedOfferIds,
              preservedOfferIds: plan.preservedOfferIds,
              submittedOfferIds: plan.submittedOfferIds,
              publishOfferIds: plan.submittedOfferIds,
              expectedOfferSnapshots,
              offerContractVersion,
              offerContractHash,
              storeAlias: settings.defaultStoreAlias,
              taskFolder: committed.artifact.taskFolder,
              workRelPath: committed.artifact.workRelPath
            }
          });
          job = await this.repository.transitionJob(current.id, {
            rowVersion: current.rowVersion,
            state: 'READY',
            eventType: 'NETWORK_RETRY_SCHEDULED',
            message: 'n8n 暂时不可达；已保留原兼容追加任务，网络恢复后将自动续跑',
            errorCode: networkRecovery.errorCode,
            errorMessage: networkRecovery.errorMessage,
            nextAttemptAt: networkRecovery.nextAttemptAt,
            incrementRetry: true,
            networkRecovery
          });
        } else {
          job = await this.repository.transitionJob(current.id, {
            rowVersion: current.rowVersion,
            state: 'NEEDS_ATTENTION',
            eventType: 'N8N_DISPATCH_FAILED',
            message: '兼容追加任务目录已生成，但 n8n 调度失败',
            errorCode: 'N8N_DISPATCH_FAILED',
            errorMessage: error instanceof Error ? error.message : 'n8n 调度失败',
            nextAttemptAt: null,
            networkRecovery: null
          });
        }
        return result(false);
      }
    });
  }

  async submit(sku: string, rowVersion: number): Promise<OzonManualSubmissionResult> {
    await this.requireManagementEnabled();
    const [currentListing, currentSettings] = await Promise.all([
      this.repository.getListing(sku),
      this.repository.getSettings()
    ]);
    const databaseMappingExists = await this.repository.hasProductMappingForSku(
      currentSettings.defaultStoreAlias,
      currentListing.sku
    );
    const platformEvidenceExists = Boolean(currentListing.ozonProductLinks?.length) || databaseMappingExists;
    if (currentListing.status === 'PUBLISHED' || platformEvidenceExists) {
      throw new AppError(
        'OZON_COMPATIBLE_APPEND_REQUIRED',
        '已发布或存在 OZON 平台身份的资料不能通过全量“重新上品”提交；请使用兼容追加或平台恢复流程',
        {
          sku: currentListing.sku,
          status: currentListing.status,
          hasListingLinks: Boolean(currentListing.ozonProductLinks?.length),
          hasDatabaseMapping: databaseMappingExists
        },
        409
      );
    }
    const generated = await this.generate(sku, rowVersion);
    const settings = await this.repository.getSettings();
    const canDispatch = Boolean(settings.enabled && settings.credentialReady && settings.taskApiWebhookUrl);
    const offerIds = generated.productJson.offers.map((offer) => offer.offerId);
    const taskFolder = `${sku}__r${generated.productJson.revision}`;
    const workRelPath = portableRelativePath('inbox', sku);
    const manualJob = await this.repository.createManualJob({
      sku,
      offerId: offerIds[0],
      offerIds,
      storeAlias: settings.defaultStoreAlias,
      revision: generated.productJson.revision,
      taskFolder,
      workRelPath,
      directoryStage: 'INBOX',
      directorySignature: generated.signature,
      payload: {
        revision: generated.productJson.revision,
        offerIds,
        storeAlias: settings.defaultStoreAlias
      },
      state: canDispatch ? 'READY' : 'WAITING_MEDIA'
    });
    let job = manualJob.job;
    const listing = await this.repository.markListingSubmitted(sku, job.id);
    const superseded = manualJob.supersededJobId ? { supersededJobId: manualJob.supersededJobId } : {};
    if (!canDispatch) return { listing, job, productJsonPath: generated.productJsonPath, dispatched: false, ...superseded };
    try {
      const response = await postJson(settings.taskApiWebhookUrl, {
        action: 'enqueue',
        jobId: job.id,
        sku,
        revision: generated.productJson.revision,
        signature: generated.signature,
        offerIds,
        storeAlias: settings.defaultStoreAlias,
        productJsonPath: generated.productJsonPath
      });
      const claimed = claimedDirectoryMetadata(response, {
        taskFolder,
        workRelPath,
        directoryStage: 'INBOX',
        directorySignature: generated.signature
      });
      job = await this.repository.transitionJob(job.id, {
        rowVersion: job.rowVersion,
        state: 'SUBMITTING',
        eventType: 'N8N_DISPATCHED',
        message: '任务已提交到 OZON n8n 调度工作流',
        taskId: stringValue(response.taskId || response.task_id),
        payload: { accepted: response.accepted !== false },
        jobPayload: {
          revision: generated.productJson.revision,
          offerIds,
          storeAlias: settings.defaultStoreAlias,
          ...claimed
        },
        offerIds,
        storeAlias: settings.defaultStoreAlias,
        revision: generated.productJson.revision,
        ...claimed,
        errorCode: undefined,
        errorMessage: undefined,
        nextAttemptAt: null,
        networkRecovery: null
      });
      return { listing, job, productJsonPath: generated.productJsonPath, dispatched: true, ...superseded };
    } catch (error) {
      this.logger.warn({ err: error, sku, jobId: job.id }, 'OZON n8n 任务提交失败');
      const current = await this.repository.getJob(job.id);
      if (ozonJobHasRemoteProgress(current)) {
        return { listing, job: current, productJsonPath: generated.productJsonPath, dispatched: true, ...superseded };
      }
      const networkError = normalizeOzonNetworkError(error);
      if (networkError) {
        const networkRecovery = nextOzonNetworkRecovery(current, {
          phase: 'N8N_DISPATCH',
          resumeState: 'READY',
          error,
          checkpoint: {
            jobId: current.id,
            sku,
            revision: generated.productJson.revision,
            signature: generated.signature,
            offerIds,
            storeAlias: settings.defaultStoreAlias,
            taskFolder,
            workRelPath
          }
        });
        job = await this.repository.transitionJob(current.id, {
          rowVersion: current.rowVersion,
          state: 'READY',
          eventType: 'NETWORK_RETRY_SCHEDULED',
          message: 'n8n 暂时不可达；已保留原手动任务，网络恢复后将自动续跑',
          errorCode: networkRecovery.errorCode,
          errorMessage: networkRecovery.errorMessage,
          nextAttemptAt: networkRecovery.nextAttemptAt,
          incrementRetry: true,
          networkRecovery
        });
      } else {
        job = await this.repository.transitionJob(current.id, {
          rowVersion: current.rowVersion,
          state: 'NEEDS_ATTENTION',
          eventType: 'N8N_DISPATCH_FAILED',
          message: '任务目录已生成，但 n8n 调度失败',
          errorCode: 'N8N_DISPATCH_FAILED',
          errorMessage: error instanceof Error ? error.message : 'n8n 调度失败',
          nextAttemptAt: null,
          networkRecovery: null
        });
      }
      return { listing, job, productJsonPath: generated.productJsonPath, dispatched: false, ...superseded };
    }
  }

  async dispatchAutomaticJob(
    jobInput: OzonPublishJob,
    sku: string,
    rowVersion: number,
    metadata: Record<string, unknown> = {},
    frozenSettings?: OzonSystemSettings
  ): Promise<{ listing: OzonListingDraft; job: OzonPublishJob; productJsonPath: string; dispatched: boolean }> {
    let job = await this.repository.getJob(jobInput.id);
    assertLocalAutomaticDispatchJob(job, sku);
    const offerContract = parseAutomaticOfferContract(metadata);
    assertFrozenAutomaticOfferContract(job, metadata, offerContract, rowVersion);
    const generated = await this.generateAutomatic(sku, rowVersion, offerContract?.publishOfferIds, frozenSettings);
    const generatedArtifact = {
      productJsonPath: generated.productJsonPath,
      readyMarker: generated.readyMarker,
      signature: generated.signature
    };
    const generatedOfferIds = generated.productJson.offers.map((offer) => offer.offerId);
    if (offerContract && JSON.stringify(generatedOfferIds) !== JSON.stringify(offerContract.submittedOfferIds)) {
      await removeGeneratedOzonArtifactIfOwned(generatedArtifact);
      throw new AppError(
        'VERSION_CONFLICT',
        'OZON scoped product.json 与自动任务 submittedOfferIds 不一致',
        { generatedOfferIds, submittedOfferIds: offerContract.submittedOfferIds },
        409
      );
    }
    const submittedOfferIds = offerContract?.submittedOfferIds || generatedOfferIds;
    const expectedOfferIds = offerContract?.expectedOfferIds || generatedOfferIds;
    const offerContractMetadata = offerContract ? {
      offerContractVersion: metadata.offerContractVersion,
      offerContractHash: metadata.offerContractHash,
      expectedOfferIds,
      submittedOfferIds,
      publishOfferIds: offerContract.publishOfferIds,
      expectedOfferSnapshots: metadata.expectedOfferSnapshots
    } : {};
    const dispatchMetadata = {
      ...metadata,
      ...(isOzonAutoMaterialSnapshot(metadata.materialSnapshot) ? {
        materialSnapshot: completeOzonAutoMaterialSnapshot(metadata.materialSnapshot, {
          revision: generated.productJson.revision,
          signature: generated.signature,
          offerIds: submittedOfferIds
        })
      } : {})
    };
    const taskFolder = `${sku}__r${generated.productJson.revision}`;
    const workRelPath = portableRelativePath('inbox', sku);
    let settings: OzonSystemSettings;
    let canDispatch: boolean;
    try {
      job = await this.repository.getJob(jobInput.id);
      assertLocalAutomaticDispatchJob(job, sku);
      assertFrozenAutomaticOfferContract(job, metadata, offerContract, rowVersion);
      const currentSettings = await this.repository.getSettings();
      if (frozenSettings) assertSameAutomaticSettings(currentSettings, frozenSettings, sku);
      settings = frozenSettings || currentSettings;
      canDispatch = Boolean(settings.enabled && settings.credentialReady && settings.taskApiWebhookUrl);
      job = await this.repository.transitionJob(job.id, {
        rowVersion: job.rowVersion,
        state: 'WAITING_MEDIA',
        eventType: 'PRODUCT_JSON_GENERATED',
        message: canDispatch ? 'OZON product.json 已生成，正在等待 n8n 接收确认' : 'OZON product.json 已生成，等待系统配置就绪',
        jobPayload: {
          ...dispatchMetadata,
          revision: generated.productJson.revision,
          offerIds: expectedOfferIds,
          ...offerContractMetadata,
          storeAlias: settings.defaultStoreAlias
        },
        offerIds: expectedOfferIds,
        storeAlias: settings.defaultStoreAlias,
        revision: generated.productJson.revision,
        taskFolder,
        workRelPath,
        directoryStage: 'INBOX',
        directorySignature: generated.signature,
        stageStates: {
          images: 'LOCAL_READY',
          video: generated.productJson.offers.some((offer) => offer.media.some((media) => media.kind === 'video')) ? 'LOCAL_READY' : 'NOT_REQUIRED',
          price: 'CALCULATED',
          stock: 'READY'
        },
        errorCode: canDispatch ? undefined : 'OZON_RUNTIME_NOT_READY',
        errorMessage: canDispatch ? undefined : 'OZON 系统开关、默认店铺凭据或任务 Webhook 尚未就绪',
        nextAttemptAt: null
      });
    } catch (error) {
      await removeGeneratedOzonArtifactIfOwned(generatedArtifact);
      throw error;
    }
    const listing = await this.repository.markListingSubmitted(sku, job.id);
    if (!canDispatch) return { listing, job, productJsonPath: generated.productJsonPath, dispatched: false };
    try {
      const response = await postJson(settings.taskApiWebhookUrl, {
        action: 'enqueue',
        jobId: job.id,
        sku,
        revision: generated.productJson.revision,
        signature: generated.signature,
        offerIds: submittedOfferIds,
        ...offerContractMetadata,
        storeAlias: settings.defaultStoreAlias,
        productJsonPath: generated.productJsonPath
      });
      const claimed = claimedDirectoryMetadata(response, {
        taskFolder,
        workRelPath,
        directoryStage: 'INBOX',
        directorySignature: generated.signature
      });
      job = await this.repository.transitionJob(job.id, {
        rowVersion: job.rowVersion,
        state: 'SUBMITTING',
        eventType: 'N8N_DISPATCHED',
        message: '自动上品任务已提交到 OZON n8n 调度工作流',
        taskId: stringValue(response.taskId || response.task_id),
        payload: { accepted: response.accepted !== false },
        jobPayload: {
          ...dispatchMetadata,
          revision: generated.productJson.revision,
          offerIds: expectedOfferIds,
          ...offerContractMetadata,
          storeAlias: settings.defaultStoreAlias,
          ...claimed
        },
        offerIds: expectedOfferIds,
        storeAlias: settings.defaultStoreAlias,
        revision: generated.productJson.revision,
        ...claimed,
        nextAttemptAt: null,
        networkRecovery: null
      });
      return { listing, job, productJsonPath: generated.productJsonPath, dispatched: true };
    } catch (error) {
      this.logger.warn({ err: error, sku, jobId: job.id }, 'OZON 自动上品 n8n 调度失败');
      const current = await this.repository.getJob(job.id);
      if (ozonJobHasRemoteProgress(current)) {
        return { listing, job: current, productJsonPath: generated.productJsonPath, dispatched: true };
      }
      const networkError = normalizeOzonNetworkError(error);
      if (networkError) {
        const networkRecovery = nextOzonNetworkRecovery(current, {
          phase: 'N8N_DISPATCH',
          resumeState: 'READY',
          error,
          checkpoint: {
            jobId: current.id,
            sku,
            revision: generated.productJson.revision,
            signature: generated.signature,
            offerIds: submittedOfferIds,
            ...offerContractMetadata,
            storeAlias: settings.defaultStoreAlias,
            taskFolder,
            workRelPath
          }
        });
        job = await this.repository.transitionJob(current.id, {
          rowVersion: current.rowVersion,
          state: 'READY',
          eventType: 'NETWORK_RETRY_SCHEDULED',
          message: 'n8n 暂时不可达；已保留原自动任务，网络恢复后将自动续跑',
          errorCode: networkRecovery.errorCode,
          errorMessage: networkRecovery.errorMessage,
          nextAttemptAt: networkRecovery.nextAttemptAt,
          incrementRetry: true,
          networkRecovery
        });
      } else {
        job = await this.repository.transitionJob(current.id, {
          rowVersion: current.rowVersion,
          state: 'NEEDS_ATTENTION',
          eventType: 'N8N_DISPATCH_FAILED',
          message: '任务目录已生成，但 n8n 调度失败',
          errorCode: 'N8N_DISPATCH_FAILED',
          errorMessage: error instanceof Error ? error.message : 'n8n 调度失败',
          nextAttemptAt: null,
          networkRecovery: null
        });
      }
      return { listing, job, productJsonPath: generated.productJsonPath, dispatched: false };
    }
  }

  async resolveStoreContext(configuredValue: string, fulfillmentMode: 'FBS' | 'RFBS'): Promise<{ warehouseId: string; accountCurrency: 'RUB' | 'CNY' }> {
    const settings = await this.repository.getSettings();
    if (!settings.preflightWebhookUrl) throw new AppError('CONFIG_INVALID', '尚未配置 OZON 只读预检 Webhook', undefined, 409);
    const response = await postJson(settings.preflightWebhookUrl, { action: 'preflight' });
    const container = response.warehouses && typeof response.warehouses === 'object'
      ? response.warehouses as Record<string, unknown>
      : {};
    const warehouses = Array.isArray(container.warehouses) ? container.warehouses : [];
    const expected = String(configuredValue || '').trim();
    const match = warehouses
      .map((entry) => entry && typeof entry === 'object' ? entry as Record<string, unknown> : {})
      .find((entry) => {
        const id = String(entry.warehouse_id || entry.warehouseId || '').trim();
        const name = String(entry.name || '').trim();
        return expected === id || expected === name;
      });
    if (!match) throw new AppError('CONFIG_INVALID', '预设仓库未在当前 OZON 店铺中找到', { configuredValue: expected }, 409);
    const status = String(match.status || '').toLocaleLowerCase();
    if (status && !['created', 'active', 'working'].includes(status)) {
      throw new AppError('CONFIG_INVALID', '预设仓库当前不可用', { warehouseId: match.warehouse_id, name: match.name, status }, 409);
    }
    if (fulfillmentMode === 'RFBS' && match.is_rfbs === false) {
      throw new AppError('CONFIG_INVALID', '预设仓库不支持 rFBS', { warehouseId: match.warehouse_id, name: match.name }, 409);
    }
    const warehouseId = String(match.warehouse_id || match.warehouseId || '').trim();
    if (!/^\d+$/.test(warehouseId)) throw new AppError('CONFIG_INVALID', 'OZON 仓库 ID 无效', { warehouseId }, 409);
    const accountCurrency = String(response.accountCurrency || response.currency || '').trim().toUpperCase();
    if (accountCurrency !== 'RUB' && accountCurrency !== 'CNY') {
      throw new AppError('CONFIG_INVALID', 'OZON 只读预检未返回受支持的店铺合同币种', { accountCurrency }, 409);
    }
    return { warehouseId, accountCurrency };
  }

  async resolveWarehouseId(configuredValue: string, fulfillmentMode: 'FBS' | 'RFBS'): Promise<string> {
    return (await this.resolveStoreContext(configuredValue, fulfillmentMode)).warehouseId;
  }

  async preflight(): Promise<{
    ready: boolean;
    sellerId?: string;
    sellerName?: string;
    accountCurrency?: string;
    message: string;
  }> {
    const settings = await this.repository.getSettings();
    if (!settings.preflightWebhookUrl) {
      const message = '尚未配置 OZON 只读预检 Webhook';
      await this.repository.savePreflight({ credentialReady: false, status: 'FAILED', message });
      return { ready: false, message };
    }
    try {
      const response = await postJson(settings.preflightWebhookUrl, { action: 'preflight' });
      const ready = response.ready === true || response.ok === true;
      const result = {
        ready,
        sellerId: stringValue(response.sellerId || response.seller_id),
        sellerName: stringValue(response.sellerName || response.seller_name || response.companyName),
        accountCurrency: stringValue(response.accountCurrency || response.currency),
        message: stringValue(response.message) || (ready ? '默认店铺凭据和只读接口验证通过' : '默认店铺预检未通过')
      };
      await this.repository.savePreflight({
        credentialReady: ready,
        sellerId: result.sellerId,
        sellerName: result.sellerName,
        accountCurrency: result.accountCurrency,
        status: ready ? 'READY' : 'FAILED',
        message: result.message
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OZON 预检失败';
      if (normalizeOzonNetworkError(error)) {
        return { ready: false, message: `网络暂时不可用，已保留上次凭据状态：${message}` };
      }
      await this.repository.savePreflight({ credentialReady: false, status: 'FAILED', message });
      return { ready: false, message };
    }
  }

  async probeVideoUpload(sourceFilePath: string): Promise<{ ready: boolean; message: string; contentType?: string; publicStatus?: number }> {
    const settings = await this.repository.getSettings();
    if (!settings.preflightWebhookUrl) {
      const message = '尚未配置 OZON 只读预检 Webhook，无法执行视频上传能力探测';
      await this.repository.saveVideoUploadProbe({ ready: false, message });
      return { ready: false, message };
    }
    try {
      const response = await postJson(settings.preflightWebhookUrl, { action: 'videoUploadProbe', sourceFilePath });
      const contentType = stringValue(response.contentType || response.mimeType);
      const publicStatus = Number(response.publicStatus || response.statusCode || 0);
      const ready = (response.ready === true || response.ok === true) && (contentType || '').toLocaleLowerCase().startsWith('video/') && publicStatus >= 200 && publicStatus < 400;
      const message = stringValue(response.message) || (ready ? 'SiliconFlow MP4 上传与公网读取验证通过' : 'SiliconFlow MP4 上传或公网读取验证未通过');
      await this.repository.saveVideoUploadProbe({ ready, message });
      return { ready, message, ...(contentType ? { contentType } : {}), ...(publicStatus ? { publicStatus } : {}) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'SiliconFlow MP4 上传能力探测失败';
      if (normalizeOzonNetworkError(error)) {
        return { ready: false, message: `网络暂时不可用，已保留上次视频能力状态：${message}` };
      }
      await this.repository.saveVideoUploadProbe({ ready: false, message });
      return { ready: false, message };
    }
  }

  async syncCategory(input: unknown): Promise<{ category: Awaited<ReturnType<OzonRepository['getCategory']>>; source: 'OZON_API' }> {
    const body = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const descriptionCategoryId = Number(body.descriptionCategoryId);
    const typeId = Number(body.typeId);
    if (!Number.isInteger(descriptionCategoryId) || descriptionCategoryId < 1 || !Number.isInteger(typeId) || typeId < 1) {
      throw new AppError('CONFIG_INVALID', '同步类目必须提供有效的 descriptionCategoryId 和 typeId');
    }
    const settings = await this.repository.getSettings();
    if (!settings.adminApiWebhookUrl) throw new AppError('CONFIG_INVALID', '尚未配置 OZON 类目与系统配置 Webhook', undefined, 409);
    const response = await postJson(settings.adminApiWebhookUrl, {
      action: 'categorySchema',
      descriptionCategoryId,
      typeId,
      locale: 'DEFAULT'
    });
    const schema = response.category && typeof response.category === 'object'
      ? response.category as Record<string, unknown>
      : response;
    const categoryKey = String(body.categoryKey || `ozon-${descriptionCategoryId}-${typeId}`).trim().toLocaleLowerCase();
    const snapshot = {
      categoryKey,
      nameRu: String(body.nameRu || schema.nameRu || schema.name || `OZON ${descriptionCategoryId}/${typeId}`).trim(),
      nameZh: String(body.nameZh || schema.nameZh || '').trim(),
      descriptionCategoryId,
      typeId,
      attributes: Array.isArray(schema.attributes) ? schema.attributes : [],
      dictionarySnapshot: schema.dictionarySnapshot && typeof schema.dictionarySnapshot === 'object' ? schema.dictionarySnapshot : {},
      sourceSnapshot: schema,
      confirmedBy: String(body.confirmedBy || '').trim()
    };
    const existing = await this.repository.getCategory(categoryKey).catch((error) => {
      if (error instanceof AppError && error.code === 'NOT_FOUND') return undefined;
      throw error;
    });
    const category = existing
      ? await this.repository.saveCategoryDraft(categoryKey, snapshot)
      : await this.repository.createCategory(snapshot);
    return { category, source: 'OZON_API' };
  }

  async onMediaDelivered(input: {
    sku: string;
    stageId: 'E004' | 'E005';
    submissionId: string;
    variantId: string;
    deliveredAt: string;
    resolvedOutputRoot?: string;
    selectedRelativePaths?: string[];
  }): Promise<OzonPublishJob | undefined> {
    const result = await this.repository.enqueueAutomaticJob({
      sku: input.sku,
      mediaReady: false,
      media: {
        sourceStageId: input.stageId,
        submissionId: input.submissionId,
        variantId: input.variantId,
        deliveredAt: input.deliveredAt,
        resolvedOutputRoot: input.resolvedOutputRoot || '',
        selectedRelativePaths: input.selectedRelativePaths || []
      }
    });
    return result.job;
  }

  private async requireManagementEnabled(): Promise<OzonSystemSettings> {
    const settings = await this.repository.getSettings();
    if (!settings.enabled) throw ozonManagementDisabledError();
    return settings;
  }

  private async archiveSucceededDirectory(
    job: OzonPublishJob,
    input: OzonRuntimeUpdateInput
  ): Promise<{
    revision: number;
    taskFolder: string;
    workRelPath: string;
    directorySignature: string;
    videoCacheCleanedAt: string;
    moved: boolean;
  }> {
    const settings = await this.repository.getSettings();
    if (!settings.rootDirectory) throw new AppError('CONFIG_INVALID', '尚未配置 OZON 自动上品根目录', undefined, 409);
    const revision = Math.max(0, Number(input.revision || input.jobPayload?.revision || job.revision || job.payload?.revision || 0));
    if (!revision) throw new AppError('CONFIG_INVALID', 'OZON 任务缺少有效 revision，无法归档目录', { jobId: job.id }, 409);
    const taskFolder = normalizeLifecycleTaskFolder(
      input.taskFolder || input.jobPayload?.taskFolder || job.taskFolder || `${job.sku}__r${revision}`,
      job.sku,
      revision
    );
    const expectedSignature = String(
      input.directorySignature
      || input.jobPayload?.directorySignature
      || input.jobPayload?.signature
      || job.directorySignature
      || ''
    ).trim();
    const rootReal = await realpath(this.compatibility.canonicalizePath(settings.rootDirectory));
    const scope = archiveDirectoryScope(job);
    const integrityMode: OzonProductJsonIntegrityMode = scope.storeScoped ? 'RAW_BYTES' : 'CANONICAL_JSON';
    if (scope.storeScoped && input.storeAlias && input.storeAlias !== job.storeAlias) {
      throw new AppError('VERSION_CONFLICT', 'OZON 成功归档店铺与冻结任务不一致', {
        expected: job.storeAlias,
        actual: input.storeAlias
      }, 409);
    }
    const processingRelPath = scopedLifecyclePath(scope.prefix, 'processing', scope.lifecycleFolder);
    const inboxRelPath = scopedLifecyclePath(scope.inboxPrefix, 'inbox', job.sku);
    const requestedRelPath = tryPortableRelativePath(input.workRelPath || input.jobPayload?.workRelPath || job.workRelPath);
    let sourceRelPath: string;
    if (scope.storeScoped) {
      const expectedSourceRelPath = job.directoryStage === 'INBOX' ? inboxRelPath : processingRelPath;
      const suppliedPaths = [job.workRelPath, input.workRelPath, input.jobPayload?.workRelPath]
        .filter((value): value is string => Boolean(String(value || '').trim()));
      if (!requestedRelPath || suppliedPaths.some((value) => tryPortableRelativePath(value) !== expectedSourceRelPath)) {
        throw new AppError('VERSION_CONFLICT', 'OZON 多店铺成功归档目录与冻结店铺范围不一致', {
          storeAlias: job.storeAlias,
          expected: expectedSourceRelPath
        }, 409);
      }
      sourceRelPath = expectedSourceRelPath;
    } else {
      sourceRelPath = requestedRelPath?.startsWith('processing/')
        ? requestedRelPath
        : job.directoryStage === 'INBOX' && requestedRelPath === inboxRelPath
          ? inboxRelPath
          : processingRelPath;
    }
    const legacyInboxSource = sourceRelPath === inboxRelPath;
    const sourceInfo = await lstat(resolveLifecyclePath(rootReal, sourceRelPath)).catch(() => undefined);
    const priorSuccesses = await findSucceededTaskDirectories(rootReal, scope.lifecycleFolder, scope.prefix);
    if (priorSuccesses.length > 1) {
      throw new AppError('VERSION_CONFLICT', '同一 OZON 任务存在多个成功目录，已停止自动归档', {
        jobId: job.id,
        directories: priorSuccesses.map((entry) => entry.relativePath)
      }, 409);
    }
    const priorSuccess = priorSuccesses[0];
    if (priorSuccess) {
      if (sourceInfo) {
        throw new AppError('VERSION_CONFLICT', 'OZON processing 与 success 同时存在同一任务目录', {
          jobId: job.id,
          sourceRelPath,
          successRelPath: priorSuccess.relativePath
        }, 409);
      }
      const marker = await readAndValidateTaskMarker(priorSuccess.absolutePath, {
        jobId: job.id,
        sku: job.sku,
        revision,
        signature: expectedSignature
      }, integrityMode);
      await validateProductJsonSignature(priorSuccess.absolutePath, marker.signature, marker.integrityMode);
      await rm(path.join(priorSuccess.absolutePath, '.ozon-media-cache'), { recursive: true, force: true });
      return {
        revision,
        taskFolder,
        workRelPath: priorSuccess.relativePath,
        directorySignature: marker.signature,
        videoCacheCleanedAt: new Date().toISOString(),
        moved: false
      };
    }

    const source = await resolveExistingLifecycleDirectory(rootReal, sourceRelPath);
    const expectedMarker = {
      jobId: job.id,
      sku: job.sku,
      revision,
      signature: expectedSignature
    };
    const marker = legacyInboxSource
      ? await ensureLegacyInboxTaskMarker(source, expectedMarker)
      : await readAndValidateTaskMarker(source, expectedMarker, integrityMode);
    await validateProductJsonSignature(source, marker.signature, marker.integrityMode);
    await rm(path.join(source, '.ozon-media-cache'), { recursive: true, force: true });
    const videoCacheCleanedAt = new Date().toISOString();
    const date = shanghaiDate();
    const targetRelPath = scopedLifecyclePath(scope.prefix, 'success', date, scope.lifecycleFolder);
    const target = resolveLifecyclePath(rootReal, targetRelPath);
    await ensureSafeSuccessParent(rootReal, path.dirname(target), scope.prefix);
    const targetInfo = await lstat(target).catch(() => undefined);
    if (targetInfo) {
      throw new AppError('VERSION_CONFLICT', 'OZON 成功目录目标已存在，已停止覆盖', { targetRelPath }, 409);
    }
    await rename(source, target);
    return { revision, taskFolder, workRelPath: targetRelPath, directorySignature: marker.signature, videoCacheCleanedAt, moved: true };
  }

  private async rollbackPlatformStatusArchive(
    job: OzonPublishJob,
    archive: {
      revision: number;
      taskFolder: string;
      workRelPath: string;
      directorySignature: string;
    }
  ): Promise<void> {
    const settings = await this.repository.getSettings();
    if (!settings.rootDirectory) throw new AppError('CONFIG_INVALID', '尚未配置 OZON 自动上品根目录', undefined, 409);
    const rootReal = await realpath(this.compatibility.canonicalizePath(settings.rootDirectory));
    const scope = archiveDirectoryScope(job);
    const integrityMode: OzonProductJsonIntegrityMode = scope.storeScoped ? 'RAW_BYTES' : 'CANONICAL_JSON';
    const archivedRelPath = tryPortableRelativePath(archive.workRelPath);
    const successPrefix = `${scopedLifecyclePath(scope.prefix, 'success')}/`;
    const archivedSuffix = archivedRelPath?.startsWith(successPrefix)
      ? archivedRelPath.slice(successPrefix.length).split('/')
      : [];
    if (!archivedRelPath
      || archivedSuffix.length !== 2
      || !/^\d{4}-\d{2}-\d{2}$/.test(archivedSuffix[0] || '')
      || archivedSuffix[1] !== scope.lifecycleFolder) {
      throw new AppError('VERSION_CONFLICT', 'OZON 成功归档目录越过冻结店铺范围，不能自动回滚', {
        jobId: job.id,
        archivedRelPath: archive.workRelPath,
        expectedPrefix: successPrefix
      }, 409);
    }
    const archivedPath = await resolveExistingLifecycleDirectory(rootReal, archivedRelPath);
    const marker = await readAndValidateTaskMarker(archivedPath, {
      jobId: job.id,
      sku: job.sku,
      revision: archive.revision,
      signature: archive.directorySignature
    }, integrityMode);
    await validateProductJsonSignature(archivedPath, archive.directorySignature, marker.integrityMode);
    const fallbackRelPath = job.directoryStage === 'INBOX'
      ? scopedLifecyclePath(scope.inboxPrefix, 'inbox', job.sku)
      : scopedLifecyclePath(scope.prefix, 'processing', scope.lifecycleFolder);
    const originalRelPath = tryPortableRelativePath(job.workRelPath) || fallbackRelPath;
    if (originalRelPath !== fallbackRelPath) {
      throw new AppError('VERSION_CONFLICT', 'OZON 原任务目录阶段无效，不能自动回滚成功归档', {
        jobId: job.id,
        originalRelPath,
        expected: fallbackRelPath
      }, 409);
    }
    const originalPath = resolveLifecyclePath(rootReal, originalRelPath);
    const lifecycleParentRelPath = job.directoryStage === 'INBOX'
      ? scopedLifecyclePath(scope.inboxPrefix, 'inbox')
      : scopedLifecyclePath(scope.prefix, 'processing');
    const safeParent = await resolveSafeExistingLifecycleParent(rootReal, lifecycleParentRelPath);
    if (normalizedTaskPath(safeParent) !== normalizedTaskPath(path.dirname(originalPath))) {
      throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON 回滚目标父目录越过冻结生命周期范围', {
        jobId: job.id,
        originalRelPath,
        lifecycleParentRelPath
      }, 403);
    }
    const existing = await lstat(originalPath).catch((fsError: NodeJS.ErrnoException) => {
      if (fsError?.code === 'ENOENT') return undefined;
      throw fsError;
    });
    if (existing) {
      throw new AppError('VERSION_CONFLICT', 'OZON 原任务目录已重新出现，不能覆盖回滚', {
        jobId: job.id,
        originalRelPath,
        archivedRelPath: archive.workRelPath
      }, 409);
    }
    await rename(archivedPath, originalPath);
    if (job.state === 'NEEDS_ATTENTION'
      && originalRelPath === scopedLifecyclePath(scope.prefix, 'processing', scope.lifecycleFolder)) {
      const existingErrorMarker = await lstat(path.join(originalPath, '_ERROR.json')).catch((error: NodeJS.ErrnoException) => {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!existingErrorMarker) {
        await this.writeTerminalDirectoryMarker({ ...job, workRelPath: originalRelPath, directoryStage: 'PROCESSING' }, 'NEEDS_ATTENTION');
      }
    }
  }

  private async writeTerminalDirectoryMarker(job: OzonPublishJob, state: 'FAILED' | 'CANCELLED' | 'NEEDS_ATTENTION'): Promise<void> {
    if (job.directoryStage !== 'PROCESSING' || !job.workRelPath) return;
    const settings = await this.repository.getSettings();
    if (!settings.rootDirectory) return;
    const rootReal = await realpath(this.compatibility.canonicalizePath(settings.rootDirectory)).catch(() => '');
    if (!rootReal) return;
    const directory = await resolveExistingLifecycleDirectory(rootReal, job.workRelPath).catch(() => '');
    if (!directory) return;
    const revision = Number(job.revision || job.payload?.revision || 0);
    const signature = String(job.directorySignature || '').trim();
    if (!revision || !signature) {
      throw new AppError('VERSION_CONFLICT', '已认领 OZON 任务缺少 revision 或签名，不能写终态标记', { jobId: job.id }, 409);
    }
    await readAndValidateTaskMarker(directory, {
      jobId: job.id,
      sku: job.sku,
      revision,
      signature
    }, productJsonIntegrityModeForJob(job));
    const markerName = state === 'FAILED' ? '_FAILED.json' : state === 'CANCELLED' ? '_CANCELLED.json' : '_ERROR.json';
    await writeFileAtomic(path.join(directory, markerName), `${JSON.stringify({
      jobId: job.id,
      sku: job.sku,
      revision,
      state,
      recordedAt: new Date().toISOString()
    }, null, 2)}\n`, { encoding: 'utf8' });
  }

  private async clearSucceededTerminalDirectoryMarkers(job: OzonPublishJob): Promise<void> {
    if (job.state !== 'SUCCEEDED'
      || job.directoryStage !== 'SUCCESS'
      || !job.workRelPath
      || !job.taskFolder) {
      throw new AppError('VERSION_CONFLICT', 'OZON 成功任务缺少已提交的成功目录信息，不能清理历史终态标记', {
        jobId: job.id,
        state: job.state,
        directoryStage: job.directoryStage,
        workRelPath: job.workRelPath
      }, 409);
    }
    const workRelPath = tryPortableRelativePath(job.workRelPath);
    const scope = archiveDirectoryScope(job);
    const successPrefix = `${scopedLifecyclePath(scope.prefix, 'success')}/`;
    const successSuffix = workRelPath?.startsWith(successPrefix)
      ? workRelPath.slice(successPrefix.length).split('/')
      : [];
    if (!workRelPath
      || successSuffix.length !== 2
      || !/^\d{4}-\d{2}-\d{2}$/.test(successSuffix[0] || '')
      || successSuffix[1] !== scope.lifecycleFolder) {
      throw new AppError('VERSION_CONFLICT', 'OZON 成功任务目录不在 success 生命周期目录中', {
        jobId: job.id,
        workRelPath: job.workRelPath,
        expectedPrefix: successPrefix
      }, 409);
    }
    const settings = await this.repository.getSettings();
    if (!settings.rootDirectory) {
      throw new AppError('CONFIG_INVALID', '尚未配置 OZON 自动上品根目录，不能清理成功目录的历史终态标记', {
        jobId: job.id
      }, 409);
    }
    const revision = Number(job.revision || job.payload?.revision || 0);
    const signature = String(job.directorySignature || '').trim();
    if (!revision || !signature) {
      throw new AppError('VERSION_CONFLICT', 'OZON 成功任务缺少 revision 或目录签名，不能清理历史终态标记', {
        jobId: job.id
      }, 409);
    }
    const rootReal = await realpath(this.compatibility.canonicalizePath(settings.rootDirectory));
    const directory = await resolveExistingLifecycleDirectory(rootReal, workRelPath);
    const marker = await readAndValidateTaskMarker(directory, {
      jobId: job.id,
      sku: job.sku,
      revision,
      signature
    }, productJsonIntegrityModeForJob(job));
    await validateProductJsonSignature(directory, signature, marker.integrityMode);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const terminalMarkerStates = [
      ['_ERROR', 'NEEDS_ATTENTION'],
      ['_FAILED', 'FAILED'],
      ['_CANCELLED', 'CANCELLED']
    ] as const;
    for (const [markerBase, expectedState] of terminalMarkerStates) {
      const markerName = `${markerBase}.json`;
      const markerPath = path.join(directory, markerName);
      const info = await lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!info) continue;
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new AppError('VERSION_CONFLICT', 'OZON 成功目录的历史终态标记不是普通文件，已停止自动清理', {
          jobId: job.id,
          markerName
        }, 409);
      }
      let markerPayload: Record<string, unknown> | undefined;
      try {
        const parsedMarker: unknown = JSON.parse(await readFile(markerPath, 'utf8'));
        markerPayload = isRecordValue(parsedMarker) ? parsedMarker : undefined;
      } catch {
        markerPayload = undefined;
      }
      if (!markerPayload
        || markerPayload.jobId !== job.id
        || markerPayload.sku !== job.sku
        || markerPayload.revision !== revision
        || markerPayload.state !== expectedState) {
        throw new AppError('VERSION_CONFLICT', 'OZON 成功目录的历史终态标记内容或任务身份不匹配，已停止自动归档', {
          jobId: job.id,
          markerName,
          expectedState,
          reasonCode: 'OZON_SUCCESS_TERMINAL_MARKER_IDENTITY_MISMATCH'
        }, 409);
      }
      await rename(
        markerPath,
        path.join(directory, `${markerBase}.recovered-${timestamp}-${randomUUID().slice(0, 8)}.json`)
      ).catch((error: NodeJS.ErrnoException) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
  }

  private async clearTerminalDirectoryMarker(job: OzonPublishJob): Promise<void> {
    if (job.directoryStage !== 'PROCESSING' || !job.workRelPath) return;
    const settings = await this.repository.getSettings();
    if (!settings.rootDirectory) return;
    const rootReal = await realpath(this.compatibility.canonicalizePath(settings.rootDirectory)).catch(() => '');
    if (!rootReal) return;
    const directory = await resolveExistingLifecycleDirectory(rootReal, job.workRelPath).catch(() => '');
    if (!directory) return;
    const revision = Number(job.revision || job.payload?.revision || 0);
    const signature = String(job.directorySignature || '').trim();
    if (!revision || !signature) {
      throw new AppError('VERSION_CONFLICT', '已认领 OZON 任务缺少 revision 或签名，不能清理错误标记', { jobId: job.id }, 409);
    }
    await readAndValidateTaskMarker(directory, {
      jobId: job.id,
      sku: job.sku,
      revision,
      signature
    }, productJsonIntegrityModeForJob(job));
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const markerName of ['_ERROR', '_FAILED']) {
      const markerPath = path.join(directory, `${markerName}.json`);
      const info = await lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!info) continue;
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new AppError('VERSION_CONFLICT', 'OZON 错误标记不是普通文件，不能自动清理', { jobId: job.id, markerName }, 409);
      }
      await rename(markerPath, path.join(directory, `${markerName}.recovered-${timestamp}-${randomUUID().slice(0, 8)}.json`)).catch((error: NodeJS.ErrnoException) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
  }

  private productRoot(rootDirectory: string, sku: string): string {
    const normalizedSku = String(sku || '').trim();
    if (!/^\d{7}$/.test(normalizedSku)) throw new AppError('CONFIG_INVALID', 'SKU 必须是 7 位数字字符串', { sku });
    return path.join(rootDirectory, 'inbox', normalizedSku);
  }

  private async readManualPurchaseMeasurementProjection(
    listing: OzonListingDraft
  ): Promise<OzonListingDetail['purchaseMeasurementProjection']> {
    const categoryKey = String(listing.data?.categoryKey || '').trim();
    if (!categoryKey) return undefined;
    let categoryAttributes: OzonCategoryAttribute[] = [];
    try {
      const category = await this.repository.getCategory(categoryKey);
      categoryAttributes = category.publishedVersion?.snapshot.attributes || [];
    } catch {
      return undefined;
    }
    if (!categoryUsesOzonManualPurchaseMeasurements(categoryAttributes)) return undefined;
    try {
      const purchase = await this.purchases.getPurchase(listing.sku);
      const procurement = purchase.procurementVersions?.[0];
      if (!procurement) throw new AppError('CONFIG_INVALID', '采购管理尚无可用采购版本', { sku: listing.sku }, 409);
      const snapshot = createOzonManualPurchaseMeasurements(procurement);
      const projection = projectOzonManualPurchaseMeasurements(
        listing.data.sharedAttributes,
        categoryAttributes,
        snapshot
      );
      return {
        source: 'LATEST_PURCHASE',
        snapshot,
        fields: projection.fields,
        issues: projection.issues
      };
    } catch (error) {
      const snapshot = listing.data.purchaseMeasurements;
      if (!snapshot) return undefined;
      const projection = projectOzonManualPurchaseMeasurements(
        listing.data.sharedAttributes,
        categoryAttributes,
        snapshot
      );
      return {
        source: 'SNAPSHOT',
        snapshot,
        fields: projection.fields,
        issues: projection.issues,
        warning: `最新采购信息暂时读取失败，当前显示草稿快照；保存和生成时会重新读取。${error instanceof Error ? error.message : ''}`
      };
    }
  }

  private async readManualPriceProjection(listing: OzonListingDraft): Promise<OzonListingPriceProjection | undefined> {
    // Compatibility for old cached responses and narrow test/read models. A
    // persisted OzonListingDraft always has data; do not make unrelated detail
    // reads fail if a legacy adapter returns only listing identity metadata.
    if (!listing.data || !Array.isArray(listing.data.offers)) return undefined;
    const sourceCurrency = listing.data.currency;
    if (sourceCurrency !== 'RUB' && sourceCurrency !== 'CNY') {
      return {
        status: 'UNAVAILABLE',
        sourceCurrency: 'CNY',
        targetCurrency: 'CNY',
        pendingSave: false,
        offers: [],
        reason: '草稿缺少有效的原始价格币种'
      };
    }
    const storedOffers = listing.data.offers.map((offer) => ({
      offerId: offer.offerId,
      price: offer.price,
      ...(offer.oldPrice === undefined ? {} : { oldPrice: offer.oldPrice }),
      ...(offer.minPrice === undefined ? {} : { minPrice: offer.minPrice })
    }));
    if (sourceCurrency === 'CNY') {
      return {
        status: 'STORED',
        sourceCurrency,
        targetCurrency: 'CNY',
        pendingSave: false,
        offers: storedOffers
      };
    }

    try {
      if (!listing.data.offers.length) {
        throw new AppError('CONFIG_INVALID', '历史草稿没有可投影价格的 Offer', { sku: listing.sku }, 409);
      }
      if (!this.pricing) {
        throw new AppError('DATABASE_UNAVAILABLE', '售价计算服务尚未初始化', undefined, 503);
      }
      const preset = readOzonPresetSnapshot(listing.data.initialization?.presetSnapshot);
      if (!preset) {
        throw new AppError('CONFIG_INVALID', '历史草稿缺少冻结的上品预设快照', { sku: listing.sku }, 409);
      }
      const pricingResolution = readOzonPricingResolution(listing.data.initialization?.pricingResolution);
      if (!pricingResolution) {
        throw new AppError('CONFIG_INVALID', '历史草稿缺少冻结的定价与运费版本证据', { sku: listing.sku }, 409);
      }
      if (preset.currency !== sourceCurrency
        || pricingResolution.targetCurrency !== sourceCurrency
        || pricingResolution.pricingTemplateId !== preset.pricingTemplateId
        || pricingResolution.shippingTemplateId !== preset.shippingTemplateId
        || pricingResolution.shippingServiceCode !== preset.shippingServiceCode) {
        throw new AppError('VERSION_CONFLICT', '历史草稿的冻结定价证据与上品预设或目标币种不一致', {
          sku: listing.sku,
          sourceCurrency,
          presetCurrency: preset.currency,
          pricingResolutionTargetCurrency: pricingResolution.targetCurrency,
          pricingTemplateId: pricingResolution.pricingTemplateId,
          shippingTemplateId: pricingResolution.shippingTemplateId,
          shippingServiceCode: pricingResolution.shippingServiceCode
        }, 409);
      }
      const resolution = readOzonGrossWeightResolution(listing.data.initialization?.grossWeightResolution);
      if (!resolution) {
        throw new AppError('CONFIG_INVALID', '历史草稿缺少冻结的采购毛重证据', { sku: listing.sku }, 409);
      }
      const purchase = await this.purchases.getPurchase(listing.sku);
      const procurement = purchase.procurementVersions?.find((candidate) => (
        String(candidate.id || '').trim() === resolution.procurementVersionId
      ));
      if (!procurement || procurement.versionNo !== resolution.procurementVersionNo) {
        throw new AppError('VERSION_CONFLICT', '找不到历史草稿冻结的采购版本，不能可信重算 CNY 价格', {
          sku: listing.sku,
          procurementVersionId: resolution.procurementVersionId,
          procurementVersionNo: resolution.procurementVersionNo
        }, 409);
      }
      const prices = await calculateManualListingPricesAtResolution(
        this.pricing,
        preset,
        pricingResolution,
        listing.sku,
        listing.productName,
        procurement,
        resolution.effectiveGrossWeightGrams
      );
      return {
        status: 'RECALCULATED',
        sourceCurrency,
        targetCurrency: 'CNY',
        pendingSave: true,
        offers: listing.data.offers.map((offer) => ({ offerId: offer.offerId, ...prices }))
      };
    } catch (error) {
      return {
        status: 'UNAVAILABLE',
        sourceCurrency,
        targetCurrency: 'CNY',
        pendingSave: false,
        offers: [],
        reason: error instanceof Error ? error.message : '历史草稿 CNY 价格投影失败'
      };
    }
  }

  private async synchronizeManualPurchaseMeasurements(
    sku: string,
    rowVersion: number
  ): Promise<{ listing: OzonListingDraft; projection?: OzonManualPurchaseProjectionResult }> {
    const listing = await this.repository.getListing(sku);
    if (listing.rowVersion !== rowVersion) {
      throw new AppError('TASK_LOCKED', 'OZON 草稿版本已变化，请刷新后重新生成', {
        sku,
        expected: listing.rowVersion,
        actual: rowVersion
      }, 409);
    }
    const categoryKey = String(listing.data.categoryKey || '').trim();
    if (!categoryKey) return { listing };
    const category = await this.repository.getCategory(categoryKey);
    const categoryAttributes = category.publishedVersion?.snapshot.attributes || [];
    if (!categoryUsesOzonManualPurchaseMeasurements(categoryAttributes)) return { listing };
    const purchase = await this.purchases.getPurchase(listing.sku);
    const procurement = purchase.procurementVersions?.[0];
    if (!procurement) {
      throw new AppError('CONFIG_INVALID', '采购管理尚无可用采购版本，无法获取产品尺寸与净重', { sku }, 409);
    }
    const latestSnapshot = createOzonManualPurchaseMeasurements(procurement);
    const snapshot = sameOzonManualPurchaseMeasurementValues(listing.data.purchaseMeasurements, latestSnapshot)
      ? listing.data.purchaseMeasurements!
      : latestSnapshot;
    const projection = projectOzonManualPurchaseMeasurements(
      listing.data.sharedAttributes,
      categoryAttributes,
      snapshot
    );
    if (sameOzonManualPurchaseMeasurementValues(listing.data.purchaseMeasurements, snapshot)
      && sameOzonManualPurchaseAttributes(listing.data.sharedAttributes, projection.attributes)) {
      return { listing, projection };
    }
    const settings = await this.repository.getSettings();
    const synchronized = await this.repository.updateListing(listing.sku, {
      ...listing.data,
      rowVersion: listing.rowVersion,
      purchaseMeasurements: snapshot,
      sharedAttributes: projection.attributes,
      mediaSourceRoot: settings.rootDirectory ? this.productRoot(settings.rootDirectory, listing.sku) : ''
    });
    return { listing: synchronized, projection };
  }

  private async withGenerationLock<T>(skuInput: string, action: () => Promise<T>): Promise<T> {
    const sku = String(skuInput || '').trim();
    const previous = this.generationLocks.get(sku) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.generationLocks.set(sku, tail);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.generationLocks.get(sku) === tail) this.generationLocks.delete(sku);
    }
  }

  private async readGeneratedProductSummary(listing: OzonListingDraft): Promise<OzonListingDetail['generatedProductSummary']> {
    try {
      const settings = await this.repository.getSettings();
      if (!settings.rootDirectory || !/^\d{7}$/.test(listing.sku)) return undefined;
      const productJsonPath = await secureResolve(settings.rootDirectory, `inbox/${listing.sku}/product.json`);
      const info = await lstat(productJsonPath);
      if (!info.isFile() || info.size <= 0 || info.size > 10 * 1024 * 1024) return undefined;
      const parsedJson = JSON.parse(await readFile(productJsonPath, 'utf8')) as unknown;
      const parsed = ozonProductSchema.safeParse(parsedJson);
      if (!parsed.success) return undefined;
      const actualSignature = `sha256:${createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex')}`;
      const readyPath = await secureResolve(settings.rootDirectory, `inbox/${listing.sku}/_READY`);
      const readyInfo = await lstat(readyPath).catch(() => undefined);
      let ready: Record<string, unknown> = {};
      if (readyInfo?.isFile() && !readyInfo.isSymbolicLink()) {
        try {
          ready = JSON.parse(await readFile(readyPath, 'utf8')) as Record<string, unknown>;
        } catch {
          ready = {};
        }
      }
      const readyRevision = Number(ready.revision || 0);
      const readySignature = String(ready.signature || ready.directorySignature || '').trim();
      const revision = parsed.data.revision;
      const isCurrent = revision === listing.revision
        && readyRevision === revision
        && readySignature === actualSignature
        && String(ready.sku || ready.SKU || '').trim() === listing.sku;
      const metadata = {
        revision,
        ...(String(ready.generatedAt || '').trim() ? { generatedAt: String(ready.generatedAt).trim() } : {}),
        isCurrent
      };
      return parsed.data.schemaVersion === 2
        ? { schemaVersion: 2, videoMode: parsed.data.videoPolicy.mode, ...metadata }
        : { schemaVersion: 1, ...metadata };
    } catch {
      return undefined;
    }
  }

  private async verifyMediaCurrent(
    listing: OzonListingDraft,
    rootDirectory: string
  ): Promise<OzonVerifiedMediaMetadata> {
    return verifyOzonMediaAssetsCurrent(listing, this.productRoot(rootDirectory, listing.sku));
  }

  private async assertRootDirectory(valueInput: string, mustExist: boolean): Promise<void> {
    const value = String(valueInput || '').trim();
    if (!value) {
      if (mustExist) throw new AppError('CONFIG_INVALID', '请填写 OZON 自动上品根目录');
      return;
    }
    if (value.includes('\0')) throw new AppError('CONFIG_INVALID', 'OZON 自动上品根目录包含无效字符');
    const flavor = path.win32.isAbsolute(value) ? path.win32 : path.posix.isAbsolute(value) ? path.posix : undefined;
    if (!flavor) throw new AppError('CONFIG_INVALID', 'OZON 自动上品根目录必须是绝对路径', { rootDirectory: value });
    const normalized = flavor.normalize(value);
    if (normalized.toLocaleLowerCase() === flavor.parse(normalized).root.toLocaleLowerCase()) {
      throw new AppError('CONFIG_INVALID', '不能将磁盘或卷根目录用作 OZON 自动上品根目录', { rootDirectory: value });
    }
    if (mustExist) {
      const info = await lstat(normalized).catch(() => undefined);
      if (info && (info.isSymbolicLink() || !info.isDirectory())) {
        throw new AppError('CONFIG_INVALID', 'OZON 自动上品根目录必须是真实目录，不能是文件或符号链接', { rootDirectory: normalized });
      }
    }
  }
}

export function selectOzonListingProductVariants<T extends { name?: string | null }>(variants: T[]): T[] {
  const realVariants = variants.filter((variant) => variant.name?.trim() !== '默认变体');
  return (realVariants.length ? realVariants : variants).slice(0, 99);
}

function parseAutomaticPublishOfferIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new AppError('CONFIG_INVALID', 'OZON 自动任务 publishOfferIds 必须是非空字符串数组', undefined, 409);
  }
  const normalized = value.map((entry) => String(entry || '').trim());
  if (!normalized.length || normalized.some((offerId) => !offerId) || new Set(normalized).size !== normalized.length) {
    throw new AppError('CONFIG_INVALID', 'OZON 自动任务 publishOfferIds 为空、重复或包含无效 Offer ID', { publishOfferIds: value }, 409);
  }
  return normalized;
}

type OzonAutomaticOfferContract = {
  expectedOfferIds: string[];
  submittedOfferIds: string[];
  publishOfferIds: string[];
};

function parseAutomaticOfferContract(metadata: Record<string, unknown>): OzonAutomaticOfferContract | undefined {
  const fields = [
    metadata.offerContractVersion,
    metadata.offerContractHash,
    metadata.expectedOfferIds,
    metadata.submittedOfferIds,
    metadata.publishOfferIds,
    metadata.expectedOfferSnapshots
  ];
  if (fields.every((value) => value === undefined)) return undefined;
  if (fields.some((value) => value === undefined)) {
    throw new AppError('CONFIG_INVALID', 'OZON 自动任务双集合合同字段不完整', undefined, 409);
  }
  if (metadata.offerContractVersion !== 1 || !/^sha256:[a-f0-9]{64}$/.test(String(metadata.offerContractHash || ''))) {
    throw new AppError('CONFIG_INVALID', 'OZON 自动任务双集合合同版本或哈希无效', undefined, 409);
  }
  const expectedOfferIds = parseAutomaticPublishOfferIds(metadata.expectedOfferIds)!;
  const submittedOfferIds = parseAutomaticPublishOfferIds(metadata.submittedOfferIds)!;
  const publishOfferIds = parseAutomaticPublishOfferIds(metadata.publishOfferIds)!;
  if (JSON.stringify(submittedOfferIds) !== JSON.stringify(publishOfferIds)) {
    throw new AppError('CONFIG_INVALID', 'OZON submittedOfferIds 与 publishOfferIds 必须完全一致', undefined, 409);
  }
  const expected = new Set(expectedOfferIds);
  if (submittedOfferIds.some((offerId) => !expected.has(offerId))) {
    throw new AppError('CONFIG_INVALID', 'OZON submittedOfferIds 不是 expectedOfferIds 的子集', undefined, 409);
  }
  if (!Array.isArray(metadata.expectedOfferSnapshots)) {
    throw new AppError('CONFIG_INVALID', 'OZON expectedOfferSnapshots 必须是数组', undefined, 409);
  }
  const snapshots = metadata.expectedOfferSnapshots.map((value) => (
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  ));
  const snapshotIds = snapshots.map((snapshot) => String(snapshot.offerId || '').trim());
  if (snapshotIds.some((offerId) => !offerId)
    || new Set(snapshotIds).size !== snapshotIds.length
    || JSON.stringify(snapshotIds) !== JSON.stringify(expectedOfferIds)) {
    throw new AppError('CONFIG_INVALID', 'OZON expectedOfferSnapshots 与 expectedOfferIds 不一致', undefined, 409);
  }
  const submitted = new Set(submittedOfferIds);
  for (const snapshot of snapshots) {
    const offerId = String(snapshot.offerId);
    const disposition = String(snapshot.disposition || '');
    const expectedDisposition = submitted.has(offerId) ? 'SUBMITTED' : 'PRESERVED_EXISTING';
    if (disposition !== expectedDisposition) {
      throw new AppError('CONFIG_INVALID', `OZON ${offerId} 的 disposition 与提交集合不一致`, undefined, 409);
    }
    const mapping = snapshot.mapping && typeof snapshot.mapping === 'object' && !Array.isArray(snapshot.mapping)
      ? snapshot.mapping as Record<string, unknown>
      : undefined;
    if (disposition === 'PRESERVED_EXISTING'
      && (!/^\d+$/.test(String(mapping?.ozonProductId || '')) || !/^\d+$/.test(String(mapping?.ozonSku || '')))) {
      throw new AppError('CONFIG_INVALID', `OZON ${offerId} 的保留映射无效`, undefined, 409);
    }
  }
  const actualHash = `sha256:${createHash('sha256').update(stableOzonJson({
    offerContractVersion: 1,
    expectedOfferIds,
    submittedOfferIds,
    publishOfferIds,
    expectedOfferSnapshots: metadata.expectedOfferSnapshots
  })).digest('hex')}`;
  if (actualHash !== metadata.offerContractHash) {
    throw new AppError('CONFIG_INVALID', 'OZON 自动任务双集合合同哈希不匹配', undefined, 409);
  }
  return { expectedOfferIds, submittedOfferIds, publishOfferIds };
}

function stableOzonJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableOzonJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableOzonJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function createOzonCompatibleAppendSettingsBinding(
  settings: Pick<
    OzonSystemSettings,
    | 'rowVersion'
    | 'enabled'
    | 'rootDirectory'
    | 'defaultStoreAlias'
    | 'credentialReady'
    | 'taskApiWebhookUrl'
    | 'adminApiWebhookUrl'
  >
): Record<string, unknown> {
  const rootDirectory = String(settings.rootDirectory || '').trim();
  let normalizedRootDirectory = '';
  if (rootDirectory) {
    const flavor = path.win32.isAbsolute(rootDirectory) ? path.win32 : path.posix;
    normalizedRootDirectory = flavor.normalize(rootDirectory);
    while (normalizedRootDirectory.length > flavor.parse(normalizedRootDirectory).root.length
      && normalizedRootDirectory.endsWith(flavor.sep)) {
      normalizedRootDirectory = normalizedRootDirectory.slice(0, -1);
    }
    if (flavor === path.win32) normalizedRootDirectory = normalizedRootDirectory.toLocaleLowerCase('en-US');
  }
  return {
    settingsRowVersion: Number(settings.rowVersion || 0),
    storeAlias: settings.defaultStoreAlias,
    settingsEnabled: Boolean(settings.enabled),
    rootDirectoryFingerprint: normalizedRootDirectory
      ? `sha256:${createHash('sha256').update(normalizedRootDirectory).digest('hex')}`
      : null,
    credentialReady: Boolean(settings.credentialReady),
    taskApiWebhookReady: Boolean(settings.taskApiWebhookUrl),
    adminApiWebhookReady: Boolean(settings.adminApiWebhookUrl)
  };
}

export function createOzonCompatibleAppendProductIdentity(
  productNameInput: string,
  variants: Array<{ variantId: string; name?: string | null }>
): OzonCompatibleAppendProductIdentity {
  const productName = String(productNameInput || '').trim();
  const productVariants = variants
    .filter((variant) => String(variant.name || '').trim() !== '默认变体')
    .map((variant) => ({
      variantId: String(variant.variantId || '').trim(),
      name: String(variant.name || '').trim()
    }));
  return {
    productName,
    productVariants,
    hash: `sha256:${createHash('sha256').update(stableOzonJson({ productName, productVariants })).digest('hex')}`
  };
}

export function scopeOzonListingSubmission(
  listing: OzonListingDraft,
  publishOfferIds?: string[]
): OzonListingDraft {
  if (publishOfferIds === undefined) return listing;
  const normalized = parseAutomaticPublishOfferIds(publishOfferIds)!;
  const requested = new Set(normalized);
  const offers = listing.data.offers.filter((offer) => requested.has(offer.offerId));
  const found = new Set(offers.map((offer) => offer.offerId));
  const missingOfferIds = normalized.filter((offerId) => !found.has(offerId));
  if (missingOfferIds.length || offers.length !== normalized.length) {
    throw new AppError(
      'VERSION_CONFLICT',
      'OZON 自动任务提交作用域与当前父草稿 Offer 集合不一致',
      { sku: listing.sku, publishOfferIds: normalized, missingOfferIds },
      409
    );
  }
  const referencedAssetIds = new Set(offers.flatMap((offer) => offer.media.map((media) => media.assetId)));
  return {
    ...listing,
    data: {
      ...listing.data,
      offers,
      mediaAssets: listing.data.mediaAssets.filter((asset) => referencedAssetIds.has(asset.assetId))
    }
  };
}

function backfillOzonOfferProductIdentity(
  offers: OzonListingDraft['data']['offers'],
  variants: Array<{
    variantId: string;
    name?: string | null;
    wbColor?: { colorKey: string; nameRu: string; nameZh: string };
  }>
): OzonListingDraft['data']['offers'] {
  const byId = new Map(variants.map((variant) => [variant.variantId, variant]));
  const byColor = new Map<string, typeof variants>();
  for (const variant of variants) {
    if (variant.wbColor?.colorKey) {
      byColor.set(variant.wbColor.colorKey, [...(byColor.get(variant.wbColor.colorKey) || []), variant]);
    }
  }
  return offers.map((offer) => {
    if (offer.productVariantId) return offer;
    let variant = byId.get(offer.variantId);
    if (!variant && offer.productVariantColor?.colorKey) {
      const candidates = byColor.get(offer.productVariantColor.colorKey) || [];
      if (candidates.length === 1) variant = candidates[0];
    }
    if (!variant && offers.length === 1 && variants.length === 1) variant = variants[0];
    if (!variant) return offer;
    return {
      ...offer,
      productVariantId: variant.variantId,
      ...(variant.name ? { productVariantName: variant.name } : {}),
      ...(variant.wbColor ? { productVariantColor: variant.wbColor } : {})
    };
  });
}

function validateGeneratedOzonTitle(result: OzonTitleTranslationResult, maxLength: number): string {
  const value = assertOzonTitle(result.contentTranslate);
  const length = Array.from(value).length;
  if (length > maxLength) {
    throw new Error(`OZON 翻译标题必须是 ${maxLength} 字符以内且不含中文的单行文本`);
  }
  return value;
}

function validateGeneratedOzonDescription(input: string): string {
  // The stored E003 source is audit data. Validation must not silently trim or
  // otherwise rewrite it; S001 owns the explicit submission canonicalization.
  const value = String(input ?? '');
  const policy = validateOzonDescription(value);
  if (!policy.valid) throw new Error(`E003 产品详情不符合内容合同: ${policy.issues.join(', ')}`);
  if (Array.from(value).length < 10) {
    throw new Error('E003 产品详情过短');
  }
  return value;
}

function ozonDescriptionSourceFromE003(
  source: NonNullable<E003VariantDescriptionsResult['source']>,
  productVariantId?: string
): NonNullable<OzonListingDraft['data']['descriptionSource']> {
  return {
    type: 'E003',
    workflowCode: 'E003',
    executionId: source.executionId,
    fileName: source.fileName,
    sha256: source.sha256,
    ...(productVariantId ? { productVariantId } : {})
  };
}

function initializationIssue(code: string, error: unknown, field: string): OzonInitializationIssue {
  return {
    code,
    message: error instanceof Error ? error.message : String(error || '自动初始化失败'),
    field,
    retryable: true
  };
}

function legacyListingWriteReadOnly(sku: string): AppError {
  return new AppError(
    'OZON_LEGACY_TASK_READ_ONLY',
    '该 OZON 资料属于全局默认预设时期的冻结历史，不能通过旧的全局兼容入口继续写入',
    { sku, remediation: '请在店铺发布计划中选择目标店铺并使用该店默认预设' },
    409
  );
}

function createOzonPresetSnapshot(
  preset: OzonPreset,
  capturedAt: string
): NonNullable<OzonListingInitialization['presetSnapshot']> {
  return {
    presetId: preset.id,
    presetName: preset.name,
    presetRowVersion: preset.rowVersion,
    capturedAt,
    definition: currentOzonPresetDefinition(preset)
  };
}

function readOzonPresetSnapshot(input: unknown): OzonHistoricalPreset | undefined {
  if (input === undefined || input === null) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('CONFIG_INVALID', 'OZON 上品预设快照无效，请重新新建资料', undefined, 409);
  }
  const snapshot = input as Record<string, unknown>;
  const definition = ozonLegacyPresetInputSchema.safeParse(snapshot.definition);
  const presetId = String(snapshot.presetId || '').trim();
  const presetName = String(snapshot.presetName || '').trim();
  const presetRowVersion = Number(snapshot.presetRowVersion);
  const capturedAt = String(snapshot.capturedAt || '').trim();
  if (!definition.success || !presetId || !presetName || !Number.isInteger(presetRowVersion)
    || presetRowVersion < 1 || !Number.isFinite(Date.parse(capturedAt))) {
    throw new AppError('CONFIG_INVALID', 'OZON 上品预设快照无效，请重新新建资料', {
      issues: definition.success ? undefined : definition.error.issues
    }, 409);
  }
  const parsedDefinition = definition.data;
  return {
    ...currentOzonPresetDefinition(parsedDefinition),
    autoPublishEnabled: parsedDefinition.autoPublishEnabled,
    autoPublishMode: parsedDefinition.autoPublishMode,
    fulfillmentMode: parsedDefinition.fulfillmentMode,
    warehouseId: parsedDefinition.warehouseId,
    currency: parsedDefinition.currency,
    isDefault: parsedDefinition.isDefault,
    id: presetId,
    name: presetName,
    rowVersion: presetRowVersion,
    createdAt: capturedAt,
    updatedAt: capturedAt
  };
}

function currentOzonPresetDefinition(input: unknown): OzonPresetInput {
  const value = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const definition = { ...value };
  for (const key of ['autoPublishEnabled', 'autoPublishMode', 'autoPublishActivatedAt', 'fulfillmentMode', 'warehouseId', 'currency', 'isDefault', 'id', 'rowVersion', 'createdAt', 'updatedAt']) {
    delete definition[key];
  }
  return ozonPresetInputSchema.parse(definition);
}

function readOzonPricingResolution(input: unknown): OzonPricingResolution | undefined {
  if (input === undefined || input === null) return undefined;
  const parsed = ozonPricingResolutionSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError('CONFIG_INVALID', 'OZON 冻结定价版本证据无效', { issues: parsed.error.issues }, 409);
  }
  return parsed.data;
}

function mergeOzonInitializationIssues(
  previous: OzonInitializationIssue[],
  current: OzonInitializationIssue[],
  titleRu: string,
  descriptionRu: string,
  offers: OzonListingDraft['data']['offers']
): OzonInitializationIssue[] {
  const resolvedFields = new Set<string>();
  if (titleRu) resolvedFields.add('titleRu');
  if (descriptionRu) resolvedFields.add('descriptionRu');
  if (offers.length > 0 && offers.every((offer) => Number(offer.price) > 0)) resolvedFields.add('offers.price');
  for (const offer of offers) {
    if (String(offer.descriptionRu || '').trim()) {
      resolvedFields.add(`offers.${offer.productVariantId || offer.variantId}.descriptionRu`);
    }
  }
  const shouldKeep = (issue: OzonInitializationIssue) => (
    issue.code === 'E003_DESCRIPTION_FALLBACK' || !issue.field || !resolvedFields.has(issue.field)
  );
  const unique = new Map<string, OzonInitializationIssue>();
  for (const issue of [...previous.filter(shouldKeep), ...current.filter(shouldKeep)]) {
    unique.set(`${issue.code}\0${issue.field || ''}\0${issue.message}`, issue);
  }
  return [...unique.values()].slice(0, 200);
}

function prepareOzonDescriptionPlan(listing: OzonListingDraft): {
  shared: { value: string; warnings: NonNullable<OzonListingDraft['data']['descriptionWarnings']> };
  offers: Array<{ value: string; warnings: NonNullable<OzonListingDraft['data']['descriptionWarnings']> }>;
} {
  const title = validateOzonTitle(listing.data.titleRu);
  if (!title.valid) throw new AppError('CONFIG_INVALID', 'OZON 俄文标题不符合内容合同', { fieldPath: 'titleRu', issues: title.issues }, 409);
  const validate = (value: string, fieldPath: string) => {
    const source = String(value || '');
    const result = validateOzonDescription(source);
    if (!result.valid || result.length < 10) {
      throw new AppError('CONFIG_INVALID', 'OZON 俄文详情不符合内容合同', {
        fieldPath, length: result.length, issues: result.length < 10 ? [...result.issues, 'TOO_SHORT'] : result.issues
      }, 409);
    }
    // Keep the original source in the draft/product.json. S001 applies the
    // shared submission normalization when it serializes attribute 4191.
    return { value: source, warnings: [] };
  };
  const shared = validate(listing.data.descriptionRu, 'descriptionRu');
  const offers = listing.data.offers.map((offer, index) => validate(
    offer.descriptionRu || shared.value,
    `offers.${index}.descriptionRu`
  ));
  return { shared, offers };
}

function assertOzonPlatformText(value: unknown, fieldPath: string, label: string, attributeId?: number): void {
  const details = { fieldPath, ...(attributeId === undefined ? {} : { attributeId }) };
  const separator = attributeId === undefined ? '' : ' ';
  if (hasOzonCjk(value)) throw new AppError('CONFIG_INVALID', `${label}${separator}包含中文字符，请先修正`, details, 409);
  if (hasOzonInvalidPlatformCharacters(value)) {
    throw new AppError('CONFIG_INVALID', `${label}${separator}包含 Emoji、控制字符或其他非法字符`, details, 409);
  }
}

export function assertOzonPlatformAttributes(attributes: OzonAttributeValueInput[], prefix: string): void {
  attributes.forEach((attribute, index) => {
    if (attribute.attributeId === 4191) return;
    attribute.values.forEach((value, valueIndex) => {
      if (value.dictionaryValueId) return;
      assertOzonPlatformText(
        value.value,
        `${prefix}.${index}.values.${valueIndex}.value`,
        `OZON 属性 #${attribute.attributeId}`,
        attribute.attributeId
      );
    });
  });
}

export async function assertOzonMediaAssetsCurrent(listing: OzonListingDraft, productRoot: string): Promise<void> {
  await verifyOzonMediaAssetsCurrent(listing, productRoot);
}

export type OzonVerifiedMediaMetadata = {
  videoDurationSecondsByAssetId: ReadonlyMap<string, number>;
};

export async function verifyOzonMediaAssetsCurrent(
  listing: OzonListingDraft,
  productRoot: string
): Promise<OzonVerifiedMediaMetadata> {
  if (!listing.data.mediaAssets.length) {
    throw new AppError('VERSION_CONFLICT', 'OZON 共享媒体库尚未扫描，请先扫描 variants 目录', { sku: listing.sku }, 409);
  }
  const assets = new Map(listing.data.mediaAssets.map((asset) => [asset.assetId, asset]));
  const videoDurationSecondsByAssetId = new Map<string, number>();
  const variantsRoot = path.join(productRoot, 'variants');
  const resolvedVariantsRoot = await realpath(variantsRoot).catch(() => '');
  if (!resolvedVariantsRoot) {
    throw new AppError('SOURCE_FOLDER_MISSING', 'OZON variants 媒体目录不存在，请重新扫描', { sku: listing.sku }, 409);
  }
  for (const offer of listing.data.offers) {
    for (const reference of offer.media) {
      const asset = assets.get(reference.assetId);
      if (!asset || asset.validationStatus !== 'VALID' || asset.relativePath !== reference.relativePath || asset.kind !== reference.kind) {
        throw new AppError('VERSION_CONFLICT', 'OZON 媒体分配与共享媒体库不一致，请重新扫描', { sku: listing.sku, offerId: offer.offerId, assetId: reference.assetId }, 409);
      }
      let filePath: string;
      try {
        filePath = await secureResolve(productRoot, asset.relativePath);
      } catch (error) {
        if (error instanceof AppError && error.code === 'SOURCE_FILE_MISSING') {
          throw new AppError(
            'SOURCE_FILE_MISSING',
            'OZON 媒体文件已不在当前 inbox，可能已随历史任务归档；请使用兼容追加或重新扫描',
            { sku: listing.sku, relativePath: asset.relativePath },
            409
          );
        }
        if (error instanceof AppError && ['INVALID_RELATIVE_PATH', 'PATH_TRAVERSAL_BLOCKED'].includes(error.code)) {
          throw new AppError(
            'PATH_TRAVERSAL_BLOCKED',
            'OZON 媒体相对路径不安全，已停止访问',
            { sku: listing.sku, relativePath: asset.relativePath },
            409
          );
        }
        throw error;
      }
      if (!isPathInside(resolvedVariantsRoot, filePath)) {
        throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON 媒体文件真实路径超出当前 SKU 的 variants 目录', { sku: listing.sku, relativePath: asset.relativePath }, 409);
      }
      const info = await lstat(filePath);
      if (!info.isFile() || info.size !== asset.sizeBytes || await hashFile(filePath) !== asset.sha256) {
        throw new AppError('VERSION_CONFLICT', 'OZON 媒体文件在扫描后发生变化，请重新扫描', { sku: listing.sku, relativePath: asset.relativePath }, 409);
      }
      if (asset.kind === 'video' && !videoDurationSecondsByAssetId.has(asset.assetId)) {
        const extension = path.extname(filePath).toLocaleLowerCase('en-US');
        const inspection = extension === '.mp4'
          ? inspectOzonMp4Buffer(await readFile(filePath), info.size)
          : { error: 'OZON 产品视频/封面只支持 MP4' };
        if (inspection.error) {
          throw new AppError('CONFIG_INVALID', inspection.error, {
            sku: listing.sku,
            relativePath: asset.relativePath
          }, 409);
        }
        videoDurationSecondsByAssetId.set(asset.assetId, inspection.durationSeconds!);
      }
    }
  }
  return { videoDurationSecondsByAssetId };
}

export function assertNoUserManagedOzonSystemMediaAttributes(listing: OzonListingDraft): void {
  const invalid = [
    ...listing.data.sharedAttributes.map((attribute) => ({ scope: 'shared', attribute })),
    ...listing.data.offers.flatMap((offer) => offer.attributes.map((attribute) => ({
      scope: `offer:${offer.offerId}`,
      attribute
    })))
  ].filter((entry) => isOzonSystemMediaAttributeId(entry.attribute.attributeId));
  if (!invalid.length) return;
  throw new AppError(
    'CONFIG_INVALID',
    'OZON 产品视频/封面属性由系统自动生成，不能作为普通类目字段提交',
    {
      attributes: invalid.map((entry) => ({
        scope: entry.scope,
        attributeId: entry.attribute.attributeId,
        complexId: entry.attribute.complexId
      }))
    },
    409
  );
}

export function productMediaAssets(
  listing: OzonListingDraft,
  verifiedVideoDurationSecondsByAssetId: ReadonlyMap<string, number>
) {
  const referencedIds = new Set(
    listing.data.offers.flatMap((offer) => offer.media.map((reference) => reference.assetId))
  );
  return listing.data.mediaAssets
    .filter((asset) => referencedIds.has(asset.assetId))
    .map((asset) => ({
      assetId: asset.assetId,
      relativePath: asset.relativePath,
      kind: asset.kind,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
      ...(asset.kind === 'video'
        ? { durationSeconds: verifiedVideoDurationSecondsByAssetId.get(asset.assetId) }
        : {})
    }));
}

export function resolveOzonVideoContract(
  attributes: OzonCategoryAttribute[],
  context?: { categoryKey?: string; categoryVersionId?: string }
): Pick<OzonProductV2, 'mediaCapabilities' | 'videoPolicy'> & { missingIntroductionAttributeIds: number[] } {
  const videoCover = attributes.find((attribute) => attribute.id === 21845 && attribute.complexId === 100002);
  if (!videoCover) {
    throw new AppError(
      'CONFIG_INVALID',
      '当前 OZON 类目快照未返回视频封面属性（complexId=100002, attributeId=21845），已停止提交',
      context,
      409
    );
  }
  const title = attributes.find((attribute) => attribute.id === 21837 && attribute.complexId === 100001);
  const link = attributes.find((attribute) => attribute.id === 21841 && attribute.complexId === 100001);
  const requiredProductsOnVideo = attributes.find(
    (attribute) => attribute.id === 22273 && attribute.complexId === 100001 && attribute.required
  );
  const missingIntroductionAttributeIds = [
    ...(title ? [] : [21837]),
    ...(link ? [] : [21841]),
    ...(requiredProductsOnVideo ? [22273] : [])
  ];
  const productIntroductionVideo = title && link && !requiredProductsOnVideo
    ? {
        complexId: 100001,
        linkAttributeId: link.id,
        titleAttributeId: title.id
      }
    : undefined;
  return {
    mediaCapabilities: {
      videoCover: { complexId: videoCover.complexId, attributeId: videoCover.id },
      ...(productIntroductionVideo ? { productIntroductionVideo } : {})
    },
    videoPolicy: {
      source: 'SAME_MP4',
      titleSource: 'OFFER_TITLE_RU',
      mode: productIntroductionVideo ? 'INTRO_AND_COVER' : 'COVER_ONLY'
    },
    missingIntroductionAttributeIds
  };
}

type OzonInboxRoundPreparationInput = {
  rootDirectory: string;
  productDirectory: string;
  sku: string;
  revision: number;
  signature: string;
  findBoundJob: (revision: number, signature: string) => Promise<OzonPublishJob | undefined>;
  archiveUnbound?: boolean;
};

export async function prepareOzonInboxRound(
  input: OzonInboxRoundPreparationInput
): Promise<{
  archivedPath?: string;
  archivedRound?: { existingRevision: number; existingSignature: string; reason: string };
}> {
  const { rootDirectory, productDirectory, sku, revision, signature } = input;
  const directoryInfo = await lstat(productDirectory).catch(() => undefined);
  if (!directoryInfo) return {};
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON inbox SKU 路径不是安全目录', { productDirectory }, 403);
  }
  const [rootReal, productReal] = await Promise.all([realpath(rootDirectory), realpath(productDirectory)]);
  if (!isPathInside(rootReal, productReal)) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON inbox SKU 真实路径越过任务根目录', { productDirectory }, 403);
  }

  const intakePath = path.join(productDirectory, '.ozon-intake.json');
  const intakeInfo = await lstat(intakePath).catch(() => undefined);
  if (intakeInfo) {
    let intake: Record<string, unknown> = {};
    if (intakeInfo.isFile() && !intakeInfo.isSymbolicLink()) {
      try { intake = JSON.parse(await readFile(intakePath, 'utf8')) as Record<string, unknown>; } catch { /* reported below */ }
    }
    throw new AppError('VERSION_CONFLICT', 'OZON inbox 中仍保留已认领任务，必须先完成目录补偿再创建新一轮', {
      sku,
      revision,
      existingJobId: String(intake.jobId || intake.taskId || ''),
      existingRevision: Number(intake.revision || 0)
    }, 409);
  }

  const productJsonPath = path.join(productDirectory, 'product.json');
  const readyPath = path.join(productDirectory, '_READY');
  const [productInfo, readyInfo] = await Promise.all([
    lstat(productJsonPath).catch(() => undefined),
    lstat(readyPath).catch(() => undefined)
  ]);
  if (!productInfo && !readyInfo) return {};
  if (productInfo && (!productInfo.isFile() || productInfo.isSymbolicLink())) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON inbox 中已有不安全的 product.json', { sku, revision }, 403);
  }
  if (readyInfo && (!readyInfo.isFile() || readyInfo.isSymbolicLink())) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON inbox 中已有不安全的 _READY', { sku, revision }, 403);
  }

  let product: Record<string, unknown> | undefined;
  let productParseFailed = false;
  if (productInfo) {
    try {
      const candidate = JSON.parse(await readFile(productJsonPath, 'utf8')) as unknown;
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        product = candidate as Record<string, unknown>;
      } else {
        productParseFailed = true;
      }
    } catch {
      productParseFailed = true;
    }
  }
  const actualSignature = product
    ? `sha256:${createHash('sha256').update(JSON.stringify(product)).digest('hex')}`
    : '';

  let ready: Record<string, unknown> | undefined;
  let readyParseFailed = false;
  if (readyInfo) {
    try {
      const candidate = JSON.parse(await readFile(readyPath, 'utf8')) as unknown;
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        ready = candidate as Record<string, unknown>;
      } else {
        readyParseFailed = true;
      }
    } catch {
      readyParseFailed = true;
    }
  }

  const existingSku = String(ready?.sku || ready?.SKU || product?.productCode || '').trim();
  const existingRevision = Math.max(0, Math.floor(Number(ready?.revision || product?.revision || 0) || 0));
  const existingSignature = String(ready?.signature || ready?.directorySignature || actualSignature).trim();
  if (existingSku && existingSku !== sku) {
    throw new AppError('VERSION_CONFLICT', 'OZON inbox SKU 目录包含其他商品文件，禁止自动归档或覆盖', {
      sku,
      revision,
      existingSku,
      existingRevision
    }, 409);
  }

  const readyMatchesProduct = Boolean(
    product
    && ready
    && existingSku === sku
    && existingRevision > 0
    && existingSignature
    && existingSignature === actualSignature
  );
  if (readyMatchesProduct && existingRevision === revision && existingSignature === signature) return {};

  const boundJob = await input.findBoundJob(existingRevision, existingSignature);
  if (boundJob) {
    throw new AppError('VERSION_CONFLICT', 'OZON inbox 轮次已绑定上品任务，禁止覆盖 product.json', {
      sku,
      revision,
      existingRevision,
      existingSignature,
      existingJobId: boundJob.id,
      existingJobState: boundJob.state,
      existingJobSource: boundJob.source
    }, 409);
  }
  if (input.archiveUnbound === false) {
    throw new AppError('VERSION_CONFLICT', 'OZON inbox 已存在其他未绑定产物，兼容追加不会自动归档或覆盖', {
      sku,
      revision,
      existingRevision,
      existingSignature
    }, 409);
  }

  const reason = !productInfo
    ? 'PRODUCT_JSON_MISSING'
    : productParseFailed
      ? 'PRODUCT_JSON_INVALID'
      : !readyInfo
        ? 'READY_MISSING'
        : readyParseFailed
          ? 'READY_INVALID'
          : !readyMatchesProduct
            ? 'SIGNATURE_MISMATCH'
            : existingRevision !== revision
              ? 'REVISION_SUPERSEDED'
              : 'SIGNATURE_SUPERSEDED';
  const archivedPath = await archiveUnboundOzonInboxRound({
    rootReal,
    productJsonPath,
    readyPath,
    hasProductJson: Boolean(productInfo),
    hasReady: Boolean(readyInfo),
    metadata: {
      reason,
      sku,
      existingRevision,
      existingSignature,
      replacedByRevision: revision,
      replacedBySignature: signature,
      archivedAt: new Date().toISOString(),
      mediaPreservedAt: path.join(productDirectory, 'variants')
    }
  });
  return {
    archivedPath,
    archivedRound: { existingRevision, existingSignature, reason }
  };
}

export async function removeGeneratedOzonArtifactIfOwned(input: {
  productJsonPath: string;
  readyMarker: string;
  signature: string;
}): Promise<{ productJsonRemoved: boolean; readyMarkerRemoved: boolean }> {
  const productJsonPath = path.resolve(input.productJsonPath);
  const readyMarker = path.resolve(input.readyMarker);
  const signature = String(input.signature || '').trim();
  if (path.dirname(productJsonPath) !== path.dirname(readyMarker)
    || path.basename(productJsonPath) !== 'product.json'
    || path.basename(readyMarker) !== '_READY'
    || !/^sha256:[a-f0-9]{64}$/.test(signature)) {
    return { productJsonRemoved: false, readyMarkerRemoved: false };
  }

  const safeJsonObject = async (filePath: string): Promise<Record<string, unknown> | undefined> => {
    const info = await lstat(filePath).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink()) return undefined;
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined;
    } catch {
      return undefined;
    }
  };

  const [product, ready] = await Promise.all([
    safeJsonObject(productJsonPath),
    safeJsonObject(readyMarker)
  ]);
  const productOwned = Boolean(product
    && `sha256:${createHash('sha256').update(JSON.stringify(product)).digest('hex')}` === signature);
  const readyOwned = Boolean(ready && String(ready.signature || '').trim() === signature);
  let readyMarkerRemoved = false;
  let productJsonRemoved = false;
  if (readyOwned) {
    readyMarkerRemoved = await rm(readyMarker, { force: true }).then(() => true).catch(() => false);
  }
  if (productOwned) {
    productJsonRemoved = await rm(productJsonPath, { force: true }).then(() => true).catch(() => false);
  }
  return { productJsonRemoved, readyMarkerRemoved };
}

async function archiveUnboundOzonInboxRound(input: {
  rootReal: string;
  productJsonPath: string;
  readyPath: string;
  hasProductJson: boolean;
  hasReady: boolean;
  metadata: Record<string, unknown>;
}): Promise<string> {
  const errorsRoot = path.join(input.rootReal, 'errors');
  const staleRoot = path.join(errorsRoot, 'stale-generated');
  const errorsInfo = await lstat(errorsRoot).catch(() => undefined);
  if (!errorsInfo?.isDirectory() || errorsInfo.isSymbolicLink()) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON errors 目录不是安全目录', { errorsRoot }, 403);
  }
  const errorsReal = await realpath(errorsRoot);
  if (!isPathInside(input.rootReal, errorsReal)) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON errors 目录越过任务根目录', { errorsRoot }, 403);
  }
  await mkdir(staleRoot, { recursive: true });
  const staleInfo = await lstat(staleRoot);
  if (!staleInfo.isDirectory() || staleInfo.isSymbolicLink()) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON 过期轮次归档目录不是安全目录', { staleRoot }, 403);
  }
  const staleReal = await realpath(staleRoot);
  if (!isPathInside(input.rootReal, staleReal)) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON 过期轮次归档目录越过任务根目录', { staleRoot }, 403);
  }
  const sku = String(input.metadata.sku || 'unknown').replaceAll(/[^0-9A-Za-z_-]/g, '_');
  const revision = Math.max(0, Math.floor(Number(input.metadata.existingRevision) || 0));
  const timestamp = new Date().toISOString().replaceAll(/[^0-9A-Za-z]/g, '');
  const archiveDirectory = path.join(staleReal, `${sku}__r${revision}__${timestamp}__${randomUUID().slice(0, 8)}`);
  await mkdir(archiveDirectory);

  const archivedProduct = path.join(archiveDirectory, 'product.json');
  const archivedReady = path.join(archiveDirectory, '_READY');
  let productMoved = false;
  let readyMoved = false;
  try {
    if (input.hasProductJson) {
      await rename(input.productJsonPath, archivedProduct);
      productMoved = true;
    }
    if (input.hasReady) {
      await rename(input.readyPath, archivedReady);
      readyMoved = true;
    }
    await writeFileAtomic(
      path.join(archiveDirectory, 'stale-round.json'),
      `${JSON.stringify(input.metadata, null, 2)}\n`,
      { encoding: 'utf8' }
    );
  } catch (error) {
    if (readyMoved) await rename(archivedReady, input.readyPath).catch(() => undefined);
    if (productMoved) await rename(archivedProduct, input.productJsonPath).catch(() => undefined);
    throw error;
  }
  return archiveDirectory;
}

async function calculateManualListingPrices(
  pricing: PricingRepository,
  preset: OzonPreset,
  sku: string,
  productName: string,
  procurement: { purchasePrice: string; courierFee?: string },
  effectiveGrossWeightGrams: number,
  targetCurrency: 'RUB' | 'CNY'
): Promise<ManualOzonPriceCalculation>;
async function calculateManualListingPrices(
  pricing: PricingRepository,
  preset: OzonPreset,
  sku: string,
  productName: string,
  procurement: { purchasePrice: string; courierFee?: string },
  effectiveGrossWeightGrams: number,
  targetCurrency: 'RUB' | 'CNY',
  captureResolution: false
): Promise<{ prices: ManualOzonPrices }>;
async function calculateManualListingPrices(
  pricing: PricingRepository,
  preset: OzonPreset,
  sku: string,
  productName: string,
  procurement: { purchasePrice: string; courierFee?: string },
  effectiveGrossWeightGrams: number,
  targetCurrency: 'RUB' | 'CNY',
  captureResolution = true
): Promise<ManualOzonPriceCalculation | { prices: ManualOzonPrices }> {
  const item = manualOzonPricingItem(preset, sku, productName, procurement, effectiveGrossWeightGrams);
  const result = await pricing.calculate({
    pricingTemplateId: preset.pricingTemplateId,
    shippingTemplateIds: [preset.shippingTemplateId],
    item
  });
  return captureResolution
    ? readManualOzonPriceCalculation(result, preset, targetCurrency, true)
    : readManualOzonPriceCalculation(result, preset, targetCurrency, false);
}

async function calculateManualListingPricesAtResolution(
  pricing: PricingRepository,
  preset: OzonPreset,
  resolution: OzonPricingResolution,
  sku: string,
  productName: string,
  procurement: { purchasePrice: string; courierFee?: string },
  effectiveGrossWeightGrams: number
): Promise<ManualOzonPrices> {
  const item = manualOzonPricingItem(preset, sku, productName, procurement, effectiveGrossWeightGrams);
  const result = await pricing.calculateAtVersions({
    pricingTemplateId: resolution.pricingTemplateId,
    pricingTemplateVersionId: resolution.pricingTemplateVersionId,
    pricingTemplateVersionNo: resolution.pricingTemplateVersionNo,
    shippingTemplateId: resolution.shippingTemplateId,
    shippingTemplateVersionId: resolution.shippingTemplateVersionId,
    shippingTemplateVersionNo: resolution.shippingTemplateVersionNo,
    expectedPlatformCode: 'OZON',
    expectedCurrencyCode: 'CNY',
    shippingServiceCode: resolution.shippingServiceCode,
    expectedOptionId: resolution.optionId,
    item
  });
  const recalculated = readManualOzonPriceCalculation(
    result,
    preset,
    'CNY',
    true,
    resolution.optionId
  );
  const recalculatedResolution = recalculated.pricingResolution;
  const comparableKeys: Array<Exclude<keyof OzonPricingResolution, 'capturedAt' | 'targetCurrency'>> = [
    'pricingTemplateId',
    'pricingTemplateVersionId',
    'pricingTemplateVersionNo',
    'shippingTemplateId',
    'shippingTemplateVersionId',
    'shippingTemplateVersionNo',
    'shippingServiceCode',
    'optionId'
  ];
  const mismatch = comparableKeys.find((key) => recalculatedResolution[key] !== resolution[key]);
  if (mismatch) {
    throw new AppError('VERSION_CONFLICT', '历史草稿重算结果与冻结定价证据不一致', {
      field: mismatch,
      expected: resolution[mismatch],
      actual: recalculatedResolution[mismatch]
    }, 409);
  }
  return recalculated.prices;
}

function manualOzonPricingItem(
  preset: OzonPreset,
  sku: string,
  productName: string,
  procurement: { purchasePrice: string; courierFee?: string },
  effectiveGrossWeightGrams: number
): PricingCalculationItem {
  const dimensions = dimensionsInCentimeters(preset.dimensions);
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

function readManualOzonPriceCalculation(
  result: Awaited<ReturnType<PricingRepository['calculate']>>,
  preset: OzonPreset,
  targetCurrency: 'RUB' | 'CNY',
  captureResolution: true,
  expectedOptionId?: string
): ManualOzonPriceCalculation;
function readManualOzonPriceCalculation(
  result: Awaited<ReturnType<PricingRepository['calculate']>>,
  preset: OzonPreset,
  targetCurrency: 'RUB' | 'CNY',
  captureResolution: false,
  expectedOptionId?: string
): { prices: ManualOzonPrices };
function readManualOzonPriceCalculation(
  result: Awaited<ReturnType<PricingRepository['calculate']>>,
  preset: OzonPreset,
  targetCurrency: 'RUB' | 'CNY',
  captureResolution: boolean,
  expectedOptionId?: string
): ManualOzonPriceCalculation | { prices: ManualOzonPrices } {
  if (String(result.pricingTemplate?.platformCode || '').toUpperCase() !== 'OZON') {
    throw new AppError('CONFIG_INVALID', '默认上品预设引用的定价模板不属于 OZON', { pricingTemplateId: preset.pricingTemplateId }, 409);
  }
  const serviceCode = String(preset.shippingServiceCode || '').trim().toUpperCase();
  const option = result.options.find((candidate) => (
    String(candidate.shipping?.serviceCode || '').trim().toUpperCase() === serviceCode
    && (!expectedOptionId || candidate.optionId === expectedOptionId)
  ));
  if (!option) {
    throw new AppError('CONFIG_INVALID', `所选 OZON 服务渠道 ${serviceCode || '未设置'} 没有符合固定包装参数的上架价`, { shippingServiceCode: serviceCode }, 409);
  }
  const shippingTemplate = objectValue(option.shipping?.template);
  if (shippingTemplate.platformCode && String(shippingTemplate.platformCode).toUpperCase() !== 'OZON') {
    throw new AppError('CONFIG_INVALID', '默认上品预设引用的运费模板不属于 OZON', { shippingTemplateId: preset.shippingTemplateId }, 409);
  }
  const selectCurrency = (amount: any) => [amount?.saleCurrency, amount?.costCurrency]
    .find((entry) => String(entry?.currencyCode || '').toUpperCase() === targetCurrency);
  const listing = selectCurrency(option.amounts?.listing);
  const strike = selectCurrency(option.amounts?.strike);
  const target = selectCurrency(option.amounts?.targetSale);
  if (!listing || !strike || !target) {
    throw new AppError('CONFIG_INVALID', `售价计算结果未包含 OZON 店铺合同币种 ${targetCurrency}`, { currency: targetCurrency }, 409);
  }
  const requiredPrice = (amount: any, label: string) => {
    const value = Number(amount.displayValue ?? amount.value);
    if (!Number.isFinite(value) || value <= 0) throw new AppError('CONFIG_INVALID', `售价计算结果缺少有效的${label}`, undefined, 409);
    return value;
  };
  const prices = {
    price: requiredPrice(listing, '上架价'),
    oldPrice: requiredPrice(strike, '划线价'),
    minPrice: requiredPrice(target, '目标售价')
  };
  if (!captureResolution) return { prices };
  const pricingTemplate = objectValue(result.pricingTemplate);
  const pricingResolution = ozonPricingResolutionSchema.safeParse({
    targetCurrency,
    pricingTemplateId: pricingTemplate.templateId,
    pricingTemplateVersionId: pricingTemplate.versionId,
    pricingTemplateVersionNo: pricingTemplate.versionNo,
    shippingTemplateId: shippingTemplate.templateId,
    shippingTemplateVersionId: shippingTemplate.versionId,
    shippingTemplateVersionNo: shippingTemplate.versionNo,
    shippingServiceCode: serviceCode,
    optionId: option.optionId,
    capturedAt: result.calculatedAt
  });
  if (!pricingResolution.success) {
    throw new AppError('CONFIG_INVALID', '定价服务未返回完整的定价与运费版本证据', {
      issues: pricingResolution.error.issues
    }, 409);
  }
  if (pricingResolution.data.pricingTemplateId !== preset.pricingTemplateId
    || pricingResolution.data.shippingTemplateId !== preset.shippingTemplateId) {
    throw new AppError('VERSION_CONFLICT', '定价服务返回的模板身份与 OZON 上品预设不一致', {
      expectedPricingTemplateId: preset.pricingTemplateId,
      actualPricingTemplateId: pricingResolution.data.pricingTemplateId,
      expectedShippingTemplateId: preset.shippingTemplateId,
      actualShippingTemplateId: pricingResolution.data.shippingTemplateId
    }, 409);
  }
  return { prices, pricingResolution: pricingResolution.data };
}

export function manualListingPlatformAttributes(
  attributes: OzonAttributeValueInput[],
  categoryAttributes: OzonCategoryAttribute[],
  sku: string,
  typeId: number,
  titleRu?: string,
  descriptionRu?: string,
  brandValue?: string
): OzonAttributeValueInput[] {
  return normalizeOzonNoBrandForPlatform(prepareOzonManagedSharedAttributes({
    categoryAttributes,
    attributes,
    sku,
    typeId,
    titleRu,
    descriptionRu,
    brandValue,
    brandMode: 'PRESERVE_OR_DEFAULT'
  }), categoryAttributes);
}

export function manualListingPlatformBrand(brandInput: string, attributes: OzonAttributeValueInput[]): string {
  const brand = String(brandInput || '').trim();
  if (brand === '无品牌' || brand.toLocaleLowerCase('ru-RU') === 'нет бренда') return 'Нет бренда';
  const platformBrand = attributes.find((attribute) => [31, 85].includes(attribute.attributeId) && attribute.complexId === 0);
  if (platformBrand?.values.some((value) => value.dictionaryValueId === 126745801)) return 'Нет бренда';
  return brand;
}

/**
 * Pure Offer-identity projection shared by PRE_PLAN remote absence proof and
 * the real per-store materializer. Keeping this on the exact seed-expansion
 * path prevents a sized preset from introducing unchecked Offer IDs later.
 */
export function deriveOzonStorePresetOfferIds(
  listing: OzonListingDraft,
  presetDefinition: unknown
): string[] {
  const parsedPreset = ozonPresetInputSchema.safeParse(presetDefinition);
  if (!parsedPreset.success) {
    throw new AppError('CONFIG_INVALID', 'OZON 店铺默认预设商品蓝图无效', {
      issues: parsedPreset.error.issues
    }, 409);
  }
  const sourceVariants = ozonSharedMaterialVariants(listing);
  if (!sourceVariants.length) {
    throw new AppError('CONFIG_INVALID', 'OZON 公共素材至少需要一个产品变体', { sku: listing.sku }, 409);
  }
  const seeds = expandOzonStorePresetSeeds(sourceVariants, parsedPreset.data);
  const identityPlan = createOzonCompatibleIdentityPlan({
    sku: listing.sku,
    productVariants: seeds.map((seed) => ({ variantId: seed.variantId, name: seed.productVariantName })),
    existingOffers: [],
    candidateOfferVariantIds: seeds.map((seed) => seed.variantId)
  });
  if (identityPlan.exhaustedVariantIds.length || identityPlan.offerIdentities.length !== seeds.length) {
    throw new AppError('CONFIG_INVALID', 'OZON 颜色与尺码组合无法生成完整且唯一的 Offer 身份', {
      sku: listing.sku
    }, 409);
  }
  return identityPlan.offerIdentities.map((identity) => identity.offerId);
}

export type OzonSharedMaterialVariant = {
  variantId: string;
  productVariantId: string;
  productVariantName: string;
  productVariantColor?: OzonListingDraft['data']['offers'][number]['productVariantColor'];
  descriptionRu?: string;
  descriptionSource?: OzonListingDraft['data']['offers'][number]['descriptionSource'];
  media: OzonListingDraft['data']['offers'][number]['media'];
};

function ozonSharedMaterialVariants(listing: OzonListingDraft): OzonSharedMaterialVariant[] {
  const variants = new Map<string, OzonSharedMaterialVariant>();
  for (const offer of listing.data.offers) {
    const productVariantId = String(offer.productVariantId || offer.variantId || '').trim();
    if (!productVariantId || variants.has(productVariantId)) continue;
    variants.set(productVariantId, {
      variantId: offer.variantId,
      productVariantId,
      productVariantName: String(offer.productVariantName || productVariantId).trim(),
      ...(offer.productVariantColor ? { productVariantColor: { ...offer.productVariantColor } } : {}),
      ...(offer.descriptionRu ? { descriptionRu: offer.descriptionRu } : {}),
      ...(offer.descriptionSource ? { descriptionSource: { ...offer.descriptionSource } } : {}),
      media: offer.media.map((reference, sortOrder) => ({ ...reference, sortOrder }))
    });
  }
  const all = [...variants.values()];
  const realVariants = all.filter((variant) => variant.productVariantName.trim() !== '默认变体');
  return realVariants.length ? realVariants : all;
}

type OzonVariantColorAuthorityVariant = OzonVariantColorAuthority['variants'][number];

export function createOzonVariantColorAuthority(
  input: OzonVariantColorAuthorityVariant[]
): OzonVariantColorAuthority {
  const variants = input.map(normalizeOzonVariantColorAuthorityVariant)
    .sort((left, right) => left.productVariantId.localeCompare(right.productVariantId));
  if (new Set(variants.map((variant) => variant.productVariantId)).size !== variants.length) {
    throw new AppError('VERSION_CONFLICT', 'E001 OZON 颜色权威快照包含重复产品变体', undefined, 409);
  }
  const canonical = { schemaVersion: 1 as const, source: 'E001_REVIEW' as const, variants };
  return {
    ...canonical,
    hash: `sha256:${createHash('sha256').update(stableOzonJson(canonical)).digest('hex')}`
  };
}

export function assertOzonVariantColorAuthority(input: OzonVariantColorAuthority): OzonVariantColorAuthority {
  if (!input || input.schemaVersion !== 1 || input.source !== 'E001_REVIEW' || !Array.isArray(input.variants)) {
    throw new AppError('VERSION_CONFLICT', 'E001 OZON 颜色权威快照合同无效', undefined, 409);
  }
  const normalized = createOzonVariantColorAuthority(input.variants);
  if (normalized.hash !== input.hash) {
    throw new AppError('VERSION_CONFLICT', 'E001 OZON 颜色权威快照哈希已漂移', {
      expected: input.hash,
      actual: normalized.hash
    }, 409);
  }
  return normalized;
}

function normalizeOzonVariantColorAuthorityVariant(
  input: OzonVariantColorAuthorityVariant
): OzonVariantColorAuthorityVariant {
  const productVariantId = String(input?.productVariantId || '').trim();
  const itemKey = String(input?.itemKey || '').trim();
  const dictionaryId = Number(input?.dictionaryId);
  const valueId = Number(input?.valueId);
  const nameRu = String(input?.nameRu || '').trim();
  const source = input?.source;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(productVariantId)
    || !Number.isSafeInteger(dictionaryId) || dictionaryId < 1
    || !Number.isSafeInteger(valueId) || valueId < 1
    || itemKey !== `colors:${dictionaryId}:${valueId}`
    || !nameRu || nameRu.length > 256
    || !['AUTO_EXACT_RU', 'MANUAL_E001', 'MANUAL_OZON'].includes(String(source || ''))) {
    throw new AppError('VERSION_CONFLICT', 'E001 OZON 颜色权威快照中的变体身份无效', {
      productVariantId, itemKey, dictionaryId, valueId, source
    }, 409);
  }
  return { productVariantId, itemKey, dictionaryId, valueId, nameRu, source };
}

export function assertOzonVariantColorCategoryCompatibility(
  attributes: OzonCategoryAttribute[],
  authority: OzonVariantColorAuthority,
  context: { sku: string; categoryKey: string; presetId: string }
): void {
  if (!authority.variants.length) return;
  const productColors = attributes.filter((attribute) => attribute.id === 10096);
  const colorNames = attributes.filter((attribute) => attribute.id === 10097);
  const expectedDictionaryIds = [...new Set(authority.variants.map((variant) => variant.dictionaryId))];
  const productColor = productColors.length === 1 ? productColors[0] : undefined;
  const colorName = colorNames.length === 1 ? colorNames[0] : undefined;
  if (!productColor || !colorName
    || !['Dictionary', 'String'].includes(productColor.type)
    || !expectedDictionaryIds.every((dictionaryId) => dictionaryId === productColor.dictionaryId)
    || colorName.type !== 'String'
    || colorName.dictionaryId !== 0) {
    throw new AppError('OZON_VARIANT_COLOR_INCOMPATIBLE', '目标 OZON 类目不支持 E001 审核确定的商品颜色与颜色名称', {
      ...context,
      expectedDictionaryIds,
      productColorAttributes: productColors,
      colorNameAttributes: colorNames
    }, 409);
  }
}

export function expandOzonStorePresetSeeds(
  variants: OzonSharedMaterialVariant[],
  preset: OzonPresetInput
): Array<OzonSharedMaterialVariant & {
  stock: number;
  sizeAttribute?: OzonAttributeValueInput;
}> {
  const sizeAttributeKey = String(preset.sizeAttributeKey || '').trim();
  const configuredSizes = preset.sizes?.length
    ? preset.sizes
    : [{ sizeId: 'default', value: '', stock: preset.defaultStock }];
  if (!sizeAttributeKey) {
    const stock = Number(configuredSizes[0]?.stock ?? preset.defaultStock ?? 0);
    return variants.map((variant) => ({ ...variant, stock }));
  }
  const [attributeIdText, complexIdText] = sizeAttributeKey.split(':');
  const attributeId = Number(attributeIdText);
  const complexId = Number(complexIdText);
  if (!Number.isInteger(attributeId) || attributeId < 1 || !Number.isInteger(complexId) || complexId < 0) {
    throw new AppError('CONFIG_INVALID', 'OZON 店铺预设的尺码属性无效', { sizeAttributeKey }, 409);
  }
  if (variants.length * configuredSizes.length > 99) {
    throw new AppError('CONFIG_INVALID', 'OZON 颜色与尺码组合最多支持 99 个 Offer', undefined, 409);
  }
  const seen = new Set<string>();
  const sizes = configuredSizes.map((size, index) => {
    const value = String(size.value || '').trim();
    if (!value) throw new AppError('CONFIG_INVALID', `OZON 店铺预设尺码第 ${index + 1} 行为空`, undefined, 409);
    if (seen.has(value)) throw new AppError('CONFIG_INVALID', `OZON 店铺预设尺码重复：${value}`, undefined, 409);
    seen.add(value);
    return {
      identity: String(size.sizeId || value),
      stock: Number(size.stock || 0),
      attribute: {
        attributeId,
        complexId,
        values: value.startsWith('dict:') ? [{ dictionaryValueId: Number(value.slice(5)) }] : [{ value }]
      } satisfies OzonAttributeValueInput
    };
  });
  return variants.flatMap((variant) => sizes.map((size) => ({
    ...variant,
    variantId: deterministicOzonStoreVariantId(variant.productVariantId, size.identity),
    stock: size.stock,
    sizeAttribute: size.attribute
  })));
}

function deterministicOzonStoreVariantId(productVariantId: string, sizeIdentity: string): string {
  const hash = createHash('sha256').update(`${productVariantId}\u0000${sizeIdentity}`).digest('hex').slice(0, 32).split('');
  hash[12] = '5';
  hash[16] = ['8', '9', 'a', 'b'][Number.parseInt(hash[16] || '0', 16) % 4]!;
  const value = hash.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function mergeOzonPresetVariantAttributes(
  attributes: OzonAttributeValueInput[],
  sizeAttribute?: OzonAttributeValueInput
): OzonAttributeValueInput[] {
  const result = cloneOzonAttributes(attributes.filter((attribute) => !isOzonSystemMediaAttributeId(attribute.attributeId)));
  if (!sizeAttribute) return result;
  const index = result.findIndex((attribute) => attribute.attributeId === sizeAttribute.attributeId
    && attribute.complexId === sizeAttribute.complexId);
  if (index >= 0) result[index] = sizeAttribute;
  else result.push(sizeAttribute);
  return result;
}

function cloneOzonAttributes(attributes: OzonAttributeValueInput[]): OzonAttributeValueInput[] {
  return attributes.map((attribute) => ({ ...attribute, values: attribute.values.map((value) => ({ ...value })) }));
}

function publicOzonSystemSettings(settings: OzonSystemSettings): OzonPublicSystemSettings {
  const publicSettings = { ...settings } as Record<string, unknown>;
  for (const key of ['defaultStoreAlias', 'credentialReady', 'sellerId', 'sellerName', 'accountCurrency', 'lastPreflightAt', 'lastPreflightStatus', 'lastPreflightMessage']) {
    delete publicSettings[key];
  }
  return publicSettings as OzonPublicSystemSettings;
}

export function applyOzonVariantColorDefaults(
  attributes: OzonAttributeValueInput[],
  categoryAttributes: OzonCategoryAttribute[],
  color?: Pick<OzonColorIdentity, 'valueId' | 'nameRu'>
): OzonAttributeValueInput[] {
  const result = cloneOzonAttributes(attributes.filter((attribute) => ![10096, 10097].includes(attribute.attributeId)));
  if (!color) return result;
  const replace = (attributeId: number, values: OzonAttributeValueInput['values']) => {
    const categoryAttribute = categoryAttributes.find((attribute) => attribute.id === attributeId);
    if (!categoryAttribute) return;
    const index = result.findIndex((attribute) => attribute.attributeId === attributeId && attribute.complexId === categoryAttribute.complexId);
    const next = { attributeId, complexId: categoryAttribute.complexId, values };
    if (index >= 0) result[index] = next;
    else result.push(next);
  };
  replace(10096, [{ dictionaryValueId: color.valueId }]);
  replace(10097, [{ value: color.nameRu }]);
  return result;
}

export function withoutOzonSystemMediaAttributes(attributes: OzonAttributeValueInput[]): OzonAttributeValueInput[] {
  return cloneOzonAttributes(attributes.filter((attribute) => !isOzonSystemMediaAttributeId(attribute.attributeId)));
}

function dimensionsInCentimeters(dimensions: OzonPreset['dimensions']): { length: number; width: number; height: number } {
  const multiplier = dimensions.dimensionUnit === 'mm' ? 0.1 : dimensions.dimensionUnit === 'in' ? 2.54 : 1;
  return { length: dimensions.length * multiplier, width: dimensions.width * multiplier, height: dimensions.height * multiplier };
}

export async function scanOzonMediaDirectory(
  productRoot: string,
  variantsRoot: string,
  options: { createIfMissing?: boolean } = {}
): Promise<OzonMediaAsset[]> {
  if (options.createIfMissing === false) {
    const info = await lstat(variantsRoot).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      throw new AppError('SOURCE_FOLDER_MISSING', 'OZON variants 媒体目录不存在或不可安全读取', undefined, 409);
    }
  } else {
    await mkdir(variantsRoot, { recursive: true });
  }
  const resolvedRoot = await realpath(variantsRoot);
  const manifest = await readOzonVariantMediaManifest(path.join(variantsRoot, 'variant-media-manifest.json'));
  const orderErrors = latestManifestImageOrderErrors(manifest);
  if (orderErrors.length) {
    throw new AppError(
      'MEDIA_MANIFEST_INVALID',
      `OZON 媒体清单的最新 E005 图片批次顺序无效：${orderErrors.map((error) => error.message).join('；')}`,
      { errors: orderErrors },
      409
    );
  }
  const manifestByPath = new Map(manifest.map((entry) => [normalizedRelativePath(String(entry.relativePath || '')), entry]));
  const files: string[] = [];
  await walkMediaDirectory(variantsRoot, files);
  const collisions = new Map<string, string>();
  const assets: OzonMediaAsset[] = [];
  for (const filePath of files.sort((left, right) => left.localeCompare(right, 'en'))) {
    const resolved = await realpath(filePath);
    if (!isPathInside(resolvedRoot, resolved)) throw new AppError('PATH_TRAVERSAL_BLOCKED', '媒体文件真实路径超出 OZON variants 目录', { filePath });
    const relativePath = toApiRelativePath(path.relative(productRoot, filePath));
    const collisionKey = relativePath.normalize('NFC').toLocaleLowerCase('en-US');
    if (collisions.has(collisionKey)) {
      throw new AppError('CONFIG_INVALID', 'OZON 媒体目录存在 Unicode 或大小写冲突文件', { paths: [collisions.get(collisionKey), relativePath] });
    }
    collisions.set(collisionKey, relativePath);
    const extension = path.extname(filePath).toLocaleLowerCase('en-US');
    if (!['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov'].includes(extension)) continue;
    const inspected = await inspectOzonMedia(filePath, relativePath, extension);
    const described = manifestByPath.get(normalizedRelativePath(relativePath));
    if (described && described.sha256 === inspected.sha256 && described.kind === inspected.kind) {
      if (typeof described.sortOrder === 'number' && Number.isInteger(described.sortOrder) && described.sortOrder >= 0) {
        inspected.sortOrder = Number(described.sortOrder);
      }
      const variantColor = objectValue(described.variantColor);
      const colorKey = String(variantColor.colorKey || '');
      const nameRu = String(variantColor.nameRu || '').trim();
      const nameZh = String(variantColor.nameZh || '').trim();
      inspected.productVariantId = isUuid(described.variantId) ? String(described.variantId) : undefined;
      inspected.productVariantName = stringValue(described.variantName);
      if (/^[a-f0-9]{64}$/.test(colorKey) && nameRu && nameZh) inspected.productVariantColor = { colorKey, nameRu, nameZh };
      inspected.sourceStageId = described.sourceStageId === 'E004' || described.sourceStageId === 'E005' ? described.sourceStageId : undefined;
      inspected.sourceSubmissionId = stringValue(described.submissionId);
      inspected.deliveredAt = isIsoDate(described.deliveredAt) ? String(described.deliveredAt) : undefined;
    }
    assets.push(inspected);
  }
  return assets;
}

async function readOzonVariantMediaManifest(filePath: string): Promise<Array<Record<string, any>>> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as { schemaVersion?: unknown; assets?: unknown };
    if (![1, 2].includes(Number(parsed.schemaVersion)) || !Array.isArray(parsed.assets)) return [];
    return parsed.assets.filter((entry): entry is Record<string, any> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry));
  } catch {
    return [];
  }
}

async function walkMediaDirectory(directory: string, files: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON variants 目录中不允许存在符号链接', { path: target });
    if (entry.isDirectory()) await walkMediaDirectory(target, files);
    else if (entry.isFile()) files.push(target);
  }
}

async function inspectOzonMedia(filePath: string, relativePath: string, extension: string): Promise<OzonMediaAsset> {
  const before = await lstat(filePath);
  const kind: 'image' | 'video' = ['.mp4', '.mov'].includes(extension) ? 'video' : 'image';
  const maxBytes = kind === 'video' ? OZON_MP4_MAX_BYTES : 10 * 1024 * 1024;
  let validationError = before.size === 0
    ? '文件为空'
    : before.size > maxBytes
      ? `${kind === 'video' ? '视频' : '图片'}超过 ${maxBytes / 1024 / 1024}MB`
      : extension === '.mov'
        ? 'OZON 产品视频/封面只支持 MP4'
        : undefined;
  const handle = await open(filePath, 'r');
  const header = Buffer.alloc(16);
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  const mimeType = detectOzonMime(header, extension);
  if (!mimeType) validationError ||= '文件签名与扩展名不匹配';
  let durationSeconds: number | undefined;
  if (kind === 'video' && extension === '.mp4' && mimeType && before.size <= OZON_MP4_MAX_BYTES) {
    const inspection = inspectOzonMp4Buffer(await readFile(filePath), before.size);
    durationSeconds = inspection.durationSeconds;
    validationError ||= inspection.error;
  }
  if (kind === 'image' && mimeType) {
    try {
      const metadata = await sharp(await readFile(filePath)).metadata();
      if (!metadata.width || !metadata.height) validationError ||= '无法读取图片尺寸';
    } catch {
      validationError ||= '图片文件无法解码';
    }
  }
  const sha256 = await hashFile(filePath);
  const after = await lstat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) validationError ||= '文件仍在复制或写入';
  const assetId = createHash('sha256').update(`${normalizedRelativePath(relativePath)}\0${sha256}`).digest('hex');
  return {
    assetId,
    relativePath: normalizedRelativePath(relativePath),
    kind,
    mimeType: mimeType || 'application/octet-stream',
    sizeBytes: after.size,
    sha256,
    modifiedAt: after.mtime.toISOString(),
    validationStatus: validationError ? 'INVALID' : 'VALID',
    ...(validationError ? { validationError } : {}),
    ...(durationSeconds ? { durationSeconds } : {})
  };
}

export const OZON_MP4_MIN_DURATION_SECONDS = 8;
export const OZON_MP4_MAX_DURATION_SECONDS = 30;
export const OZON_MP4_MAX_BYTES = 20 * 1024 * 1024;

export function inspectOzonMp4Buffer(
  buffer: Buffer,
  sizeBytes = buffer.length
): { durationSeconds?: number; error?: string } {
  if (sizeBytes <= 0 || buffer.length < 12) return { error: 'MP4 文件为空或不完整' };
  if (sizeBytes > OZON_MP4_MAX_BYTES) return { error: '视频超过 20MB' };
  if (buffer.subarray(4, 8).toString('ascii') !== 'ftyp') return { error: 'MP4 文件签名无效' };
  const durationSeconds = parseOzonMp4DurationSeconds(buffer);
  if (durationSeconds === undefined) return { error: '无法读取 MP4 时长' };
  if (durationSeconds < OZON_MP4_MIN_DURATION_SECONDS || durationSeconds > OZON_MP4_MAX_DURATION_SECONDS) {
    return {
      durationSeconds,
      error: `MP4 时长必须为 ${OZON_MP4_MIN_DURATION_SECONDS}–${OZON_MP4_MAX_DURATION_SECONDS} 秒`
    };
  }
  return { durationSeconds };
}

export function parseOzonMp4DurationSeconds(buffer: Buffer): number | undefined {
  const moov = findIsoBmffBox(buffer, 0, buffer.length, 'moov');
  if (!moov) return undefined;
  const mvhd = findIsoBmffBox(buffer, moov.contentStart, moov.end, 'mvhd');
  if (!mvhd) return undefined;
  const payload = mvhd.contentStart;
  if (payload + 4 > mvhd.end) return undefined;
  const version = buffer[payload];
  if (version === 0) {
    if (payload + 20 > mvhd.end) return undefined;
    const timescale = buffer.readUInt32BE(payload + 12);
    const duration = buffer.readUInt32BE(payload + 16);
    if (!timescale || duration === 0xffffffff) return undefined;
    const seconds = duration / timescale;
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  }
  if (version === 1) {
    if (payload + 32 > mvhd.end) return undefined;
    const timescale = buffer.readUInt32BE(payload + 20);
    const duration = buffer.readBigUInt64BE(payload + 24);
    if (!timescale || duration === 0xffffffffffffffffn) return undefined;
    const seconds = Number(duration) / timescale;
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  }
  return undefined;
}

type IsoBmffBox = { contentStart: number; end: number };

function findIsoBmffBox(
  buffer: Buffer,
  start: number,
  limit: number,
  expectedType: string
): IsoBmffBox | undefined {
  let offset = start;
  while (offset + 8 <= limit) {
    const size32 = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    let headerSize = 8;
    let end: number;
    if (size32 === 1) {
      if (offset + 16 > limit) return undefined;
      const size64 = buffer.readBigUInt64BE(offset + 8);
      if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
      headerSize = 16;
      end = offset + Number(size64);
    } else if (size32 === 0) {
      end = limit;
    } else {
      end = offset + size32;
    }
    if (end < offset + headerSize || end > limit) return undefined;
    if (type === expectedType) return { contentStart: offset + headerSize, end };
    offset = end;
  }
  return undefined;
}

function detectOzonMime(header: Buffer, extension: string): string | undefined {
  if ((extension === '.jpg' || extension === '.jpeg') && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg';
  if (extension === '.png' && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (extension === '.webp' && header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if ((extension === '.mp4' || extension === '.mov') && header.subarray(4, 8).toString('ascii') === 'ftyp') return extension === '.mov' ? 'video/quicktime' : 'video/mp4';
  return undefined;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function normalizedRelativePath(value: string): string {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function hasOzonMediaScanChanged(
  listing: OzonListingDraft,
  mediaAssets: OzonMediaAsset[],
  offers: OzonListingDraft['data']['offers'],
  mediaSourceRoot: string
): boolean {
  const snapshot = (
    assets: OzonMediaAsset[],
    comparedOffers: OzonListingDraft['data']['offers'],
    sourceRoot: string
  ) => stableOzonMediaScanJson({
    mediaAssets: assets
      .map((asset) => {
        const contentIdentity: Record<string, unknown> = { ...asset };
        delete contentIdentity.modifiedAt;
        return {
          ...contentIdentity,
          assetId: asset.assetId,
          relativePath: normalizedRelativePath(asset.relativePath).normalize('NFC')
        };
      })
      .sort((left, right) => (
        left.relativePath.localeCompare(right.relativePath, 'en')
        || left.assetId.localeCompare(right.assetId, 'en')
      )),
    offerMedia: comparedOffers.map((offer) => ({
      variantId: offer.variantId,
      media: offer.media.map((reference) => ({
        ...reference,
        relativePath: normalizedRelativePath(reference.relativePath).normalize('NFC')
      }))
    })),
    mediaSourceRoot: normalizePortablePath(sourceRoot).normalize('NFC')
  });
  const emptyScan = mediaAssets.length === 0
    && offers.every((offer) => offer.media.length === 0);
  const emptyStoredMedia = listing.data.mediaAssets.length === 0
    && listing.data.offers.every((offer) => offer.media.length === 0);
  const currentSourceRoot = emptyScan && emptyStoredMedia && !listing.data.mediaSourceRoot.trim()
    ? mediaSourceRoot
    : listing.data.mediaSourceRoot;
  return snapshot(listing.data.mediaAssets, listing.data.offers, currentSourceRoot)
    !== snapshot(mediaAssets, offers, mediaSourceRoot);
}

function stableOzonMediaScanJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableOzonMediaScanJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableOzonMediaScanJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function isUuid(value: unknown): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function isIsoDate(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function normalizePortablePath(value: string): string {
  return String(value || '').replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase('en-US');
}

function portableRelativePath(...segments: string[]): string {
  const normalized = segments.join('/').replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+/g, '/').replace(/\/$/, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)
    || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON 任务目录必须是平台无关的安全相对路径', { path: normalized }, 403);
  }
  return normalized;
}

function scopedLifecyclePath(prefix: string, ...segments: string[]): string {
  return prefix ? portableRelativePath(prefix, ...segments) : portableRelativePath(...segments);
}

function archiveDirectoryScope(job: OzonPublishJob): {
  prefix: string;
  inboxPrefix: string;
  lifecycleFolder: string;
  storeScoped: boolean;
} {
  const payload = objectValue(job.payload);
  const authoritativePath = tryPortableRelativePath(job.workRelPath);
  const schemaV3Publication = Number(payload.schemaVersion) >= 3
    && String(payload.mode || '') === 'MULTISTORE_PUBLICATION'
    && Boolean(job.publicationId);
  if (!schemaV3Publication) {
    if (authoritativePath?.startsWith('stores/')) {
      throw new AppError('VERSION_CONFLICT', 'OZON 店铺目录缺少 schema-v3 publication 冻结身份', {
        workRelPath: authoritativePath
      }, 409);
    }
    const revision = Number(job.revision || payload.revision || 0);
    const lifecycleFolder = normalizeLifecycleTaskFolder(
      job.taskFolder || `${job.sku}__r${revision}`,
      job.sku,
      revision
    );
    return { prefix: '', inboxPrefix: '', lifecycleFolder, storeScoped: false };
  }
  const alias = ozonStoreAliasSchema.safeParse(job.storeAlias);
  const revision = Number(job.revision || payload.revision || 0);
  const expectedTaskId = `${alias.success ? alias.data : ''}__${job.sku}__r${revision}`;
  if (!alias.success || !job.storeId || !job.taskId || !authoritativePath
    || !Number.isSafeInteger(revision) || revision < 1 || job.taskId !== expectedTaskId) {
    throw new AppError('VERSION_CONFLICT', 'OZON 多店铺成功归档缺少冻结任务身份', {
      jobId: job.id,
      publicationId: job.publicationId
    }, 409);
  }
  const inboxPrefix = portableRelativePath('stores', alias.data);
  const expectedInbox = portableRelativePath(inboxPrefix, 'inbox', job.sku);
  const expectedProcessing = portableRelativePath('processing', job.taskId);
  const successSegments = authoritativePath.split('/');
  const validSuccess = successSegments.length === 3
    && successSegments[0] === 'success'
    && /^\d{4}-\d{2}-\d{2}$/.test(successSegments[1] || '')
    && successSegments[2] === job.taskId;
  const validForStage = job.directoryStage === 'INBOX'
    ? authoritativePath === expectedInbox
    : job.directoryStage === 'PROCESSING'
      ? authoritativePath === expectedProcessing
      : job.directoryStage === 'SUCCESS' && validSuccess;
  if (!validForStage) {
    throw new AppError('VERSION_CONFLICT', 'OZON 多店铺任务目录越过冻结店铺范围', {
      storeAlias: alias.data,
      expectedInbox,
      expectedProcessing,
      actual: authoritativePath
    }, 409);
  }
  return { prefix: '', inboxPrefix, lifecycleFolder: job.taskId, storeScoped: true };
}

function tryPortableRelativePath(value: unknown): string | undefined {
  try {
    const text = String(value || '').trim();
    return text ? portableRelativePath(text) : undefined;
  } catch {
    return undefined;
  }
}

function claimedDirectoryMetadata(
  response: Record<string, any>,
  fallback: {
    taskFolder: string;
    workRelPath: string;
    directoryStage: OzonTaskDirectoryStage;
    directorySignature: string;
  }
): {
  taskFolder: string;
  workRelPath: string;
  directoryStage: OzonTaskDirectoryStage;
  directorySignature: string;
} {
  const taskFolder = String(response.taskFolder || fallback.taskFolder).trim();
  if (taskFolder !== fallback.taskFolder) {
    throw new AppError('VERSION_CONFLICT', 'n8n 返回的 OZON 任务文件夹与本轮 revision 不一致', {
      expected: fallback.taskFolder,
      actual: taskFolder
    }, 409);
  }
  const workRelPath = portableRelativePath(String(response.workRelPath || fallback.workRelPath));
  const stageRaw = String(response.directoryStage || fallback.directoryStage).trim().toUpperCase();
  const directoryStage = (stageRaw === 'INBOX' || stageRaw === 'PROCESSING' || stageRaw === 'SUCCESS')
    ? stageRaw as OzonTaskDirectoryStage
    : undefined;
  if (!directoryStage) throw new AppError('CONFIG_INVALID', 'n8n 返回的 OZON 目录阶段无效', { directoryStage: stageRaw }, 409);
  const directorySignature = String(response.signature || response.directorySignature || fallback.directorySignature).trim();
  if (!directorySignature || directorySignature !== fallback.directorySignature) {
    throw new AppError('VERSION_CONFLICT', 'n8n 返回的 OZON 任务签名与本轮 product.json 不一致', {
      expected: fallback.directorySignature,
      actual: directorySignature
    }, 409);
  }
  return { taskFolder, workRelPath, directoryStage, directorySignature };
}

function withRuntimePaths(job: OzonPublishJob, rootDirectory: string, canonicalizePath: (value: string) => string = (value) => value): OzonPublishJob {
  if (!rootDirectory) return job;
  const root = path.resolve(canonicalizePath(rootDirectory));
  const persistedPayload = objectValue(job.payload);
  const persistedRelativePath = tryPortableRelativePath(job.workRelPath || persistedPayload.workRelPath);
  const inferredLegacyPath = persistedRelativePath ? undefined : inferLegacyWorkRelPath(root, persistedPayload.productJsonPath, canonicalizePath);
  const declaredProductJsonPath = String(persistedPayload.productJsonPath || '').trim();
  if (!persistedRelativePath && isAbsoluteAnyPlatform(declaredProductJsonPath) && !inferredLegacyPath) {
    throw new AppError('VERSION_CONFLICT', '历史 OZON 任务的绝对 productJsonPath 不属于当前或受支持的旧数据根，已停止恢复', {
      jobId: job.id,
      sku: job.sku
    }, 409);
  }
  const relPath = persistedRelativePath || inferredLegacyPath || portableRelativePath('inbox', job.sku);
  const workDirectory = path.join(root, ...relPath.split('/'));
  return {
    ...job,
    workRelPath: relPath,
    payload: {
      ...persistedPayload,
      workRelPath: relPath,
      workDirectory,
      productJsonPath: path.join(workDirectory, 'product.json')
    }
  };
}

function legacyRuntimePathProjection(
  job: OzonPublishJob,
  rootDirectory: string,
  canonicalizePath: (value: string) => string
): OzonPublishJob | undefined {
  const payload = objectValue(job.payload);
  if (tryPortableRelativePath(job.workRelPath || payload.workRelPath)) return undefined;
  return withRuntimePaths(job, rootDirectory, canonicalizePath);
}

function isAbsoluteAnyPlatform(value: string): boolean {
  return path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

function inferLegacyWorkRelPath(root: string, productJsonPath: unknown, canonicalizePath: (value: string) => string = (value) => value): string | undefined {
  const absolute = canonicalizePath(String(productJsonPath || '').trim());
  if (!absolute || !path.isAbsolute(absolute)) return undefined;
  const directory = path.dirname(path.resolve(absolute));
  const relative = path.relative(root, directory);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return tryPortableRelativePath(relative);
}

function normalizeLifecycleTaskFolder(value: unknown, sku: string, revision: number): string {
  const expected = `${sku}__r${revision}`;
  const normalized = String(value || '').trim();
  if (normalized !== expected) {
    throw new AppError('VERSION_CONFLICT', 'OZON 任务文件夹与 SKU/revision 不一致', {
      expected,
      actual: normalized
    }, 409);
  }
  return normalized;
}

function resolveLifecyclePath(rootReal: string, relativePath: string): string {
  const normalized = portableRelativePath(relativePath);
  const target = path.resolve(rootReal, ...normalized.split('/'));
  if (!isPathInside(rootReal, target)) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON 任务目录越过配置根目录', { relativePath }, 403);
  }
  return target;
}

async function resolveExistingLifecycleDirectory(rootReal: string, relativePath: string): Promise<string> {
  const target = resolveLifecyclePath(rootReal, relativePath);
  const info = await lstat(target).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new AppError('VERSION_CONFLICT', 'OZON 任务目录不存在或不是安全目录', { relativePath }, 409);
  }
  const resolved = await realpath(target);
  if (!isPathInside(rootReal, resolved)) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON 任务目录真实路径越过配置根目录', { relativePath }, 403);
  }
  return resolved;
}

async function readAndValidateTaskMarker(
  directory: string,
  expected: { jobId: string; sku: string; revision: number; signature: string },
  integrityMode: OzonProductJsonIntegrityMode
): Promise<{ signature: string; integrityMode: OzonProductJsonIntegrityMode }> {
  const markerPath = path.join(directory, '.ozon-intake.json');
  const markerInfo = await lstat(markerPath).catch(() => undefined);
  if (!markerInfo?.isFile() || markerInfo.isSymbolicLink()) {
    throw new AppError('VERSION_CONFLICT', 'OZON 任务目录缺少安全的 .ozon-intake.json', { directory }, 409);
  }
  let marker: Record<string, unknown>;
  try {
    marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new AppError('VERSION_CONFLICT', 'OZON 任务目录标记无法解析', { directory }, 409);
  }
  const legacySignature = String(marker.signature || marker.directorySignature || '').trim();
  const productContentHash = String(marker.productContentHash || marker.product_content_hash || '').trim();
  const markerContractValid = integrityMode === 'RAW_BYTES'
    ? Boolean(productContentHash) && !legacySignature
    : Boolean(legacySignature) && !productContentHash;
  if (!markerContractValid) {
    throw new AppError('VERSION_CONFLICT', 'OZON 任务目录标记的签名字段与冻结任务模式不一致', {
      expected,
      actual: {
        hasLegacySignature: Boolean(legacySignature),
        hasProductContentHash: Boolean(productContentHash),
        integrityMode
      }
    }, 409);
  }
  const signature = integrityMode === 'RAW_BYTES' ? productContentHash : legacySignature;
  const actual = {
    jobId: String(marker.jobId || marker.taskId || '').trim(),
    sku: String(marker.sku || marker.SKU || '').trim(),
    revision: Number(marker.revision || 0),
    signature
  };
  if (actual.jobId !== expected.jobId || actual.sku !== expected.sku || actual.revision !== expected.revision
    || !actual.signature || (expected.signature && actual.signature !== expected.signature)) {
    throw new AppError('VERSION_CONFLICT', 'OZON 任务目录标记与数据库任务不一致', { expected, actual }, 409);
  }
  return {
    signature,
    integrityMode
  };
}

async function readAndValidateReadyMarker(
  directory: string,
  expected: { jobId: string; sku: string; revision: number; signature: string }
): Promise<void> {
  const readyPath = path.join(directory, '_READY');
  const readyInfo = await lstat(readyPath).catch(() => undefined);
  if (!readyInfo?.isFile() || readyInfo.isSymbolicLink()) {
    throw new AppError('VERSION_CONFLICT', 'OZON 任务目录缺少安全的 _READY', { directory }, 409);
  }
  let ready: Record<string, unknown>;
  try {
    ready = JSON.parse(await readFile(readyPath, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new AppError('VERSION_CONFLICT', 'OZON 任务目录 _READY 无法解析', { directory }, 409);
  }
  const actual = {
    jobId: String(ready.jobId || ready.taskId || expected.jobId).trim(),
    sku: String(ready.sku || ready.SKU || '').trim(),
    revision: Number(ready.revision || 0),
    signature: String(ready.signature || ready.directorySignature || '').trim()
  };
  if (actual.jobId !== expected.jobId || actual.sku !== expected.sku
    || actual.revision !== expected.revision || actual.signature !== expected.signature) {
    throw new AppError('VERSION_CONFLICT', 'OZON 任务目录 _READY 与数据库任务不一致', {
      expected,
      actual
    }, 409);
  }
}

async function restoreOzonVariantsForEditing(input: {
  rootReal: string;
  source: string;
  target: string;
  jobId: string;
  sku: string;
  revision: number;
  signature: string;
}): Promise<{ mode: 'HARDLINK' | 'COPY' | 'MIXED'; assetCount: number; restoredAt: string; created: boolean }> {
  const existing = await lstat(input.target).catch(() => undefined);
  const markerName = '.ozon-return-to-edit.json';
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new AppError('VERSION_CONFLICT', 'OZON inbox 恢复目标不是安全目录', { target: input.target }, 409);
    }
    const markerPath = path.join(input.target, markerName);
    const markerInfo = await lstat(markerPath).catch(() => undefined);
    if (!markerInfo?.isFile() || markerInfo.isSymbolicLink()) {
      throw new AppError('VERSION_CONFLICT', 'OZON inbox 已存在且不是同一恢复任务，拒绝覆盖', { target: input.target }, 409);
    }
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
    if (String(marker.jobId) !== input.jobId || String(marker.sku) !== input.sku
      || Number(marker.revision) !== input.revision || String(marker.signature) !== input.signature) {
      throw new AppError('VERSION_CONFLICT', 'OZON inbox 恢复标记与当前任务不一致', { target: input.target }, 409);
    }
    return {
      mode: String(marker.mode) === 'COPY' ? 'COPY' : String(marker.mode) === 'MIXED' ? 'MIXED' : 'HARDLINK',
      assetCount: Number(marker.assetCount || 0),
      restoredAt: String(marker.restoredAt || ''),
      created: false
    };
  }
  const sourceVariants = path.join(input.source, 'variants');
  const sourceInfo = await lstat(sourceVariants).catch(() => undefined);
  if (!sourceInfo?.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new AppError('VERSION_CONFLICT', '失败任务缺少可恢复的 variants 目录', { source: sourceVariants }, 409);
  }
  const sourceReal = await realpath(sourceVariants);
  if (!isPathInside(input.source, sourceReal)) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', '失败任务 variants 目录超出任务边界', { source: sourceVariants }, 403);
  }
  const inboxParent = resolveLifecyclePath(input.rootReal, 'inbox');
  await mkdir(inboxParent, { recursive: true });
  const staging = path.join(inboxParent, `.return-to-edit-${input.sku}-${randomUUID()}`);
  let hardlinks = 0;
  let copies = 0;
  let assetCount = 0;
  const copyTree = async (sourceDirectory: string, targetDirectory: string): Promise<void> => {
    await mkdir(targetDirectory, { recursive: true });
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new AppError('PATH_TRAVERSAL_BLOCKED', 'variants 目录包含符号链接，拒绝恢复', { name: entry.name }, 403);
      const sourcePath = path.join(sourceDirectory, entry.name);
      const targetPath = path.join(targetDirectory, entry.name);
      if (entry.isDirectory()) {
        await copyTree(sourcePath, targetPath);
      } else if (entry.isFile()) {
        assetCount += 1;
        try {
          await link(sourcePath, targetPath);
          hardlinks += 1;
        } catch (error: any) {
          if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(String(error?.code || ''))) throw error;
          await copyFile(sourcePath, targetPath);
          copies += 1;
        }
      } else {
        throw new AppError('VERSION_CONFLICT', 'variants 目录包含不支持的文件类型', { name: entry.name }, 409);
      }
    }
  };
  try {
    await copyTree(sourceReal, path.join(staging, 'variants'));
    if (!assetCount) throw new AppError('VERSION_CONFLICT', '失败任务 variants 目录为空，无法返回编辑', undefined, 409);
    const mode = copies && hardlinks ? 'MIXED' : copies ? 'COPY' : 'HARDLINK';
    const restoredAt = new Date().toISOString();
    await writeFileAtomic(path.join(staging, markerName), `${JSON.stringify({
      jobId: input.jobId,
      sku: input.sku,
      revision: input.revision,
      signature: input.signature,
      mode,
      assetCount,
      restoredAt
    }, null, 2)}\n`, { encoding: 'utf8' });
    await rename(staging, input.target);
    return { mode, assetCount, restoredAt, created: true };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function ensureLegacyInboxTaskMarker(
  directory: string,
  expected: { jobId: string; sku: string; revision: number; signature: string }
): Promise<{ signature: string; integrityMode: OzonProductJsonIntegrityMode }> {
  const intakePath = path.join(directory, '.ozon-intake.json');
  const intakeInfo = await lstat(intakePath).catch(() => undefined);
  if (intakeInfo) return readAndValidateTaskMarker(directory, expected, 'CANONICAL_JSON');

  const readyPath = path.join(directory, '_READY');
  const readyInfo = await lstat(readyPath).catch(() => undefined);
  if (!readyInfo?.isFile() || readyInfo.isSymbolicLink()) {
    throw new AppError('VERSION_CONFLICT', 'OZON inbox 任务目录缺少安全的 _READY', { directory }, 409);
  }
  let ready: Record<string, unknown>;
  try {
    ready = JSON.parse(await readFile(readyPath, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new AppError('VERSION_CONFLICT', 'OZON inbox _READY 无法解析', { directory }, 409);
  }
  const actual = {
    sku: String(ready.sku || ready.SKU || '').trim(),
    revision: Number(ready.revision || 0),
    signature: String(ready.signature || ready.directorySignature || '').trim()
  };
  if (actual.sku !== expected.sku || actual.revision !== expected.revision
    || !actual.signature || actual.signature !== expected.signature) {
    throw new AppError('VERSION_CONFLICT', 'OZON inbox _READY 与数据库任务不一致', { expected, actual }, 409);
  }
  await validateProductJsonSignature(directory, actual.signature, 'CANONICAL_JSON');
  await writeFileAtomic(intakePath, `${JSON.stringify({
    jobId: expected.jobId,
    sku: expected.sku,
    revision: expected.revision,
    signature: actual.signature,
    claimedFrom: 'LEGACY_INBOX',
    claimedAt: new Date().toISOString()
  })}\n`, { encoding: 'utf8' });
  return readAndValidateTaskMarker(directory, expected, 'CANONICAL_JSON');
}

async function findSucceededTaskDirectories(
  rootReal: string,
  taskFolder: string,
  scopePrefix = ''
): Promise<Array<{ absolutePath: string; relativePath: string }>> {
  const successRootRelPath = scopedLifecyclePath(scopePrefix, 'success');
  const successRoot = resolveLifecyclePath(rootReal, successRootRelPath);
  const successInfo = await lstat(successRoot).catch(() => undefined);
  if (!successInfo?.isDirectory() || successInfo.isSymbolicLink()) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON success 根目录不存在或不是安全目录', { successRoot }, 403);
  }
  const successReal = await realpath(successRoot);
  if (!isPathInside(rootReal, successReal)) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON success 根目录真实路径越过任务根目录', { successRoot }, 403);
  }
  const dates = await readdir(successRoot, { withFileTypes: true }).catch(() => []);
  const matches: Array<{ absolutePath: string; relativePath: string }> = [];
  for (const date of dates.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).sort((a, b) => b.name.localeCompare(a.name))) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.name)) continue;
    const relativePath = scopedLifecyclePath(scopePrefix, 'success', date.name, taskFolder);
    const absolutePath = resolveLifecyclePath(rootReal, relativePath);
    const info = await lstat(absolutePath).catch(() => undefined);
    if (info?.isDirectory() && !info.isSymbolicLink()) matches.push({ absolutePath, relativePath });
  }
  return matches;
}

async function resolveSafeExistingLifecycleParent(rootReal: string, relativePath: string): Promise<string> {
  const normalized = portableRelativePath(relativePath);
  let current = rootReal;
  for (const segment of normalized.split('/')) {
    current = path.join(current, segment);
    const info = await lstat(current).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON 生命周期父目录不存在或不是安全目录', {
        relativePath: normalized,
        unsafeSegment: segment
      }, 403);
    }
    const resolved = await realpath(current);
    if (!isPathInside(rootReal, resolved)
      || normalizedTaskPath(resolved) !== normalizedTaskPath(current)) {
      throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON 生命周期父目录真实路径越过冻结目录链', {
        relativePath: normalized,
        unsafeSegment: segment
      }, 403);
    }
  }
  return current;
}

async function ensureSafeSuccessParent(rootReal: string, dateDirectory: string, scopePrefix = ''): Promise<void> {
  const successRoot = resolveLifecyclePath(rootReal, scopedLifecyclePath(scopePrefix, 'success'));
  const successInfo = await lstat(successRoot).catch(() => undefined);
  if (!successInfo?.isDirectory() || successInfo.isSymbolicLink()) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON success 根目录不存在或不是安全目录', { successRoot }, 403);
  }
  const successReal = await realpath(successRoot);
  if (!isPathInside(rootReal, successReal)) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON success 根目录真实路径越过任务根目录', { successRoot }, 403);
  }
  const before = await lstat(dateDirectory).catch(() => undefined);
  if (before && (!before.isDirectory() || before.isSymbolicLink())) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON 成功日期目录不是安全目录', { dateDirectory }, 403);
  }
  if (!before) await mkdir(dateDirectory, { recursive: true });
  const after = await lstat(dateDirectory);
  if (!after.isDirectory() || after.isSymbolicLink()) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON 成功日期目录不是安全目录', { dateDirectory }, 403);
  }
  const dateReal = await realpath(dateDirectory);
  if (!isPathInside(successReal, dateReal)) {
    throw new AppError('PATH_TRAVERSAL_BLOCKED', 'OZON 成功日期目录真实路径越过 success 根目录', { dateDirectory }, 403);
  }
}

type OzonProductJsonIntegrityMode = 'RAW_BYTES' | 'CANONICAL_JSON';

function productJsonIntegrityModeForJob(job: OzonPublishJob): OzonProductJsonIntegrityMode {
  const payload = objectValue(job.payload);
  if (Number(payload.schemaVersion) >= 3
    && String(payload.mode || '') === 'MULTISTORE_PUBLICATION'
    && job.publicationId) {
    const scope = archiveDirectoryScope(job);
    if (!scope.storeScoped) {
      throw new AppError('VERSION_CONFLICT', 'OZON schema-v3 publication 缺少店铺字节签名范围', {
        jobId: job.id,
        publicationId: job.publicationId
      }, 409);
    }
    return 'RAW_BYTES';
  }
  return 'CANONICAL_JSON';
}

async function validateProductJsonSignature(
  directory: string,
  expectedSignature: string,
  integrityMode: OzonProductJsonIntegrityMode
): Promise<unknown> {
  const productJsonPath = path.join(directory, 'product.json');
  const info = await lstat(productJsonPath).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new AppError('VERSION_CONFLICT', 'OZON 任务目录缺少安全的 product.json', { directory }, 409);
  }
  const rawProduct = await readFile(productJsonPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawProduct.toString('utf8'));
  } catch {
    throw new AppError('VERSION_CONFLICT', 'OZON 任务 product.json 无法解析', { directory }, 409);
  }
  const signatureInput = integrityMode === 'RAW_BYTES'
    ? rawProduct
    : JSON.stringify(parsed);
  const actualSignature = `sha256:${createHash('sha256').update(signatureInput).digest('hex')}`;
  if (actualSignature !== expectedSignature) {
    throw new AppError('VERSION_CONFLICT', 'OZON 任务 product.json 签名已变化', {
      directory,
      expectedSignature,
      actualSignature,
      integrityMode
    }, 409);
  }
  return parsed;
}

function shanghaiDate(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function assertSucceededReplay(job: OzonPublishJob, input: OzonRuntimeUpdateInput): void {
  if (input.state !== 'SUCCEEDED') {
    throw new AppError('TASK_LOCKED', 'OZON 任务已经成功，不能再变更为其他状态', { jobId: job.id, state: input.state }, 409);
  }
  const storeAlias = String(input.storeAlias || input.jobPayload?.storeAlias || job.storeAlias).trim();
  const revision = Math.max(0, Number(input.revision || input.jobPayload?.revision || input.lastAppliedRevision || job.revision || 0));
  const signature = String(input.directorySignature || input.jobPayload?.directorySignature || input.jobPayload?.signature || job.directorySignature || '').trim();
  const replayLinks = runtimeMappingLinks(input);
  const currentLinks = [...job.ozonProductLinks].sort((a, b) => a.offerId.localeCompare(b.offerId));
  const mappingIdentity = (links: OzonProductLink[]) => links.map((link) => ({
    offerId: link.offerId,
    ozonProductId: link.ozonProductId,
    ozonSku: link.ozonSku
  }));
  if (storeAlias !== job.storeAlias || revision !== Number(job.revision || 0)
    || (signature && signature !== String(job.directorySignature || ''))
    || JSON.stringify(mappingIdentity(replayLinks)) !== JSON.stringify(mappingIdentity(currentLinks))) {
    throw new AppError('TASK_LOCKED', 'OZON 成功任务的重复回写内容与已保存快照不一致', {
      jobId: job.id,
      storeAlias,
      revision,
      offerIds: replayLinks.map((link) => link.offerId)
    }, 409);
  }
}

function assertCompleteRuntimeMappings(job: OzonPublishJob, input: OzonRuntimeUpdateInput): void {
  const storeAlias = String(input.storeAlias || input.jobPayload?.storeAlias || job.storeAlias).trim();
  if (!storeAlias || storeAlias !== job.storeAlias) {
    throw new AppError('VERSION_CONFLICT', 'OZON 成功回写的店铺标识与任务绑定不一致', {
      expected: job.storeAlias,
      actual: storeAlias
    }, 409);
  }
  const links = runtimeMappingLinks(input);
  const mappedOfferIds = new Set(links.map((link) => link.offerId));
  const expectedOfferIds = job.offerIds.length
    ? job.offerIds
    : Array.isArray(input.offerIds) ? input.offerIds : [];
  const missingOfferIds = expectedOfferIds.filter((offerId) => !mappedOfferIds.has(offerId));
  const unexpectedOfferIds = [...mappedOfferIds].filter((offerId) => !expectedOfferIds.includes(offerId));
  if (!expectedOfferIds.length || missingOfferIds.length || unexpectedOfferIds.length) {
    throw new AppError('CONFIG_INVALID', 'OZON 成功状态必须同时回写全部变体的商品映射', {
      jobId: job.id,
      expectedOfferIds,
      missingOfferIds,
      unexpectedOfferIds
    }, 409);
  }
}

function runtimeMappingLinks(input: OzonRuntimeUpdateInput): OzonProductLink[] {
  const raw = [
    ...(Array.isArray(input.productMappings) ? input.productMappings : []),
    ...(input.offerId && input.ozonProductId ? [{
      offerId: input.offerId,
      ozonProductId: input.ozonProductId,
      ozonSku: input.ozonSku
    }] : [])
  ];
  const links = new Map<string, OzonProductLink>();
  const productOwners = new Map<string, string>();
  const skuOwners = new Map<string, string>();
  for (const entry of raw) {
    const offerId = String(entry.offerId || '').trim();
    const ozonProductId = String(entry.ozonProductId || '').trim();
    const ozonSku = String(entry.ozonSku || '').trim();
    const url = ozonProductUrl(ozonSku);
    if (!offerId || !/^\d+$/.test(ozonProductId) || !url) continue;
    const previous = links.get(offerId);
    if (previous && (previous.ozonProductId !== ozonProductId || previous.ozonSku !== ozonSku)) {
      throw new AppError('CONFIG_INVALID', '同一 OZON offerId 返回了冲突的平台映射', { offerId }, 409);
    }
    const productOwner = productOwners.get(ozonProductId);
    if (productOwner && productOwner !== offerId) {
      throw new AppError('CONFIG_INVALID', '不同 OZON Offer 不能共享同一 ozonProductId', {
        ozonProductId,
        offerIds: [productOwner, offerId]
      }, 409);
    }
    const skuOwner = skuOwners.get(ozonSku);
    if (skuOwner && skuOwner !== offerId) {
      throw new AppError('CONFIG_INVALID', '不同 OZON Offer 不能共享同一 ozonSku', {
        ozonSku,
        offerIds: [skuOwner, offerId]
      }, 409);
    }
    productOwners.set(ozonProductId, offerId);
    skuOwners.set(ozonSku, offerId);
    links.set(offerId, { offerId, ozonProductId, ozonSku, url });
  }
  return [...links.values()].sort((a, b) => a.offerId.localeCompare(b.offerId));
}

function isActiveRuntimeState(state: OzonRuntimeUpdateInput['state']): boolean {
  return ['READY', 'SUBMITTING', 'UPLOADING_MEDIA', 'IMPORTING', 'MODERATING'].includes(String(state || ''));
}

function ozonManagementDisabledError(): AppError {
  return new AppError(
    'OZON_MANAGEMENT_DISABLED',
    'OZON 上品管理已关闭；请先在“OZON上品配置”中启用 OZON 上品管理',
    undefined,
    409
  );
}

function assertLocalAutomaticDispatchJob(job: OzonPublishJob, sku: string): void {
  const localState = job.source === 'AUTO' && ['WAITING_MEDIA', 'READY'].includes(job.state);
  if (job.sku === sku && localState && !ozonJobHasRemoteProgress(job)) return;
  throw new AppError('TASK_LOCKED', 'OZON 自动上品任务已被更新、取消或进入远程阶段，本轮本地生成已停止', {
    jobId: job.id,
    sku,
    actualSku: job.sku,
    source: job.source,
    state: job.state,
    directoryStage: job.directoryStage
  }, 409);
}

export function assertSameAutomaticSettings(
  current: OzonSystemSettings,
  frozen: OzonSystemSettings,
  sku: string,
  requireLegacyCredentialReady = true
): void {
  if (current.rowVersion === frozen.rowVersion
    && current.enabled === true
    && (!requireLegacyCredentialReady || current.credentialReady === true)
    && current.defaultStoreAlias === frozen.defaultStoreAlias
    && current.rootDirectory === frozen.rootDirectory
    && current.taskApiWebhookUrl === frozen.taskApiWebhookUrl) return;
  throw new AppError('TASK_LOCKED', 'OZON 自动任务绑定的系统配置、店铺或工作目录已变化，已在生成和调度前停止', {
    sku,
    expectedSettingsRowVersion: frozen.rowVersion,
    actualSettingsRowVersion: current.rowVersion
  }, 409);
}

function assertFrozenAutomaticOfferContract(
  job: OzonPublishJob,
  metadata: Record<string, unknown>,
  metadataContract: OzonAutomaticOfferContract | undefined,
  expectedListingRowVersion: number
): void {
  const frozenContract = parseAutomaticOfferContract(objectValue(job.payload));
  if (Boolean(metadataContract) !== Boolean(frozenContract)
    || (metadataContract && frozenContract
      && (stableOzonJson(metadataContract) !== stableOzonJson(frozenContract)
        || String(job.payload?.offerContractHash || '') !== String(metadata.offerContractHash || '')
        || stableOzonJson(job.payload?.expectedOfferSnapshots) !== stableOzonJson(metadata.expectedOfferSnapshots)
        || stableOzonJson(job.offerIds) !== stableOzonJson(frozenContract.expectedOfferIds)
        || job.payload?.autoPreparedByJobId !== job.id
        || Number(job.payload?.autoPreparedListingRowVersion) !== expectedListingRowVersion
        || Number(job.payload?.autoPreparedListingRevision) < 1
        || !String(job.payload?.autoPreparedListingDataSignature || '').trim()))) {
    throw new AppError('TASK_LOCKED', 'OZON 自动任务的本地生成所有权或 Offer 合同已变化，已在生成文件前停止', {
      jobId: job.id,
      sku: job.sku
    }, 409);
  }
}

function assertOzonRecoveryHoldReleased(job: OzonPublishJob): void {
  if (objectValue(job.payload?.recoveryHold).active !== true) return;
  throw new AppError('TASK_LOCKED', 'OZON 自动任务处于恢复隔离状态，解除恢复保护前不能处理运行时回调或重新检测', {
    jobId: job.id,
    reasonCode: 'OZON_AUTOMATIC_RECOVERY_HOLD_ACTIVE'
  }, 409);
}

const OZON_PRICE_STOCK_MAX_ATTEMPTS = 12;
const OZON_PRICE_STOCK_RETRY_WINDOW_MS = 30 * 60 * 1_000;
const OZON_TRANSIENT_WRITE_CODES = new Set([
  'PRODUCT_IS_NOT_CREATED',
  'PRODUCT_HAS_NOT_BEEN_TAGGED_YET',
  'NOT_PASS_MODERATION',
  'TOO_MANY_REQUESTS',
  'OZON_RESPONSE_MISSING',
  'OZON_REQUEST_TIMEOUT',
  'OZON_RATE_LIMITED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED'
]);

export function ozonJobRecovery(job: OzonPublishJob): OzonJobRecovery {
  const payload = objectValue(job.payload);
  const errorText = `${job.lastErrorCode || ''} ${job.lastErrorMessage || ''}`;
  const structuredErrors = structuredWriteFailureCodes(payload);
  const errorCodes = structuredErrors.present
    ? structuredErrors.codes
    : legacyWriteFailureCodes(job, errorText);
  const recoverableState = ['FAILED', 'NEEDS_ATTENTION'].includes(job.state);
  const platformFieldError = recoverableState
    && /DESCRIPTION_DECLINE|attribute(?:_id)?["':\s]*4191|字段|属性|недопустимые символы|иероглиф/i.test(errorText);
  const retryable = recoverableState
    && Boolean(job.importTaskId)
    && errorCodes.length > 0
    && errorCodes.every((code) => OZON_TRANSIENT_WRITE_CODES.has(code));
  const action = retryable ? 'RECHECK' : platformFieldError ? 'RETURN_TO_EDIT' : 'NONE';
  const resumeState = action === 'RECHECK' ? remoteResumeState(job) : undefined;
  const progress = objectValue(payload.priceStockWriteProgress);
  const price = objectValue(progress.pricesWrite);
  const stock = objectValue(progress.stocksWrite);
  const statusFor = (bucket: Record<string, unknown>, offerId: string): 'SUCCEEDED' | 'PENDING' | 'FAILED' | 'UNKNOWN' => {
    if (stringArray(bucket.succeededOfferIds).includes(offerId)) return 'SUCCEEDED';
    if (stringArray(bucket.pendingOfferIds).includes(offerId)) return 'PENDING';
    if (stringArray(bucket.failedOfferIds).includes(offerId)) return 'FAILED';
    return 'UNKNOWN';
  };
  const errorsByOffer = (bucket: Record<string, unknown>, offerId: string, operation: 'pricesWrite' | 'stocksWrite') => {
    const raw = objectValue(bucket.errorsByOffer)[offerId];
    const values = Array.isArray(raw) ? raw : [];
    return values.map((value) => objectValue(value)).map((value) => ({
      operation,
      code: String(value.code || 'OZON_WRITE_FAILED'),
      message: String(value.message || 'OZON 写入失败')
    }));
  };
  return {
    action,
    retryable,
    reason: retryable
      ? 'OZON 已受理商品，但价格或库存仍在平台内部同步；继续处理会复用原导入任务。'
      : platformFieldError
        ? 'OZON 返回商品字段错误，需要返回草稿修正后重新生成。'
        : recoverableState
          ? '该错误不能安全自动重试，请查看具体错误后处理。'
          : '任务正在处理或已经结束，无需执行恢复操作。',
    ...(resumeState ? { resumeState } : {}),
    attempt: Math.max(0, Number(payload.priceStockConsistencyRetry || 0)),
    maxAttempts: OZON_PRICE_STOCK_MAX_ATTEMPTS,
    ...(typeof payload.priceStockRetryStartedAt === 'string' ? { startedAt: payload.priceStockRetryStartedAt } : {}),
    ...(typeof payload.priceStockRetryDeadlineAt === 'string' ? { deadlineAt: payload.priceStockRetryDeadlineAt } : {}),
    ...(job.nextAttemptAt ? { nextAttemptAt: job.nextAttemptAt } : {}),
    offers: stringArray(job.offerIds ?? payload.offerIds).map((offerId) => ({
      offerId,
      priceStatus: statusFor(price, offerId),
      stockStatus: statusFor(stock, offerId),
      ...([...errorsByOffer(price, offerId, 'pricesWrite'), ...errorsByOffer(stock, offerId, 'stocksWrite')].length
        ? { errors: [...errorsByOffer(price, offerId, 'pricesWrite'), ...errorsByOffer(stock, offerId, 'stocksWrite')] }
        : {})
    }))
  };
}

function remoteResumeState(job: OzonPublishJob): 'IMPORTING' | 'MODERATING' | undefined {
  if (!job.importTaskId) return undefined;
  const payload = objectValue(job.payload);
  const price = String(job.stageStates.price || '');
  const stock = String(job.stageStates.stock || '');
  const errorText = `${job.lastErrorCode || ''} ${job.lastErrorMessage || ''}`.toUpperCase();
  const structuredErrors = structuredWriteFailureCodes(payload);
  const hasWriteRecovery = structuredErrors.present
    ? structuredErrors.codes.length > 0 && structuredErrors.codes.every((code) => OZON_TRANSIENT_WRITE_CODES.has(code))
    : [...OZON_TRANSIENT_WRITE_CODES].some((code) => errorText.includes(code));
  if (hasWriteRecovery || ['FAILED', 'PENDING', 'PENDING_RETRY'].includes(price) || ['FAILED', 'PENDING', 'PENDING_RETRY'].includes(stock)) {
    return 'IMPORTING';
  }
  return 'MODERATING';
}

function structuredWriteFailureCodes(payload: Record<string, any>): { present: boolean; codes: string[] } {
  const progress = objectValue(payload.priceStockWriteProgress);
  const failureEntries = Array.isArray(payload.priceStockWriteFailures)
    ? payload.priceStockWriteFailures.map((entry) => objectValue(entry))
    : [];
  const codes: string[] = [];
  let present = false;
  for (const operation of ['pricesWrite', 'stocksWrite']) {
    const bucket = objectValue(progress[operation]);
    const relevantOfferIds = [...new Set([
      ...stringArray(bucket.failedOfferIds),
      ...stringArray(bucket.pendingOfferIds)
    ])];
    const errorsByOffer = objectValue(bucket.errorsByOffer);
    for (const offerId of relevantOfferIds) {
      present = true;
      const structured = collectWriteErrorCodes(errorsByOffer[offerId]);
      const fallback = failureEntries.filter((entry) => (
        String(entry.operation || '').trim() === operation
        && String(entry.offerId || entry.offer_id || '').trim() === offerId
      )).flatMap((entry) => collectWriteErrorCodes(entry));
      const offerCodes = [...structured, ...fallback];
      codes.push(...(offerCodes.length ? offerCodes : ['OZON_WRITE_ERROR_UNCLASSIFIED']));
    }
  }
  if (!present && failureEntries.length) {
    present = true;
    const failureCodes = failureEntries.flatMap((entry) => collectWriteErrorCodes(entry));
    codes.push(...(failureCodes.length ? failureCodes : ['OZON_WRITE_ERROR_UNCLASSIFIED']));
  }
  return { present, codes: [...new Set(codes)] };
}

function legacyWriteFailureCodes(job: OzonPublishJob, errorText: string): string[] {
  const parsedCodes: string[] = [];
  try {
    parsedCodes.push(...collectWriteErrorCodes(JSON.parse(String(job.lastErrorMessage || ''))));
  } catch {
    // Historical rows may contain plain text instead of structured JSON.
  }
  if (parsedCodes.length) return [...new Set(parsedCodes)];
  const normalized = errorText.toUpperCase();
  return [...OZON_TRANSIENT_WRITE_CODES].filter((code) => normalized.includes(code));
}

function collectWriteErrorCodes(value: unknown): string[] {
  const output: string[] = [];
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (!entry || typeof entry !== 'object') return;
    const source = entry as Record<string, unknown>;
    if (typeof source.code === 'string' && source.code.trim()) output.push(source.code.trim().toUpperCase());
    Object.values(source).forEach(visit);
  };
  visit(value);
  return output;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry || '').trim()).filter(Boolean) : [];
}

function retryableFailedWriteProgress(job: OzonPublishJob): Record<string, unknown> | undefined {
  const payload = objectValue(job.payload);
  const progress = objectValue(payload.priceStockWriteProgress);
  let changed = false;
  const normalized: Record<string, unknown> = { ...progress };
  for (const operation of ['pricesWrite', 'stocksWrite']) {
    const bucket = objectValue(progress[operation]);
    if (!Object.keys(bucket).length) continue;
    const succeeded = new Set(stringArray(bucket.succeededOfferIds));
    const pending = new Set(stringArray(bucket.pendingOfferIds).filter((offerId) => !succeeded.has(offerId)));
    const failed = stringArray(bucket.failedOfferIds).filter((offerId) => !succeeded.has(offerId));
    const errorsByOffer = objectValue(bucket.errorsByOffer);
    const retainedFailed: string[] = [];
    const normalizedErrors: Record<string, unknown> = { ...errorsByOffer };
    for (const offerId of failed) {
      const rawErrors = Array.isArray(errorsByOffer[offerId]) ? errorsByOffer[offerId] : [];
      const errors = rawErrors.map((entry) => objectValue(entry));
      const codes = errors.map((entry) => String(entry.code || '').trim().toUpperCase()).filter(Boolean);
      if (codes.length > 0 && codes.every((code) => OZON_TRANSIENT_WRITE_CODES.has(code))) {
        pending.add(offerId);
        normalizedErrors[offerId] = errors.map((entry) => ({ ...entry, retryable: true }));
        changed = true;
      } else {
        retainedFailed.push(offerId);
      }
    }
    normalized[operation] = {
      ...bucket,
      succeededOfferIds: [...succeeded],
      pendingOfferIds: [...pending],
      failedOfferIds: retainedFailed,
      errorsByOffer: normalizedErrors
    };
  }
  return changed ? normalized : undefined;
}

function activeJobSummary(job: OzonPublishJob): OzonActiveJobSummary {
  const recoveryAction = ozonJobRecovery(job).action;
  return {
    id: job.id,
    taskKind: job.taskKind,
    source: job.source,
    state: job.state,
    taskId: job.taskId,
    importTaskId: job.importTaskId,
    ozonProductId: job.ozonProductId,
    nextAttemptAt: job.nextAttemptAt,
    ...(job.payload?.networkRecovery ? { networkRecovery: job.payload.networkRecovery } : {}),
    ...(recoveryAction !== 'NONE' ? { recoveryAction } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

type NormalizedOzonPlatformStatusRefresh = {
  readAt: string;
  businessState: OzonPlatformBusinessState;
  offers: OzonPlatformOfferStatus[];
  warnings: string[];
  stageStates: Record<string, string>;
};

export function normalizeOzonKnownRecoveryRemoteAbsence(
  offerIdsInput: string[],
  response: Record<string, unknown>
): OzonKnownPrePlatformFailureRecoveryChecks['remoteState'] {
  const offerIds = [...new Set(offerIdsInput.map((offerId) => String(offerId || '').trim()).filter(Boolean))];
  if (!offerIds.length) {
    throw new AppError('OZON_REMOTE_STATE_UNPROVEN', '恢复任务没有可供 OZON 只读核验的 Offer ID', undefined, 409);
  }
  const expected = new Set(offerIds);
  if (response.ok !== true || response.httpStatus !== 200 || !isRecordValue(response.result)) {
    throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON 商品状态响应不是成功的 productStatus v2 结果', undefined, 409);
  }
  const payload = response.result;
  if (payload.contractVersion !== 2) {
    throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON 商品状态响应缺少 productStatus v2 合同版本', {
      contractVersion: payload.contractVersion
    }, 409);
  }
  const requestedOfferIds = strictKnownRecoveryRequestedOfferIds(payload.requestedOfferIds);
  if (!sameStringSet(requestedOfferIds, offerIds)) {
    throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON 商品状态响应的 requestedOfferIds 与本次请求不一致', {
      expectedOfferIds: offerIds,
      requestedOfferIds
    }, 409);
  }
  const infoItems = strictKnownRecoveryObjectArray(payload.infoItems, 'infoItems');
  const attributeItems = strictKnownRecoveryObjectArray(payload.attributeItems, 'attributeItems');
  const rawReadAt = typeof payload.readAt === 'string' ? payload.readAt.trim() : '';
  if (!rawReadAt || !Number.isFinite(Date.parse(rawReadAt))) {
    throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON 商品状态响应缺少可信 readAt', undefined, 409);
  }
  if (!Array.isArray(payload.operations)
    || payload.operations.length !== 2
    || !payload.operations.every(isRecordValue)) {
    throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON 商品状态响应必须包含两项唯一的 v2 只读操作证据', undefined, 409);
  }
  const operationRows = payload.operations as Record<string, unknown>[];
  const infoOperationRows = operationRows.filter((entry) => entry.operation === 'infoList');
  const attributeOperationRows = operationRows.filter((entry) => entry.operation === 'attributesInfo');
  if (infoOperationRows.length !== 1 || attributeOperationRows.length !== 1) {
    throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON 商品状态响应的 infoList/attributesInfo 操作不唯一', {
      infoListCount: infoOperationRows.length,
      attributesInfoCount: attributeOperationRows.length
    }, 409);
  }
  const infoOperation = normalizeKnownRecoveryV2Operation('infoList', infoOperationRows[0]!, infoItems.length);
  const attributeOperation = normalizeKnownRecoveryV2Operation('attributesInfo', attributeOperationRows[0]!, attributeItems.length);

  const infoByOffer = new Map<string, Record<string, unknown>[]>();
  for (const item of infoItems) {
    const offerId = stringValue(item.offer_id ?? item.offerId);
    if (!offerId || !expected.has(offerId)) {
      throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON 商品状态响应包含无法归属的商品记录', { offerId }, 409);
    }
    const matches = infoByOffer.get(offerId) || [];
    matches.push(item);
    infoByOffer.set(offerId, matches);
  }
  for (const item of attributeItems) {
    const offerId = stringValue(item.offer_id ?? item.offerId);
    if (!offerId || !expected.has(offerId)) {
      throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON 属性响应包含无法归属的商品记录', { offerId }, 409);
    }
    throw new AppError('OZON_REMOTE_STATE_PRESENT', 'OZON 已返回目标 Offer 的商品属性，禁止原地恢复', {
      offerId
    }, 409);
  }
  for (const offerId of offerIds) {
    const matches = infoByOffer.get(offerId) || [];
    if (matches.length > 1) {
      throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON 商品状态返回重复 Offer，无法证明平台为空', {
        offerId,
        count: matches.length
      }, 409);
    }
    if (matches[0] && !isExplicitOzonNotFound(matches[0])) {
      throw new AppError('OZON_REMOTE_STATE_PRESENT', 'OZON 已返回目标 Offer 的非 NOT_FOUND 状态，禁止原地恢复', {
        offerId,
        status: ozonRemoteStatusLabel(matches[0])
      }, 409);
    }
  }
  if (infoItems.length || attributeItems.length) {
    throw new AppError(
      'OZON_REMOTE_STATE_UNPROVEN',
      'OZON productStatus v2 返回了非空但不能证明商品存在的记录，禁止原地恢复',
      undefined,
      409
    );
  }
  const absenceEvidence = normalizeKnownRecoveryAbsenceEvidence(
    payload.absenceEvidence,
    infoOperation,
    attributeOperation
  );
  return {
    status: 'CONFIRMED_EMPTY',
    offerIds,
    checkedAt: new Date(rawReadAt).toISOString(),
    infoItemCount: infoItems.length,
    attributeItemCount: attributeItems.length,
    contractVersion: 2,
    requestedOfferIds,
    operations: [infoOperation, attributeOperation],
    absenceEvidence
  };
}

type KnownRecoveryV2Operation = NonNullable<
  OzonKnownPrePlatformFailureRecoveryChecks['remoteState']['operations']
>[number];

type KnownRecoveryAbsenceEvidence = NonNullable<
  OzonKnownPrePlatformFailureRecoveryChecks['remoteState']['absenceEvidence']
>;

function strictKnownRecoveryRequestedOfferIds(value: unknown): string[] {
  if (!Array.isArray(value)
    || value.length === 0
    || !value.every((entry) => typeof entry === 'string' && entry.length > 0 && entry === entry.trim())) {
    throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON productStatus v2 requestedOfferIds 结构无效', undefined, 409);
  }
  const requestedOfferIds = value as string[];
  if (new Set(requestedOfferIds).size !== requestedOfferIds.length) {
    throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON productStatus v2 requestedOfferIds 包含重复值', undefined, 409);
  }
  return [...requestedOfferIds];
}

function strictKnownRecoveryObjectArray(value: unknown, field: 'infoItems' | 'attributeItems'): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecordValue)) {
    throw new AppError('OZON_REMOTE_STATE_UNPROVEN', `OZON productStatus v2 ${field} 必须是完整的对象数组`, undefined, 409);
  }
  return value as Record<string, unknown>[];
}

type KnownPostPlatformPriceProduct = {
  currency: string;
  offers: Array<{
    offerId: string;
    price: number;
    oldPrice: number | null;
    minPrice: number;
  }>;
};

function normalizeKnownPostPlatformPriceProduct(
  value: unknown,
  job: OzonPublishJob
): KnownPostPlatformPriceProduct {
  if (!isRecordValue(value)
    || String(value.productCode || '') !== job.sku
    || Number(value.revision || 0) !== Number(job.revision || 0)
    || !Array.isArray(value.offers)
    || value.offers.length !== job.offerIds.length
    || !value.offers.every(isRecordValue)) {
    throw new AppError('VERSION_CONFLICT', '最低价恢复 product.json 产品身份或 Offer 数量不一致', {
      jobId: job.id
    }, 409);
  }
  const currency = typeof value.currency === 'string' ? value.currency.trim().toUpperCase() : '';
  if (!currency) {
    throw new AppError('VERSION_CONFLICT', '最低价恢复 product.json 缺少币种', { jobId: job.id }, 409);
  }
  const offers = value.offers.map((raw) => {
    const offerId = String(raw.offerId || '').trim();
    const price = strictFiniteNumber(raw.price);
    const configuredMin = raw.minPrice == null ? price : strictFiniteNumber(raw.minPrice);
    const oldPrice = raw.oldPrice == null ? null : strictFiniteNumber(raw.oldPrice);
    const platformFloor = Math.ceil(price * 50) / 100;
    const minPrice = Math.max(configuredMin, platformFloor);
    if (!offerId || !Number.isFinite(price) || price <= 0 || !Number.isFinite(minPrice) || minPrice <= 0
      || (oldPrice !== null && (!Number.isFinite(oldPrice) || oldPrice <= 0))) {
      throw new AppError('VERSION_CONFLICT', '最低价恢复 product.json 价格合同无效', {
        jobId: job.id,
        offerId
      }, 409);
    }
    return { offerId, price, oldPrice, minPrice };
  });
  if (new Set(offers.map((offer) => offer.offerId)).size !== offers.length
    || !sameOrderedStrings(offers.map((offer) => offer.offerId), job.offerIds)) {
    throw new AppError('VERSION_CONFLICT', '最低价恢复 product.json Offer 集合与原任务不一致', {
      jobId: job.id,
      expectedOfferIds: job.offerIds,
      actualOfferIds: offers.map((offer) => offer.offerId)
    }, 409);
  }
  return { currency, offers };
}

export function normalizeKnownPostPlatformRemoteProducts(
  job: OzonPublishJob,
  storedMappings: OzonProductMapping[],
  response: Record<string, unknown>
): OzonKnownPostPlatformMinPriceRecoveryChecks['remoteProducts'] {
  const payload = isRecordValue(response.result) ? response.result : undefined;
  if (response.ok !== true || Number(response.httpStatus) !== 200 || !payload
    || Number(payload.contractVersion) !== 2
    || !sameOrderedStrings(strictStringList(payload.requestedOfferIds), job.offerIds)
    || !Array.isArray(payload.infoItems) || !payload.infoItems.every(isRecordValue)
    || !Array.isArray(payload.attributeItems) || !payload.attributeItems.every(isRecordValue)
    || !Array.isArray(payload.operations) || !payload.operations.every(isRecordValue)) {
    throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON productStatus v2 响应结构不完整', {
      jobId: job.id
    }, 409);
  }
  const readAt = typeof payload.readAt === 'string' ? payload.readAt.trim() : '';
  if (!readAt || !Number.isFinite(Date.parse(readAt))) {
    throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON productStatus v2 缺少可信 readAt', {
      jobId: job.id
    }, 409);
  }
  const operations = payload.operations;
  const requiredOperations = ['attributesInfo', 'infoList'];
  const operationNames = operations.map((entry) => String(entry.operation || '')).sort();
  if (operations.length !== 2 || !sameOrderedStrings(operationNames, requiredOperations)
    || operations.some((entry) => entry.ok !== true || Number(entry.statusCode) !== 200
      || entry.outcome !== 'PRESENT' || entry.resultShape !== 'ARRAY')) {
    throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON productStatus v2 未证明 info/attributes 两项均完整存在', {
      jobId: job.id,
      operationNames
    }, 409);
  }
  const exactByOffer = (rows: Record<string, unknown>[], kind: string) => {
    const byOffer = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const offerId = String(row.offer_id || row.offerId || '').trim();
      if (!job.offerIds.includes(offerId) || byOffer.has(offerId)) {
        throw new AppError('OZON_REMOTE_STATE_UNPROVEN', `OZON ${kind} 返回未知或重复 Offer`, {
          jobId: job.id,
          offerId
        }, 409);
      }
      byOffer.set(offerId, row);
    }
    if (byOffer.size !== job.offerIds.length || job.offerIds.some((offerId) => !byOffer.has(offerId))) {
      throw new AppError('OZON_REMOTE_STATE_UNPROVEN', `OZON ${kind} 未完整返回全部 Offer`, {
        jobId: job.id,
        expectedOfferIds: job.offerIds,
        actualOfferIds: [...byOffer.keys()]
      }, 409);
    }
    return byOffer;
  };
  const infoByOffer = exactByOffer(payload.infoItems, 'infoList');
  exactByOffer(payload.attributeItems, 'attributesInfo');
  const mappings = job.offerIds.map((offerId) => {
    const item = infoByOffer.get(offerId)!;
    const ozonProductId = String(item.id || item.product_id || item.productId || '').trim();
    const ozonSku = String(item.sku || item.fbo_sku || item.fbs_sku || '').trim();
    const statuses = objectValue(item.statuses);
    const archived = item.is_archived === true || item.archived === true || statuses.is_archived === true;
    if (!/^\d+$/.test(ozonProductId) || !/^\d+$/.test(ozonSku) || archived) {
      throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON 商品内部 ID/Ozon SKU 不完整或商品已归档', {
        jobId: job.id,
        offerId,
        ozonProductId,
        ozonSku,
        archived
      }, 409);
    }
    return { offerId, ozonProductId, ozonSku };
  });
  if (new Set(mappings.map((entry) => entry.ozonProductId)).size !== mappings.length
    || new Set(mappings.map((entry) => entry.ozonSku)).size !== mappings.length) {
    throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON 商品映射存在跨 Offer 重复 ID', {
      jobId: job.id
    }, 409);
  }
  for (const stored of storedMappings) {
    const remote = mappings.find((entry) => entry.offerId === stored.offerId);
    if (!remote || remote.ozonProductId !== stored.ozonProductId || remote.ozonSku !== stored.ozonSku
      || stored.storeAlias !== job.storeAlias || stored.sku !== job.sku) {
      throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON 远端商品映射与 MerchRoute 持久化映射已漂移', {
        jobId: job.id,
        offerId: stored.offerId
      }, 409);
    }
  }
  for (const link of job.ozonProductLinks) {
    const remote = mappings.find((entry) => entry.offerId === link.offerId);
    if (!remote || remote.ozonProductId !== link.ozonProductId || remote.ozonSku !== link.ozonSku) {
      throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON 远端商品映射与原 job product link 已漂移', {
        jobId: job.id,
        offerId: link.offerId
      }, 409);
    }
  }
  return {
    status: 'MATCHED',
    checkedAt: readAt,
    requestedOfferIds: [...job.offerIds],
    mappings
  };
}

export function normalizeKnownPostPlatformPricesRead(
  currencyInput: string,
  responses: Array<{
    offer: KnownPostPlatformPriceProduct['offers'][number];
    response: Record<string, unknown>;
  }>
): OzonKnownPostPlatformMinPriceRecoveryChecks['pricesRead'] {
  const currency = String(currencyInput || '').trim().toUpperCase();
  if (!currency || responses.length < 1) {
    throw new AppError('OZON_REMOTE_PRICE_UNPROVEN', 'A001 pricesRead 缺少币种或 Offer 请求', undefined, 409);
  }
  const observations = responses.map(({ offer, response }) => {
    if (response.ready !== true || response.ok !== true || Number(response.httpStatus) !== 200) {
      throw new AppError('OZON_REMOTE_PRICE_UNPROVEN', 'C001/A001 pricesRead 只读预检未完整成功', {
        offerId: offer.offerId
      }, 409);
    }
    const prices = isRecordValue(response.productPrices) ? response.productPrices : undefined;
    const rows = strictSingleArrayResult(prices, 'productPrices');
    if (rows.length !== 1 || String(rows[0]?.offer_id || rows[0]?.offerId || '').trim() !== offer.offerId) {
      throw new AppError('OZON_REMOTE_PRICE_UNPROVEN', 'A001 pricesRead 未唯一返回目标 Offer', {
        offerId: offer.offerId,
        itemCount: rows.length
      }, 409);
    }
    const bucket = isRecordValue(rows[0]?.price) ? rows[0]!.price : undefined;
    if (!bucket) {
      throw new AppError('OZON_REMOTE_PRICE_UNPROVEN', 'A001 pricesRead 缺少严格 price 对象', {
        offerId: offer.offerId
      }, 409);
    }
    const actualPrice = requiredFinitePriceField(bucket, 'price', offer.offerId);
    const actualOldPrice = bucket.old_price == null || bucket.old_price === ''
      ? null
      : requiredFinitePriceField(bucket, 'old_price', offer.offerId);
    const actualMinPrice = requiredFinitePriceField(bucket, 'min_price', offer.offerId);
    const actualCurrency = typeof bucket.currency_code === 'string'
      ? bucket.currency_code.trim().toUpperCase()
      : '';
    const onlyMinMissing = closeOzonPrice(actualPrice, offer.price)
      && nullablePriceEqual(actualOldPrice, offer.oldPrice)
      && actualCurrency === currency
      && Object.is(actualMinPrice, 0)
      && offer.minPrice > 0;
    if (!onlyMinMissing) {
      throw new AppError('OZON_REMOTE_PRICE_UNPROVEN', 'OZON 权威价格读回不再是唯一 min_price=0 差异', {
        offerId: offer.offerId,
        expected: { price: offer.price, oldPrice: offer.oldPrice, minPrice: offer.minPrice, currency },
        actual: { price: actualPrice, oldPrice: actualOldPrice, minPrice: actualMinPrice, currency: actualCurrency }
      }, 409);
    }
    return {
      offerId: offer.offerId,
      expected: { price: offer.price, oldPrice: offer.oldPrice, minPrice: offer.minPrice, currency },
      actual: { price: actualPrice, oldPrice: actualOldPrice, minPrice: 0 as const, currency: actualCurrency }
    };
  });
  const offerIds = observations.map((entry) => entry.offerId);
  if (new Set(offerIds).size !== offerIds.length) {
    throw new AppError('OZON_REMOTE_PRICE_UNPROVEN', 'A001 pricesRead 响应包含重复 Offer', { offerIds }, 409);
  }
  return {
    status: 'ONLY_MIN_PRICE_MISSING',
    checkedAt: new Date().toISOString(),
    offers: observations
  };
}

function strictSingleArrayResult(value: Record<string, unknown> | undefined, field: string): Record<string, any>[] {
  if (!value) throw new AppError('OZON_REMOTE_PRICE_UNPROVEN', `${field} 结构缺失`, undefined, 409);
  const result = isRecordValue(value.result) ? value.result : undefined;
  const candidates = [value.items, result?.items, Array.isArray(value.result) ? value.result : undefined]
    .filter((entry) => Array.isArray(entry));
  if (candidates.length !== 1 || !(candidates[0] as unknown[]).every(isRecordValue)) {
    throw new AppError('OZON_REMOTE_PRICE_UNPROVEN', `${field} 必须包含唯一对象数组`, undefined, 409);
  }
  return candidates[0] as Record<string, any>[];
}

function requiredFinitePriceField(bucket: Record<string, unknown>, field: string, offerId: string): number {
  if (!Object.prototype.hasOwnProperty.call(bucket, field)
    || bucket[field] === null || typeof bucket[field] === 'boolean'
    || (typeof bucket[field] === 'string' && !bucket[field].trim())) {
    throw new AppError('OZON_REMOTE_PRICE_UNPROVEN', `A001 pricesRead ${field} 缺失`, { offerId }, 409);
  }
  const value = Number(bucket[field]);
  if (!Number.isFinite(value)) {
    throw new AppError('OZON_REMOTE_PRICE_UNPROVEN', `A001 pricesRead ${field} 不是有限数值`, { offerId }, 409);
  }
  return value;
}

function strictFiniteNumber(value: unknown): number {
  if (value === null || value === undefined || typeof value === 'boolean'
    || (typeof value === 'string' && !value.trim())) return Number.NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function strictStringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) return [];
  const normalized = value.map((entry) => entry.trim());
  return new Set(normalized).size === normalized.length ? normalized : [];
}

function sameOrderedStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function closeOzonPrice(left: number, right: number): boolean {
  return left === right;
}

function nullablePriceEqual(left: number | null, right: number | null): boolean {
  return left === null || right === null ? left === right : closeOzonPrice(left, right);
}

function normalizeKnownRecoveryV2Operation(
  operation: 'infoList' | 'attributesInfo',
  value: Record<string, unknown>,
  itemCount: number
): KnownRecoveryV2Operation {
  const requestId = `productStatus:${operation}` as KnownRecoveryV2Operation['requestId'];
  const normalOutcome = itemCount === 0 ? 'EMPTY' : 'PRESENT';
  const normalKeys = ['itemCount', 'ok', 'operation', 'outcome', 'requestId', 'resultShape', 'statusCode', 'upstreamOk'];
  const isNormal = hasExactObjectKeys(value, normalKeys)
    && value.operation === operation
    && value.requestId === requestId
    && value.ok === true
    && value.upstreamOk === true
    && value.statusCode === 200
    && value.outcome === normalOutcome
    && value.resultShape === 'ARRAY'
    && value.itemCount === itemCount;
  if (isNormal) {
    return {
      operation,
      requestId,
      ok: true,
      upstreamOk: true,
      statusCode: 200,
      outcome: normalOutcome,
      resultShape: 'ARRAY',
      itemCount
    };
  }
  const specialKeys = [...normalKeys, 'errorCode'];
  const isAttributesNotFound = operation === 'attributesInfo'
    && itemCount === 0
    && hasExactObjectKeys(value, specialKeys)
    && value.operation === operation
    && value.requestId === requestId
    && value.ok === true
    && value.upstreamOk === false
    && value.statusCode === 404
    && value.outcome === 'NOT_FOUND'
    && value.resultShape === 'NOT_FOUND_ERROR'
    && value.itemCount === 0
    && value.errorCode === '5';
  if (isAttributesNotFound) {
    return {
      operation,
      requestId,
      ok: true,
      upstreamOk: false,
      statusCode: 404,
      outcome: 'NOT_FOUND',
      resultShape: 'NOT_FOUND_ERROR',
      itemCount: 0,
      errorCode: '5'
    };
  }
  throw new AppError('OZON_REMOTE_STATE_UNPROVEN', `OZON productStatus v2 ${operation} 操作证据与结果不一致`, {
    expectedItemCount: itemCount
  }, 409);
}

function normalizeKnownRecoveryAbsenceEvidence(
  value: unknown,
  infoOperation: KnownRecoveryV2Operation,
  attributeOperation: KnownRecoveryV2Operation
): KnownRecoveryAbsenceEvidence {
  if (!isRecordValue(value) || !hasExactObjectKeys(value, ['attributesInfo', 'infoList', 'method'])) {
    throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON productStatus v2 缺少完整的 absenceEvidence', undefined, 409);
  }
  const infoEvidence = value.infoList;
  const attributeEvidence = value.attributesInfo;
  if (!isRecordValue(infoEvidence)
    || !hasExactObjectKeys(infoEvidence, ['itemCount', 'resultShape', 'statusCode'])
    || infoEvidence.statusCode !== infoOperation.statusCode
    || infoEvidence.resultShape !== infoOperation.resultShape
    || infoEvidence.itemCount !== infoOperation.itemCount) {
    throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON productStatus v2 infoList absenceEvidence 与操作证据不一致', undefined, 409);
  }
  const attributesNotFound = attributeOperation.resultShape === 'NOT_FOUND_ERROR';
  const attributeKeys = attributesNotFound
    ? ['errorCode', 'itemCount', 'resultShape', 'statusCode']
    : ['itemCount', 'resultShape', 'statusCode'];
  if (!isRecordValue(attributeEvidence)
    || !hasExactObjectKeys(attributeEvidence, attributeKeys)
    || attributeEvidence.statusCode !== attributeOperation.statusCode
    || attributeEvidence.resultShape !== attributeOperation.resultShape
    || attributeEvidence.itemCount !== attributeOperation.itemCount
    || (attributesNotFound && attributeEvidence.errorCode !== '5')) {
    throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON productStatus v2 attributesInfo absenceEvidence 与操作证据不一致', undefined, 409);
  }
  const expectedMethod = attributesNotFound ? 'INFO_EMPTY_ATTRIBUTES_NOT_FOUND' : 'BOTH_ARRAYS_EMPTY';
  if (value.method !== expectedMethod) {
    throw new AppError('OZON_REMOTE_STATE_UNPROVEN', 'OZON productStatus v2 absenceEvidence method 与操作结果不一致', {
      expectedMethod,
      actualMethod: value.method
    }, 409);
  }
  return attributesNotFound
    ? {
        method: 'INFO_EMPTY_ATTRIBUTES_NOT_FOUND',
        infoList: { statusCode: 200, resultShape: 'ARRAY', itemCount: 0 },
        attributesInfo: { statusCode: 404, resultShape: 'NOT_FOUND_ERROR', itemCount: 0, errorCode: '5' }
      }
    : {
        method: 'BOTH_ARRAYS_EMPTY',
        infoList: { statusCode: 200, resultShape: 'ARRAY', itemCount: 0 },
        attributesInfo: { statusCode: 200, resultShape: 'ARRAY', itemCount: 0 }
      };
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((entry, index) => entry === sortedRight[index]);
}

function hasExactObjectKeys(value: Record<string, unknown>, expectedKeys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasLegacyOzonDescriptionKeywordStuffing(value: string): boolean {
  const words = value.toLocaleLowerCase('ru-RU').match(/[a-zа-яё]{4,}/giu) || [];
  const counts = new Map<string, number>();
  for (const word of words) {
    const count = (counts.get(word) || 0) + 1;
    if (count >= 3) return true;
    counts.set(word, count);
  }
  return false;
}

function isExplicitOzonNotFound(item: Record<string, unknown>): boolean {
  const identifiers = [item.id, item.product_id, item.productId, item.sku, item.ozon_sku, item.ozonSku]
    .map(stringValue)
    .filter(Boolean);
  const existenceConfirmed = item.confirmed === true || item.is_created === true || item.exists === true;
  return !identifiers.length && !existenceConfirmed && ozonRemoteStatusLabel(item) === 'NOT_FOUND';
}

function ozonRemoteStatusLabel(item: Record<string, unknown>): string {
  const error = objectValue(item.error);
  const statuses = objectValue(item.statuses);
  return (stringValue(
    item.displayState
    ?? item.display_state
    ?? item.status
    ?? item.code
    ?? error.code
    ?? statuses.status_name
  ) || '').toUpperCase();
}

export function normalizeOzonPlatformStatusRefresh(
  lease: OzonPlatformStatusRefreshLease,
  response: Record<string, unknown>
): NormalizedOzonPlatformStatusRefresh {
  const payload = platformStatusResponsePayload(response);
  const expectedOfferIds = new Set(lease.offerIds);
  const infoByOffer = new Map<string, Record<string, unknown>>();
  const duplicateOfferIds = new Set<string>();
  const warnings: string[] = [];
  for (const item of payload.infoItems) {
    const offerId = stringValue(item.offer_id ?? item.offerId);
    if (!offerId) continue;
    if (!expectedOfferIds.has(offerId)) {
      warnings.push(`OZON 返回了当前草稿之外的变体 ${offerId}，本次已忽略`);
      continue;
    }
    if (infoByOffer.has(offerId)) duplicateOfferIds.add(offerId);
    else infoByOffer.set(offerId, item);
  }
  if (duplicateOfferIds.size) {
    throw new AppError('VERIFY_FAILED', 'OZON 商品状态返回重复 offer_id，无法安全刷新', {
      duplicateOfferIds: [...duplicateOfferIds]
    }, 409);
  }
  const attributeByOffer = new Map<string, Record<string, unknown>>();
  for (const item of payload.attributeItems) {
    const offerId = stringValue(item.offer_id ?? item.offerId);
    if (offerId && expectedOfferIds.has(offerId) && !attributeByOffer.has(offerId)) attributeByOffer.set(offerId, item);
  }
  const previousMappings = new Map(lease.mappings.map((mapping) => [mapping.offerId, mapping]));
  const listingOffers = new Map(lease.listing.data.offers.map((offer) => [offer.offerId, offer]));
  const offers = lease.offerIds.map((offerId): OzonPlatformOfferStatus => {
    const item = infoByOffer.get(offerId);
    const previous = previousMappings.get(offerId);
    if (!item) {
      const previousSnapshot = objectValue(previous?.statusSnapshot);
      const missingConfirmationCount = Math.max(0, Number(previousSnapshot.missingConfirmationCount || 0)) + 1;
      const confirmed = missingConfirmationCount >= 2;
      const previousDisplayState = previousPlatformDisplayState(previous, lease.listing.status);
      const displayState: OzonPlatformOfferDisplayState = confirmed ? 'NOT_FOUND' : previousDisplayState;
      const businessState = confirmed
        ? 'NEEDS_ATTENTION'
        : previousPlatformBusinessState(previousSnapshot, displayState, lease.listing.status);
      const message = confirmed
        ? 'OZON 连续两次未返回该变体，已确认平台缺失'
        : 'OZON 本轮未返回该变体，需再次成功读取后才能确认缺失';
      warnings.push(`[${offerId}] ${message}`);
      return {
        offerId,
        ...(previous?.ozonProductId ? { ozonProductId: previous.ozonProductId } : {}),
        ...(previous?.ozonSku ? { ozonSku: previous.ozonSku } : {}),
        displayState,
        businessState,
        readAt: payload.readAt,
        missingConfirmationCount,
        confirmed,
        statusDescription: message,
        platformMessage: message,
        warnings: [message]
      };
    }
    const normalized = normalizeOzonPlatformOffer(item, offerId, payload.readAt);
    const draftOffer = listingOffers.get(offerId);
    const mediaWarnings = platformMediaWarnings(draftOffer, item, attributeByOffer.get(offerId));
    if (mediaWarnings.length) {
      normalized.warnings = [...(normalized.warnings || []), ...mediaWarnings];
      warnings.push(...mediaWarnings.map((message) => `[${offerId}] ${message}`));
    }
    if (normalized.warnings?.length) {
      for (const message of normalized.warnings) {
        const decorated = `[${offerId}] ${message}`;
        if (!warnings.includes(decorated)) warnings.push(decorated);
      }
    }
    return normalized;
  });
  const businessState: OzonPlatformBusinessState = offers.some((offer) => offer.businessState === 'NEEDS_ATTENTION')
    ? 'NEEDS_ATTENTION'
    : offers.every((offer) => offer.businessState === 'PUBLISHED')
      ? 'PUBLISHED'
      : 'MODERATING';
  return {
    readAt: payload.readAt,
    businessState,
    offers,
    warnings: [...new Set(warnings)],
    stageStates: platformStatusStageStates(offers, listingOffers)
  };
}

function platformStatusResponsePayload(response: Record<string, unknown>): {
  infoItems: Record<string, unknown>[];
  attributeItems: Record<string, unknown>[];
  readAt: string;
} {
  const envelopes = platformResponseObjects(response);
  const failedEnvelope = envelopes.find((entry) => entry.ok === false);
  if (failedEnvelope) {
    const operations = Array.isArray(failedEnvelope.operations) ? failedEnvelope.operations : [];
    throw new AppError('OZON_PLATFORM_STATUS_REFRESH_FAILED', 'OZON 商品状态只读查询失败', {
      message: stringValue(failedEnvelope.message ?? failedEnvelope.error),
      operations
    }, Number(failedEnvelope.httpStatus) === 429 ? 429 : 502);
  }
  const operationSources = envelopes.flatMap((entry) => Array.isArray(entry.operations) ? entry.operations : []);
  const failedOperations = operationSources
    .map((entry) => objectValue(entry))
    .filter((entry) => entry.ok === false);
  if (failedOperations.length) {
    throw new AppError('OZON_PLATFORM_STATUS_REFRESH_FAILED', 'OZON 商品状态只读查询未完整成功', {
      operations: failedOperations
    }, failedOperations.some((entry) => Number(entry.statusCode) === 429) ? 429 : 502);
  }
  const payload = envelopes.find((entry) => Array.isArray(entry.infoItems) || Array.isArray(entry.attributeItems));
  if (!payload) {
    const legacy = envelopes.find((entry) => entry.infoList !== undefined || entry.attributesInfo !== undefined);
    if (!legacy) {
      throw new AppError('OZON_PLATFORM_STATUS_REFRESH_FAILED', 'OZON 商品状态响应结构无效', undefined, 502);
    }
    return {
      infoItems: platformItems(objectValue(legacy.infoList).body ?? legacy.infoList),
      attributeItems: platformItems(objectValue(legacy.attributesInfo).body ?? legacy.attributesInfo),
      readAt: validReadAt(legacy.readAt)
    };
  }
  return {
    infoItems: recordArray(payload.infoItems),
    attributeItems: recordArray(payload.attributeItems),
    readAt: validReadAt(payload.readAt)
  };
}

function platformResponseObjects(response: Record<string, unknown>): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 4 || seen.has(value as object)) return;
    seen.add(value as object);
    const entry = value as Record<string, unknown>;
    output.push(entry);
    for (const key of ['result', 'body', 'data', 'response']) visit(entry[key], depth + 1);
  };
  visit(response, 0);
  return output;
}

function platformItems(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return recordArray(value);
  const source = objectValue(value);
  if (Array.isArray(source.items)) return recordArray(source.items);
  if (Array.isArray(source.result)) return recordArray(source.result);
  if (source.result && typeof source.result === 'object') return recordArray(objectValue(source.result).items);
  return [];
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function validReadAt(value: unknown): string {
  const text = stringValue(value);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : new Date().toISOString();
}

function normalizeOzonPlatformOffer(
  item: Record<string, unknown>,
  offerId: string,
  readAt: string
): OzonPlatformOfferStatus {
  const statuses = objectValue(item.statuses);
  const statusName = stringValue(statuses.status_name ?? statuses.statusName ?? item.status_name ?? item.statusName);
  const statusDescription = stringValue(
    statuses.status_description ?? statuses.statusDescription ?? item.status_description ?? item.statusDescription
  );
  const moderateStatus = stringValue(statuses.moderate_status ?? statuses.moderateStatus ?? item.moderate_status)?.toLowerCase();
  const validationStatus = stringValue(statuses.validation_status ?? statuses.validationStatus ?? item.validation_status)?.toLowerCase();
  const lowerStatus = `${statusName || ''} ${statusDescription || ''}`.toLowerCase();
  const issues = recordArray(item.errors ?? statuses.errors);
  const warningIssues = issues.filter(isOzonPlatformWarning);
  const errorIssues = issues.filter((entry) => !isOzonPlatformWarning(entry));
  const errorCodes = [...new Set(errorIssues.map((entry) => stringValue(entry.code ?? entry.error_code)).filter(Boolean) as string[])];
  const platformWarnings = [...new Set(warningIssues
    .map((entry) => stringValue(entry.message ?? entry.description ?? entry.code))
    .filter(Boolean) as string[])];
  const isCreated = booleanValue(item.is_created ?? statuses.is_created)
    ?? Boolean(stringValue(item.id ?? item.product_id ?? item.productId));
  const archived = Boolean(booleanValue(item.is_archived ?? statuses.is_archived)) || /archiv|архив/.test(lowerStatus);
  const hidden = Boolean(booleanValue(item.is_hidden ?? statuses.is_hidden))
    || String(item.visibility || '').toUpperCase() === 'HIDDEN'
    || /hidden|скрыт|невидим/.test(lowerStatus);
  const notSelling = /not.for.sale|not.selling|не.прода[её]тся|снят[аоы]?.с.продаж/.test(lowerStatus);
  const rejected = errorIssues.length > 0
    || ['declined', 'rejected', 'failed', 'error'].includes(moderateStatus || '')
    || ['failed', 'error', 'invalid'].includes(validationStatus || '');
  const approved = isCreated && (
    (moderateStatus === 'approved' && validationStatus === 'success')
    || /on.sale|selling|прода[её]тся|готов.к.продаже/.test(lowerStatus)
  );
  const stock = ozonStockState(item);
  const priceObject = objectValue(item.price);
  const rawPrice = Object.keys(priceObject).length
    ? priceObject.price ?? priceObject.marketing_price ?? priceObject.marketingPrice
    : item.price;
  const numericPrice = Number(rawPrice);
  const hasPrice = Number.isFinite(numericPrice) ? numericPrice > 0 : undefined;
  let displayState: OzonPlatformOfferDisplayState;
  if (archived) displayState = 'ARCHIVED';
  else if (hidden) displayState = 'HIDDEN';
  else if (rejected) displayState = 'ERROR';
  else if (notSelling) displayState = 'NOT_FOR_SALE';
  else if (/out.of.stock|нет.в.наличии|законч/.test(lowerStatus)) displayState = 'OUT_OF_STOCK';
  else if (approved) displayState = stock.known && stock.present <= 0 ? 'OUT_OF_STOCK' : 'ON_SALE';
  else if (/on.sale|selling|прода[её]тся/.test(lowerStatus)) displayState = 'ON_SALE';
  else displayState = 'MODERATING';
  const businessState = platformBusinessState(displayState);
  const ozonProductId = numericIdentifier(item.id ?? item.product_id ?? item.productId);
  const ozonSku = numericIdentifier(item.sku ?? item.fbo_sku ?? item.fbs_sku);
  const imageCount = ozonImageCount(item);
  return {
    offerId,
    ...(ozonProductId ? { ozonProductId } : {}),
    ...(ozonSku ? { ozonSku } : {}),
    displayState,
    businessState,
    readAt,
    missingConfirmationCount: 0,
    confirmed: true,
    ...(statusName ? { statusName } : {}),
    ...(statusDescription ? { statusDescription } : {}),
    ...(moderateStatus ? { moderateStatus } : {}),
    ...(validationStatus ? { validationStatus } : {}),
    isCreated,
    visible: !hidden && !archived && !notSelling,
    ...(hasPrice !== undefined ? { hasPrice } : {}),
    ...(stock.known ? { hasStock: stock.present > 0 } : {}),
    ...(imageCount !== undefined ? { imageCount } : {}),
    ...(errorCodes.length ? { errorCodes } : {}),
    ...(platformWarnings.length ? { warnings: platformWarnings } : {}),
    ...(statusDescription || statusName ? { platformMessage: statusDescription || statusName } : {})
  };
}

function platformMediaWarnings(
  offer: OzonListingDraft['data']['offers'][number] | undefined,
  info: Record<string, unknown>,
  attributes: Record<string, unknown> | undefined
): string[] {
  if (!offer) return [];
  const warnings: string[] = [];
  const expectedImages = offer.media.filter((entry) => entry.kind === 'image').length;
  const actualImages = ozonImageCount(info);
  if (actualImages !== undefined && expectedImages !== actualImages) {
    warnings.push(`提交图片 ${expectedImages} 张，OZON 当前读回 ${actualImages} 张（仅告警）`);
  }
  const expectsVideo = offer.media.some((entry) => entry.kind === 'video');
  if (expectsVideo) {
    const pairs = ozonAttributePairs(attributes);
    if (!pairs.has('100002:21845')) warnings.push('OZON 当前未读回视频封面属性（仅告警）');
  }
  return warnings;
}

function ozonAttributePairs(value: unknown): Set<string> {
  const pairs = new Set<string>();
  const seen = new Set<object>();
  const visit = (entry: unknown, inheritedComplexId = 0): void => {
    if (Array.isArray(entry)) {
      entry.forEach((child) => visit(child, inheritedComplexId));
      return;
    }
    if (!entry || typeof entry !== 'object' || seen.has(entry as object)) return;
    seen.add(entry as object);
    const source = entry as Record<string, unknown>;
    const attributeId = Number(source.id ?? source.attribute_id ?? source.attributeId ?? 0);
    const complexId = Number(source.complex_id ?? source.complexId ?? source.attribute_complex_id ?? inheritedComplexId);
    const values = source.values ?? source.value;
    const present = Array.isArray(values)
      ? values.length > 0
      : values !== undefined && values !== null && String(values).trim() !== '';
    if (attributeId > 0 && complexId > 0 && present) pairs.add(`${complexId}:${attributeId}`);
    Object.values(source).forEach((child) => visit(child, complexId));
  };
  visit(value);
  return pairs;
}

function ozonStockState(item: Record<string, unknown>): { known: boolean; present: number } {
  const nested = objectValue(item.stocks);
  const rows = Array.isArray(nested.stocks) ? nested.stocks : Array.isArray(item.stocks) ? item.stocks : undefined;
  if (!rows) return { known: false, present: 0 };
  return {
    known: true,
    present: rows.reduce((sum, entry) => {
      const row = objectValue(entry);
      const value = Number(row.present ?? row.stock ?? 0);
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0)
  };
}

function ozonImageCount(item: Record<string, unknown>): number | undefined {
  const images = Array.isArray(item.images) ? item.images : undefined;
  const primary = item.primary_image ?? item.primaryImage;
  if (!images && primary === undefined) return undefined;
  const primaryCount = Array.isArray(primary) ? primary.length : primary ? 1 : 0;
  return (images?.length || 0) + primaryCount;
}

function isOzonPlatformWarning(entry: Record<string, unknown>): boolean {
  const level = String(entry.level ?? entry.severity ?? '').trim().toLowerCase();
  return level === 'warning' || level.endsWith('_warning');
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || String(value).toLowerCase() === 'true') return true;
  if (value === 0 || value === '0' || String(value).toLowerCase() === 'false') return false;
  return undefined;
}

function numericIdentifier(value: unknown): string | undefined {
  const text = stringValue(value);
  return text && /^\d+$/.test(text) ? text : undefined;
}

function previousPlatformDisplayState(
  mapping: OzonProductMapping | undefined,
  listingStatus: OzonListingDraft['status']
): OzonPlatformOfferDisplayState {
  const snapshot = objectValue(mapping?.statusSnapshot);
  const candidate = String(snapshot.displayState ?? snapshot.status ?? snapshot.state ?? mapping?.status ?? '').trim();
  if (['ON_SALE', 'MODERATING', 'OUT_OF_STOCK', 'NOT_FOR_SALE', 'ERROR', 'HIDDEN', 'ARCHIVED', 'NOT_FOUND', 'UNKNOWN'].includes(candidate)) {
    return candidate as OzonPlatformOfferDisplayState;
  }
  if (listingStatus === 'PUBLISHED') return 'ON_SALE';
  if (listingStatus === 'MODERATING' || listingStatus === 'IMPORTED' || listingStatus === 'SUBMITTING') return 'MODERATING';
  return 'UNKNOWN';
}

function previousPlatformBusinessState(
  snapshot: Record<string, unknown>,
  displayState: OzonPlatformOfferDisplayState,
  listingStatus: OzonListingDraft['status']
): OzonPlatformBusinessState {
  const candidate = String(snapshot.businessState || '').trim();
  if (['PUBLISHED', 'MODERATING', 'NEEDS_ATTENTION'].includes(candidate)) return candidate as OzonPlatformBusinessState;
  if (listingStatus === 'PUBLISHED') return 'PUBLISHED';
  if (listingStatus === 'MODERATING' || listingStatus === 'IMPORTED' || listingStatus === 'SUBMITTING') return 'MODERATING';
  return platformBusinessState(displayState) === 'NEEDS_ATTENTION' && displayState === 'UNKNOWN'
    ? 'MODERATING'
    : platformBusinessState(displayState);
}

function platformBusinessState(displayState: OzonPlatformOfferDisplayState): OzonPlatformBusinessState {
  if (displayState === 'ON_SALE' || displayState === 'OUT_OF_STOCK') return 'PUBLISHED';
  if (displayState === 'MODERATING') return 'MODERATING';
  return 'NEEDS_ATTENTION';
}

function platformStatusStageStates(
  offers: OzonPlatformOfferStatus[],
  listingOffers: Map<string, OzonListingDraft['data']['offers'][number]>
): Record<string, string> {
  const businessState: OzonPlatformBusinessState = offers.some((offer) => offer.businessState === 'NEEDS_ATTENTION')
    ? 'NEEDS_ATTENTION'
    : offers.every((offer) => offer.businessState === 'PUBLISHED') ? 'PUBLISHED' : 'MODERATING';
  const hasUnconfirmed = offers.some((offer) => !offer.confirmed);
  const hasImageDifference = offers.some((offer) => (offer.warnings || []).some((warning) => /图片/.test(warning)));
  const hasVideoDifference = offers.some((offer) => (offer.warnings || []).some((warning) => /视频/.test(warning)));
  const expectsVideo = [...listingOffers.values()].some((offer) => offer.media.some((entry) => entry.kind === 'video'));
  return {
    import: offers.some((offer) => offer.displayState === 'NOT_FOUND') ? 'FAILED' : hasUnconfirmed ? 'PENDING' : 'SUCCESS',
    moderation: businessState === 'PUBLISHED' ? 'SUCCESS' : businessState === 'MODERATING' ? 'RUNNING' : 'FAILED',
    images: hasImageDifference ? 'DIFFERENCE' : hasUnconfirmed ? 'PENDING' : 'VERIFIED',
    video: !expectsVideo ? 'NOT_REQUIRED' : hasVideoDifference ? 'DIFFERENCE' : hasUnconfirmed ? 'PENDING' : 'VERIFIED',
    productVideo: !expectsVideo ? 'NOT_REQUIRED' : hasVideoDifference ? 'DIFFERENCE' : hasUnconfirmed ? 'PENDING' : 'VERIFIED',
    videoCover: !expectsVideo ? 'NOT_REQUIRED' : hasVideoDifference ? 'DIFFERENCE' : hasUnconfirmed ? 'PENDING' : 'VERIFIED',
    price: offers.some((offer) => offer.hasPrice === false) ? 'DIFFERENCE' : offers.every((offer) => offer.hasPrice === true) ? 'VERIFIED' : 'UNKNOWN',
    stock: offers.some((offer) => offer.displayState === 'OUT_OF_STOCK')
      ? 'OUT_OF_STOCK'
      : offers.every((offer) => offer.hasStock === true) ? 'VERIFIED' : 'UNKNOWN'
  };
}

function platformStatusRefreshError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: 'OZON_PLATFORM_STATUS_REFRESH_FAILED', message: error.message };
  return { code: 'OZON_PLATFORM_STATUS_REFRESH_FAILED', message: String(error || '未知错误') };
}

async function postJson(url: string, body: Record<string, unknown>): Promise<Record<string, any>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240_000)
    });
  } catch (error) {
    const normalized = normalizeOzonNetworkError(error);
    if (!normalized) throw error;
    throw new OzonNetworkRequestError({ ...normalized, cause: error });
  }
  let text = '';
  try {
    text = await response.text();
  } catch (error) {
    throw new OzonNetworkRequestError({
      code: 'OZON_RESPONSE_MISSING',
      message: error instanceof Error ? error.message : 'n8n 响应读取失败',
      deliveryState: 'UNKNOWN',
      cause: error
    });
  }
  let data: Record<string, any> = {};
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, any>;
    } catch {
      data = { message: text.slice(0, 500) };
    }
  }
  if ([408, 429].includes(response.status) || response.status >= 500) {
    throw new OzonNetworkRequestError({
      code: `OZON_UPSTREAM_HTTP_${response.status}`,
      message: `n8n Webhook 返回 HTTP ${response.status}: ${stringValue(data.message || data.error) || '暂时不可用'}`,
      deliveryState: 'UNKNOWN',
      ...(parseRetryAfterMs(response.headers.get('retry-after')) !== undefined
        ? { retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')) }
        : {})
    });
  }
  if (!response.ok) throw new Error(`n8n Webhook 返回 HTTP ${response.status}: ${stringValue(data.message || data.error) || '未知错误'}`);
  return data;
}

function stringValue(value: unknown): string | undefined {
  const result = String(value ?? '').trim();
  return result || undefined;
}
