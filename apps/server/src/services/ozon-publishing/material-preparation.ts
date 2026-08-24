import { createHash } from 'node:crypto';
import {
  AppError,
  assertOzonDescription,
  assertOzonTitle,
  isOzonSystemMediaAttributeId,
  nextOzonVariantCode,
  OZON_NO_BRAND_DICTIONARY_VALUE_ID,
  stableOzonOfferId,
  validateOzonDescription,
  validateOzonTitle,
  type OzonAttributeValueInput,
  type OzonCategoryAttribute,
  type OzonCompatibleAppendPlan,
  type OzonListingDraft,
  type OzonMaterialSnapshot,
  type OzonMediaAsset
} from '@n8n-media-review/shared';
import {
  enforceOzonModelNameAttribute,
  enforceOzonProductTypeAttribute
} from '../../utils/ozon-sku-identity.js';

const NO_BRAND_ATTRIBUTE_IDS = new Set([31, 85]);
const MAIN_SKU_GROUP_ATTRIBUTE_ID = 8292;

type OzonOffer = OzonListingDraft['data']['offers'][number];

export type OzonAutoMaterialSnapshot = OzonMaterialSnapshot;

export type OzonCompatibleAppendProductVariant = {
  variantId: string;
  name?: string | null;
};

export type OzonCompatibleIdentityPlan<T extends OzonCompatibleAppendProductVariant = OzonCompatibleAppendProductVariant> = {
  publicationVariants: T[];
  representedVariantIds: string[];
  missingVariants: T[];
  duplicateVariantIds: string[];
  preservedOffers: OzonCompatibleAppendPlan['preservedOffers'];
  incompleteMappingOfferIds: string[];
  offerIdentities: Array<{ variantId: string; variantCode: string; offerId: string; reused: boolean }>;
  exhaustedVariantIds: string[];
};

export function createOzonCompatibleIdentityPlan<T extends OzonCompatibleAppendProductVariant>(input: {
  sku: string;
  productVariants: T[];
  existingOffers: OzonOffer[];
  productLinks?: Array<{ offerId: string; ozonProductId?: string; ozonSku?: string }>;
  candidateOfferVariantIds?: string[];
}): OzonCompatibleIdentityPlan<T> {
  const realVariants = input.productVariants.filter((variant) => String(variant.name || '').trim() !== '默认变体');
  const selectedVariants = (realVariants.length ? realVariants : input.productVariants).slice(0, 99);
  const duplicateVariantIds: string[] = [];
  const uniqueVariants = new Map<string, T>();
  for (const variant of selectedVariants) {
    const variantId = String(variant.variantId || '').trim();
    if (!variantId) continue;
    if (uniqueVariants.has(variantId)) duplicateVariantIds.push(variantId);
    else uniqueVariants.set(variantId, variant);
  }
  const publicationVariants = [...uniqueVariants.values()];
  const represented = new Set(input.existingOffers
    .map((offer) => String(offer.productVariantId || offer.variantId || '').trim())
    .filter(Boolean));
  const representedVariantIds = publicationVariants
    .map((variant) => variant.variantId)
    .filter((variantId) => represented.has(variantId));
  const missingVariants = publicationVariants.filter((variant) => !represented.has(variant.variantId));

  const productLinks = new Map((input.productLinks || []).map((link) => [link.offerId, link]));
  const preservedOffers = input.existingOffers.map((offer) => {
    const link = productLinks.get(offer.offerId);
    return {
      offerId: offer.offerId,
      ...(offer.productVariantId || offer.variantId ? { variantId: offer.productVariantId || offer.variantId } : {}),
      ...(offer.productVariantName ? { variantName: offer.productVariantName } : {}),
      ...(link?.ozonProductId ? { ozonProductId: link.ozonProductId } : {}),
      ...(link?.ozonSku ? { ozonSku: link.ozonSku } : {})
    };
  });
  const incompleteMappingOfferIds = preservedOffers
    .filter((offer) => !/^\d+$/.test(String(offer.ozonProductId || '')) || !/^\d+$/.test(String(offer.ozonSku || '')))
    .map((offer) => offer.offerId);

  const publicationVariantIds = new Set(publicationVariants
    .filter((variant) => String(variant.name || '').trim() !== '默认变体')
    .map((variant) => String(variant.variantId || '').trim())
    .filter(Boolean));
  const candidateOfferVariantIds = input.candidateOfferVariantIds === undefined
    ? missingVariants.map((variant) => variant.variantId)
    : [...new Set(input.candidateOfferVariantIds
        .map((variantId) => String(variantId || '').trim())
        .filter((variantId) => publicationVariantIds.has(variantId)))];
  const existingByVariantId = new Map(input.existingOffers.map((offer) => [String(offer.variantId), offer]));
  const usedCodes = new Set(input.existingOffers.map((offer) => offer.variantCode));
  const offerIdentities: OzonCompatibleIdentityPlan['offerIdentities'] = [];
  const exhaustedVariantIds: string[] = [];
  for (const variantId of candidateOfferVariantIds) {
    const existing = existingByVariantId.get(variantId);
    if (existing) {
      offerIdentities.push({
        variantId,
        variantCode: existing.variantCode,
        offerId: existing.offerId,
        reused: true
      });
      continue;
    }
    const variantCode = nextOzonVariantCode(usedCodes);
    if (!variantCode) {
      exhaustedVariantIds.push(variantId);
      continue;
    }
    usedCodes.add(variantCode);
    offerIdentities.push({
      variantId,
      variantCode,
      offerId: stableOzonOfferId(input.sku, variantCode),
      reused: false
    });
  }
  return {
    publicationVariants,
    representedVariantIds,
    missingVariants,
    duplicateVariantIds: [...new Set(duplicateVariantIds)],
    preservedOffers,
    incompleteMappingOfferIds,
    offerIdentities,
    exhaustedVariantIds
  };
}

