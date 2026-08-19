import type { OzonListingDraftInput, OzonMediaAsset } from '@n8n-media-review/shared';
import { resolveSharedMediaOrder } from './shared-media-order';

type OzonOffer = OzonListingDraftInput['offers'][number] & {
  productVariantId?: string;
  productVariantName?: string;
  productVariantColor?: { colorKey: string; nameRu: string; nameZh: string };
};

type OzonMediaReference = OzonOffer['media'][number];

export type OzonMediaSuggestionReport = {
  changed: boolean;
  matchedVariants: number;
  imagesAdded: number;
  videosAdded: number;
  warnings: string[];
};

export function applyOzonMediaSuggestions(
  offers: OzonOffer[],
  mediaAssets: OzonMediaAsset[]
): { offers: OzonOffer[]; report: OzonMediaSuggestionReport } {
  const warnings: string[] = [];
  let matchedVariants = 0;
  let imagesAdded = 0;
  let videosAdded = 0;
  const offerColorCounts = countKeys(offers, (offer) => offer.productVariantColor?.colorKey);
  const offerNameCounts = countKeys(offers, (offer) => normalizeName(offer.productVariantName));

  const nextOffers = offers.map((offer) => {
    const matchingAssets = mediaAssets.filter((asset) => assetMatchesOffer(asset, offer, offerColorCounts, offerNameCounts));
    if (!matchingAssets.length) {
      appendAmbiguousIdentityWarnings(warnings, offer, mediaAssets, offerColorCounts, offerNameCounts);
      return offer;
    }

    const latestImageBatch = latestDeliveryBatch(matchingAssets.filter((asset) => isValidStageAsset(asset, 'image', 'E005')));
    const imageOrder = resolveSharedMediaOrder(latestImageBatch);
    if (!imageOrder.ok) {
      warnings.push(`${offerLabel(offer)}：图片顺序错误，已停止自动匹配：${imageOrder.message}`);
      return offer;
    }

    matchedVariants += 1;
    const current = normalizeMediaReferences(offer.media || []);
    const currentImages = current.filter((reference) => reference.kind === 'image');
    const currentVideo = current.find((reference) => reference.kind === 'video');
    const remaining = Math.max(0, 15 - currentImages.length);
    const additions = imageOrder.assets
      .filter((asset) => !current.some((reference) => reference.assetId === asset.assetId))
      .slice(0, remaining)
      .map(mediaReferenceFromAsset);

    let nextMedia = normalizeMediaReferences([...current, ...additions]);
    imagesAdded += additions.length;
    if (!currentVideo) {
      const latestVideos = latestDeliveryBatch(matchingAssets.filter((asset) => isValidStageAsset(asset, 'video', 'E004')));
      if (latestVideos.length === 1) {
        nextMedia = normalizeMediaReferences([...nextMedia, mediaReferenceFromAsset(latestVideos[0]!)]);
        videosAdded += 1;
      } else if (latestVideos.length > 1) {
        warnings.push(`${offerLabel(offer)}：最新 E004 批次包含 ${latestVideos.length} 个视频，请人工选择一个`);
      }
    }

    return stableJson(nextMedia) === stableJson(current) ? offer : { ...offer, media: nextMedia };
  });

  return {
    offers: nextOffers,
    report: {
      changed: stableJson(nextOffers) !== stableJson(offers),
      matchedVariants,
      imagesAdded,
      videosAdded,
      warnings: [...new Set(warnings)]
    }
  };
}

function assetMatchesOffer(
  asset: OzonMediaAsset,
  offer: OzonOffer,
  offerColorCounts: Map<string, number>,
  offerNameCounts: Map<string, number>
): boolean {
  const offerId = offer.productVariantId || offer.variantId;
  if (asset.productVariantId) return asset.productVariantId === offerId;

  const colorKey = asset.productVariantColor?.colorKey;
  if (colorKey && offer.productVariantColor?.colorKey === colorKey) return offerColorCounts.get(colorKey) === 1;

  const assetName = normalizeName(asset.productVariantName);
  const offerName = normalizeName(offer.productVariantName);
  return Boolean(assetName && offerName && assetName === offerName && offerNameCounts.get(offerName) === 1);
}