export function createOzonCompatibleAppendManifestSignature(mediaAssets: OzonMediaAsset[]): string {
  const snapshot = mediaAssets
    .map((asset) => ({
      assetId: asset.assetId,
      relativePath: asset.relativePath.replaceAll('\\', '/').normalize('NFC'),
      kind: asset.kind,
      sizeBytes: asset.sizeBytes,
      sha256: asset.sha256,
      modifiedAt: asset.modifiedAt,
      validationStatus: asset.validationStatus,
      productVariantId: asset.productVariantId || null,
      sourceStageId: asset.sourceStageId || null,
      sourceSubmissionId: asset.sourceSubmissionId || null,
      sortOrder: asset.sortOrder ?? null
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  return `sha256:${createHash('sha256').update(stableJson(snapshot)).digest('hex')}`;
}

export function createOzonCompatibleAppendPlan(input: {
  listing: OzonListingDraft;
  productVariants: OzonCompatibleAppendProductVariant[];
  currentMediaAssets: OzonMediaAsset[];
  manifestSignature?: string;
  blockers?: string[];
  binding?: Record<string, unknown>;
}): OzonCompatibleAppendPlan {
  const blockers = [...(input.blockers || []).map((reason) => String(reason || '').trim()).filter(Boolean)];
  if (input.listing.status !== 'PUBLISHED') blockers.push(`当前资料状态 ${input.listing.status} 不是 PUBLISHED，不能兼容追加`);
  const identityPlan = createOzonCompatibleIdentityPlan({
    sku: input.listing.sku,
    productVariants: input.productVariants,
    existingOffers: input.listing.data.offers,
    productLinks: input.listing.ozonProductLinks
  });
  const preservedOffers = identityPlan.preservedOffers;
  if (!preservedOffers.length) blockers.push('既有 PUBLISHED 资料没有稳定 Offer，不能兼容追加');
  const incompleteMappings = identityPlan.incompleteMappingOfferIds;
  if (incompleteMappings.length) blockers.push(`既有 Offer 缺少完整 productId/ozonSku 平台映射：${incompleteMappings.join(', ')}`);
  for (const variantId of identityPlan.duplicateVariantIds) blockers.push(`产品身份包含重复变体：${variantId}`);
  const missingVariants = identityPlan.missingVariants;
  if (!missingVariants.length) blockers.push('当前商品没有可兼容追加的新变体');

  const assetsByVariant = new Map<string, OzonMediaAsset[]>();
  for (const asset of input.currentMediaAssets) {
    if (asset.validationStatus !== 'VALID' || !asset.productVariantId) continue;
    const assets = assetsByVariant.get(asset.productVariantId) || [];
    assets.push(asset);
    assetsByVariant.set(asset.productVariantId, assets);
  }
  const identitiesByVariantId = new Map(identityPlan.offerIdentities.map((identity) => [identity.variantId, identity]));
  const newOffers: OzonCompatibleAppendPlan['newOffers'] = [];
  for (const variant of missingVariants) {
    const variantName = String(variant.name || '').trim();
    if (!variantName) blockers.push(`新增变体 ${variant.variantId} 缺少名称`);
    const identity = identitiesByVariantId.get(variant.variantId);
    if (!identity) {
      blockers.push('OZON 稳定变体编码 01–99 已用完，不能继续追加');
      break;
    }
    const media = assetsByVariant.get(variant.variantId) || [];
    const images = media.filter((asset) => asset.kind === 'image');
    const videos = media.filter((asset) => asset.kind === 'video');
    if (!images.length) blockers.push(`新增变体“${variantName || variant.variantId}”缺少有效图片`);
    if (videos.length !== 1) blockers.push(`新增变体“${variantName || variant.variantId}”必须恰好包含 1 个有效视频`);
    newOffers.push({
      offerId: identity.offerId,
      variantId: variant.variantId,
      variantName: variantName || '未命名变体',
      imageCount: images.length,
      hasVideo: videos.length === 1
    });
  }

  const manifestSignature = input.manifestSignature || createOzonCompatibleAppendManifestSignature(input.currentMediaAssets);
  const preservedOfferIds = preservedOffers.map((offer) => offer.offerId);
  const submittedOfferIds = newOffers.map((offer) => offer.offerId);
  const uniqueBlockers = [...new Set(blockers)];
  const planHash = `sha256:${createHash('sha256').update(stableJson({
    mode: 'COMPATIBLE_APPEND',
    sku: input.listing.sku,
    rowVersion: input.listing.rowVersion,
    manifestSignature,
    preservedOffers,
    newOffers,
    preservedOfferIds,
    submittedOfferIds,
    blockers: uniqueBlockers,
    binding: input.binding || {}
  })).digest('hex')}`;
  return {
    mode: 'COMPATIBLE_APPEND',
    sku: input.listing.sku,
    rowVersion: input.listing.rowVersion,
    planHash,
    manifestSignature,
    canAppend: uniqueBlockers.length === 0,
    ...(uniqueBlockers.length ? { blockedReason: uniqueBlockers.join('；') } : {}),
    preservedOffers,
    newOffers,
    preservedOfferIds,
    submittedOfferIds
  };
}

export function prepareOzonManagedSharedAttributes(input: {
  categoryAttributes: OzonCategoryAttribute[];
  attributes: OzonAttributeValueInput[];
  sku: string;
  typeId: number;
  titleRu?: string;
  descriptionRu?: string;
  brandMode?: 'FORCE_NO_BRAND' | 'PRESERVE_OR_DEFAULT';
  brandValue?: string;
}): OzonAttributeValueInput[] {
  const available = new Set(input.categoryAttributes.map((attribute) => `${attribute.id}:${attribute.complexId}`));
  const values = new Map(
    input.attributes
      .filter((attribute) => !isOzonSystemMediaAttributeId(attribute.attributeId))
      .map((attribute) => [`${attribute.attributeId}:${attribute.complexId}`, cloneAttribute(attribute)])
  );
  const put = (attributeId: number, value: OzonAttributeValueInput['values']) => {
    const key = `${attributeId}:0`;
    if (available.has(key)) values.set(key, { attributeId, complexId: 0, values: value.map((entry) => ({ ...entry })) });
  };
  const brandAttributeIds = input.categoryAttributes
    .filter((attribute) => attribute.complexId === 0 && NO_BRAND_ATTRIBUTE_IDS.has(attribute.id))
    .map((attribute) => attribute.id);
  const requestedBrand = String(input.brandValue || '').trim();
  const explicitlyNoBrand = ['无品牌', 'нет бренда'].includes(requestedBrand.toLocaleLowerCase('ru-RU'));
  for (const brandAttributeId of brandAttributeIds) {
    const brandKey = `${brandAttributeId}:0`;
    if (input.brandMode === 'FORCE_NO_BRAND' || explicitlyNoBrand) {
      put(brandAttributeId, [{ value: '无品牌' }]);
    } else if (!values.has(brandKey)) {
      put(brandAttributeId, [{ value: requestedBrand || '无品牌' }]);
    }
  }
  // Every Offer of one materialized product must use the same stable grouping
  // value so OZON can merge colors and sizes onto one product card.
  put(MAIN_SKU_GROUP_ATTRIBUTE_ID, [{ value: input.sku }]);
  put(9024, [{ value: input.sku }]);
  if (typeof input.titleRu === 'string' && input.titleRu.trim()) put(4180, [{ value: assertOzonMaterialTitle(input.titleRu) }]);
  // product.json keeps the original source. Only the outbound attribute value
  // receives the shared newline-to-<br> submission normalization.
  if (typeof input.descriptionRu === 'string' && input.descriptionRu.trim()) put(4191, [{ value: assertOzonMaterialDescription(input.descriptionRu) }]);
  return enforceOzonProductTypeAttribute(
    enforceOzonModelNameAttribute([...values.values()], input.sku, input.categoryAttributes),
    input.typeId,
    input.categoryAttributes
  );
}

function assertOzonMaterialTitle(value: string): string {
  try {
    return assertOzonTitle(value);
  } catch {
    const policy = validateOzonTitle(value);
    throw new AppError('CONFIG_INVALID', 'OZON 标题不符合内容合同', {
      fieldPath: 'titleRu', issues: policy.issues, retryable: false
    }, 422);
  }
}

function assertOzonMaterialDescription(value: string): string {
  try {
    return assertOzonDescription(value);
  } catch {
    const policy = validateOzonDescription(value);
    throw new AppError('CONFIG_INVALID', 'OZON 商品详情不符合内容合同', {
      fieldPath: 'descriptionRu', issues: policy.issues, retryable: false
    }, 422);
  }
}

export function normalizeOzonNoBrandForPlatform(
  attributes: OzonAttributeValueInput[],
  categoryAttributes: OzonCategoryAttribute[]
): OzonAttributeValueInput[] {
  const supportsBrand = categoryAttributes.some((attribute) => (
    NO_BRAND_ATTRIBUTE_IDS.has(attribute.id) && attribute.complexId === 0
  ));
  return supportsBrand ? normalizeOzonNoBrandAttributeForPlatform(attributes) : attributes.map(cloneAttribute);
}

export function normalizeOzonNoBrandAttributeForPlatform(
  attributes: OzonAttributeValueInput[]
): OzonAttributeValueInput[] {
  return attributes.map((attribute) => {
    if (!NO_BRAND_ATTRIBUTE_IDS.has(attribute.attributeId) || attribute.complexId !== 0) return cloneAttribute(attribute);
    const noBrand = attribute.values.some((value) => value.dictionaryValueId === OZON_NO_BRAND_DICTIONARY_VALUE_ID
      || ['无品牌', 'нет бренда'].includes(String(value.value || '').trim().toLocaleLowerCase('ru-RU')));
    return noBrand
      ? { attributeId: attribute.attributeId, complexId: 0, values: [{ dictionaryValueId: OZON_NO_BRAND_DICTIONARY_VALUE_ID }] }
      : cloneAttribute(attribute);
  });
}

export function mergeOzonManagedAttributes(
  existing: OzonAttributeValueInput[],
  planned: OzonAttributeValueInput[],
  managedAttributeIds: ReadonlySet<number>
): OzonAttributeValueInput[] {
  const managedPlanned = planned.filter((attribute) => managedAttributeIds.has(attribute.attributeId));
  return [
    ...existing
      .filter((attribute) => !isOzonSystemMediaAttributeId(attribute.attributeId) && !managedAttributeIds.has(attribute.attributeId))
      .map(cloneAttribute),
    ...managedPlanned.map(cloneAttribute)
  ];
}

export function assertCompatibleOzonOfferMediaComplete(
  offers: OzonOffer[],
  mediaAssets: OzonMediaAsset[]
): void {
  const assetIds = new Set(mediaAssets.map((asset) => asset.assetId));
  const invalid = offers.flatMap((offer) => {
    const images = offer.media.filter((media) => media.kind === 'image');
    const videos = offer.media.filter((media) => media.kind === 'video');
    const missingAssetIds = offer.media.filter((media) => !assetIds.has(media.assetId)).map((media) => media.assetId);
    return images.length > 0 && videos.length === 1 && missingAssetIds.length === 0
      ? []
      : [{ offerId: offer.offerId, images: images.length, videos: videos.length, missingAssetIds }];
  });
  if (invalid.length) {
    throw new AppError(
      'VERSION_CONFLICT',
      '既有 OZON Offer 媒体不完整，兼容更新已停止',
      { reasonCode: 'OZON_COMPATIBLE_MEDIA_INCOMPLETE', invalid },
      409
    );
  }
}

export function mergeCompatibleOzonOffers(
  existingOffers: OzonOffer[],
  plannedOffers: OzonOffer[],
  options: { allowNewOffers?: boolean } = {}
): OzonOffer[] {
  const plannedByVariantId = uniqueOffersByVariantId(plannedOffers, 'planned');
  uniqueOffersByVariantId(existingOffers, 'existing');
  const merged = existingOffers.map((existing) => {
    const planned = plannedByVariantId.get(existing.variantId);
    if (!planned) return cloneOffer(existing);
    plannedByVariantId.delete(existing.variantId);
    return {
      ...planned,
      ...existing,
      variantId: existing.variantId,
      variantCode: existing.variantCode,
      offerId: existing.offerId,
      barcode: existing.barcode,
      modelGroup: existing.modelGroup,
      price: planned.price,
      oldPrice: planned.oldPrice,
      minPrice: planned.minPrice,
      stock: planned.stock,
      // Variant attributes are human-authored compatibility data. Price, stock and media
      // are the only automatically managed offer fields in a compatible update.
      attributes: existing.attributes.map(cloneAttribute),
      media: planned.media.map((media) => ({ ...media }))
    };
  });
  if (plannedByVariantId.size && !options.allowNewOffers) {
    throw new AppError(
      'VERSION_CONFLICT',
      'OZON 兼容更新检测到新增 Offer，已停止自动更新以避免静默重建变体',
      {
        reasonCode: 'OZON_COMPATIBLE_NEW_OFFER_NOT_ALLOWED',
        variantIds: [...plannedByVariantId.keys()]
      },
      409
    );
  }
  return [
    ...merged,
    ...[...plannedByVariantId.values()].map(cloneOffer)
  ];
}

export function mergeCompatibleOzonMediaAssets(
  existingAssets: OzonMediaAsset[],
  plannedAssets: OzonMediaAsset[],
  offers: OzonOffer[]
): OzonMediaAsset[] {
  const referenced = new Set(offers.flatMap((offer) => offer.media.map((media) => media.assetId)));
  const byId = new Map(existingAssets.map((asset) => [asset.assetId, { ...asset }]));
  for (const asset of plannedAssets) byId.set(asset.assetId, { ...asset });
  const missing = [...referenced].filter((assetId) => !byId.has(assetId));
  if (missing.length) {
    throw new AppError(
      'VERSION_CONFLICT',
      'OZON 兼容更新后的 Offer 存在缺失媒体资产',
      { reasonCode: 'OZON_COMPATIBLE_MEDIA_ASSET_MISSING', missingAssetIds: missing },
      409
    );
  }
  return [...byId.values()].filter((asset) => referenced.has(asset.assetId));
}

export function createOzonAutoMaterialSnapshot(input: {
  capturedAt: string;
  preset: { id: string; name: string; rowVersion: number; definition: unknown };
  category: { key: string; versionId: string; versionNo: number; schemaHash: string };
  procurement: {
    id: string;
    versionNo: number;
    createdAt?: string;
    productHeightCm?: unknown;
    productDepthCm?: unknown;
    productWidthCm?: unknown;
    netWeightGrams?: unknown;
  };
  packaging: {
    length: number;
    width: number;
    height: number;
    dimensionUnit: string;
    weight: number;
    weightUnit: string;
    grossWeightSource: OzonMaterialSnapshot['packaging']['grossWeightSource'];
  };
  pricing: { pricingTemplateId: string; shippingTemplateId: string; shippingServiceCode: string; optionId?: string };
  store: OzonMaterialSnapshot['store'];
  offerIds: string[];
  warnings?: string[];
}): OzonAutoMaterialSnapshot {
  const dimensionMultiplier = input.packaging.dimensionUnit === 'mm' ? 0.1 : input.packaging.dimensionUnit === 'in' ? 2.54 : 1;
  const weightMultiplier = input.packaging.weightUnit === 'kg' ? 1_000 : input.packaging.weightUnit === 'lb' ? 453.59237 : 1;
  const offerIds = [...new Set(input.offerIds.map((offerId) => String(offerId).trim()).filter(Boolean))];
  return {
    schemaVersion: 1,
    capturedAt: input.capturedAt,
    preset: {
      id: input.preset.id,
      name: input.preset.name,
      rowVersion: input.preset.rowVersion,
      definitionHash: `sha256:${createHash('sha256').update(stableJson(input.preset.definition)).digest('hex')}`
    },
    category: {
      key: input.category.key,
      versionId: input.category.versionId,
      versionNo: input.category.versionNo,
      schemaHash: input.category.schemaHash
    },
    procurement: {
      versionId: input.procurement.id,
      versionNo: input.procurement.versionNo,
      capturedAt: input.procurement.createdAt || input.capturedAt,
      productHeightCm: finitePositiveOrNull(input.procurement.productHeightCm),
      productDepthCm: finitePositiveOrNull(input.procurement.productDepthCm),
      productWidthCm: finitePositiveOrNull(input.procurement.productWidthCm),
      netWeightGrams: finitePositiveOrNull(input.procurement.netWeightGrams)
    },
    packaging: {
      lengthCm: input.packaging.length * dimensionMultiplier,
      widthCm: input.packaging.width * dimensionMultiplier,
      heightCm: input.packaging.height * dimensionMultiplier,
      grossWeightGrams: input.packaging.weight * weightMultiplier,
      grossWeightSource: input.packaging.grossWeightSource
    },
    pricing: {
      pricingTemplateId: input.pricing.pricingTemplateId,
      shippingTemplateId: input.pricing.shippingTemplateId,
      shippingServiceCode: input.pricing.shippingServiceCode,
      optionId: input.pricing.optionId || null
    },
    store: {
      storeAlias: input.store.storeAlias,
      warehouseId: input.store.warehouseId,
      currency: input.store.currency,
      fulfillmentMode: input.store.fulfillmentMode
    },
    offers: { count: offerIds.length, ids: offerIds },
    artifact: { revision: null, signature: null },
    warnings: [...new Set(input.warnings || [])].sort()
  };
}

export function completeOzonAutoMaterialSnapshot(
  snapshot: OzonAutoMaterialSnapshot,
  artifact: { revision: number; signature: string; offerIds: string[] }
): OzonMaterialSnapshot {
  const offerIds = [...new Set(artifact.offerIds.map((offerId) => String(offerId).trim()).filter(Boolean))];
  return {
    ...snapshot,
    offers: { count: offerIds.length, ids: offerIds },
    artifact: { revision: artifact.revision, signature: artifact.signature }
  };
}

export function isOzonAutoMaterialSnapshot(value: unknown): value is OzonAutoMaterialSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<OzonAutoMaterialSnapshot>;
  return candidate.schemaVersion === 1
    && typeof candidate.capturedAt === 'string'
    && Boolean(candidate.preset && candidate.category && candidate.procurement && candidate.packaging
      && candidate.pricing && candidate.store && candidate.offers && candidate.artifact && Array.isArray(candidate.warnings));
}

function uniqueOffersByVariantId(offers: OzonOffer[], label: string): Map<string, OzonOffer> {
  const result = new Map<string, OzonOffer>();
  for (const offer of offers) {
    if (result.has(offer.variantId)) {
      throw new AppError(
        'VERSION_CONFLICT',
        `OZON ${label} Offer 存在重复 variantId`,
        { reasonCode: 'OZON_COMPATIBLE_VARIANT_AMBIGUOUS', variantId: offer.variantId },
        409
      );
    }
    result.set(offer.variantId, offer);
  }
  return result;
}

function finitePositiveOrNull(value: unknown): number | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function cloneAttribute(attribute: OzonAttributeValueInput): OzonAttributeValueInput {
  return { ...attribute, values: attribute.values.map((value) => ({ ...value })) };
}

function cloneOffer(offer: OzonOffer): OzonOffer {
  return {
    ...offer,
    attributes: offer.attributes.map(cloneAttribute),
    media: offer.media.map((media) => ({ ...media })),
    ...(offer.descriptionWarnings ? { descriptionWarnings: offer.descriptionWarnings.map((warning) => ({ ...warning, removedFragments: [...warning.removedFragments] })) } : {})
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