function appendAmbiguousIdentityWarnings(
  warnings: string[],
  offer: OzonOffer,
  mediaAssets: OzonMediaAsset[],
  offerColorCounts: Map<string, number>,
  offerNameCounts: Map<string, number>
): void {
  const missingIdAssets = mediaAssets.filter((asset) => !asset.productVariantId && asset.validationStatus === 'VALID');
  const colorKey = offer.productVariantColor?.colorKey;
  const name = normalizeName(offer.productVariantName);
  if (colorKey && (offerColorCounts.get(colorKey) || 0) > 1 && missingIdAssets.some((asset) => asset.productVariantColor?.colorKey === colorKey)) {
    warnings.push(`${offerLabel(offer)}：颜色标识对应多个变体，缺少 productVariantId 的媒体未自动分配`);
  } else if (name && (offerNameCounts.get(name) || 0) > 1 && missingIdAssets.some((asset) => normalizeName(asset.productVariantName) === name)) {
    warnings.push(`${offerLabel(offer)}：变体名称对应多个变体，缺少 productVariantId 的媒体未自动分配`);
  }
}

function latestDeliveryBatch<T extends { sourceSubmissionId?: string; deliveredAt?: string }>(assets: T[]): T[] {
  if (!assets.length) return [];
  const groups = new Map<string, T[]>();
  for (const asset of assets) {
    const key = asset.sourceSubmissionId || '__legacy__';
    groups.set(key, [...(groups.get(key) || []), asset]);
  }
  return [...groups.entries()]
    .sort((left, right) => deliveryBatchSortValue(right).localeCompare(deliveryBatchSortValue(left)))[0]?.[1] || [];
}

function deliveryBatchSortValue<T extends { deliveredAt?: string }>(entry: [string, T[]]): string {
  const deliveredAt = entry[1].map((asset) => asset.deliveredAt || '').sort().at(-1) || '';
  return `${deliveredAt}\0${entry[0]}`;
}

function mediaReferenceFromAsset(asset: OzonMediaAsset): OzonMediaReference {
  return { assetId: asset.assetId, relativePath: asset.relativePath, kind: asset.kind, sortOrder: 0, isPrimary: false };
}

function normalizeMediaReferences(input: OzonMediaReference[]): OzonMediaReference[] {
  const unique = [...new Map((input || []).filter((reference) => reference?.assetId).map((reference) => [reference.assetId, reference])).values()];
  const ordered = [...unique.filter((reference) => reference.kind !== 'video').slice(0, 15), ...unique.filter((reference) => reference.kind === 'video').slice(0, 1)];
  const firstImageIndex = ordered.findIndex((reference) => reference.kind !== 'video');
  return ordered.map((reference, index) => ({
    assetId: String(reference.assetId),
    relativePath: String(reference.relativePath),
    kind: reference.kind === 'video' ? 'video' : 'image',
    sortOrder: index,
    isPrimary: index === firstImageIndex && reference.kind !== 'video'
  }));
}

function isValidStageAsset(asset: OzonMediaAsset, kind: OzonMediaAsset['kind'], stage: 'E004' | 'E005'): boolean {
  return asset.validationStatus === 'VALID' && asset.kind === kind && asset.sourceStageId === stage;
}

function countKeys<T>(items: T[], keyFor: (item: T) => string | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFor(item);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function normalizeName(value?: string): string {
  return String(value || '').trim().normalize('NFC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
}

function offerLabel(offer: OzonOffer): string {
  return offer.offerId || offer.productVariantName || offer.variantCode || offer.variantId;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : canonicalJsonValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalJsonValue(item)]));
}
