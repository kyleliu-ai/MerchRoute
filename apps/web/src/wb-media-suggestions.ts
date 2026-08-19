import {
  latestWbMediaDeliveryBatch,
  wbMediaMatchesVariant,
  type ProductVariant,
  type WbColorIdentity
} from '@n8n-media-review/shared';
import type { WbDictionaryValue, WbListing, WbMediaAsset, WbVariant, WbVariantMedia } from './api/client';
import { resolveSharedMediaOrder } from './shared-media-order';

export const WB_COLOR_CHARACTERISTIC_ID = 14177449;

export type WbMediaSuggestionReport = {
  changed: boolean;
  matchedVariants: number;
  imagesAdded: number;
  videosAdded: number;
  warnings: string[];
};

export function applyWbMediaSuggestions(
  listing: WbListing,
  productVariants: ProductVariant[],
  colors: WbDictionaryValue[],
  rules: { maxImages: number; videoAllowed: boolean; colorSupported: boolean }
): { variants: WbVariant[]; variantMedia: WbVariantMedia[]; report: WbMediaSuggestionReport } {
  const warnings: string[] = [];
  let matchedVariants = 0;
  let imagesAdded = 0;
  let videosAdded = 0;
  const colorByRussianName = uniqueIndex(colors, (color) => normalizeName(color.nameRu));
  const productById = new Map(productVariants.map((variant) => [variant.variantId, variant]));
  const productByColor = uniqueIndex(productVariants.filter((variant) => variant.wbColor), (variant) => variant.wbColor!.colorKey);
  const productByName = uniqueIndex(productVariants, (variant) => normalizeName(variant.name));
  const media = new Map(listing.variantMedia.map((assignment) => [assignment.variantId, assignment]));

  const variants = listing.variants.map((variant) => {
    const currentColorValue = variantColorValue(variant);
    const dictionaryColor = currentColorValue ? colorByRussianName.get(normalizeName(currentColorValue)) : undefined;
    let productVariant = variant.productVariantId ? productById.get(variant.productVariantId) : undefined;
    productVariant ||= variant.productVariantColor ? productByColor.get(variant.productVariantColor.colorKey) : undefined;
    productVariant ||= dictionaryColor ? productByColor.get(dictionaryColor.itemKey) : undefined;
    productVariant ||= variant.productVariantName ? productByName.get(normalizeName(variant.productVariantName)) : undefined;
    if (!productVariant) {
      if (currentColorValue || variant.productVariantName) warnings.push(`${variant.vendorCode}：未找到唯一的产品颜色变体，媒体未自动分配`);
      return variant;
    }

    const linkedColor = productVariant.wbColor;
    if (linkedColor && currentColorValue && normalizeName(linkedColor.nameRu) !== normalizeName(currentColorValue)) {
      warnings.push(`${variant.vendorCode}：关联产品变体“${productVariant.name}”与 WB 颜色“${currentColorValue}”冲突，已保留人工设置`);
      return variant;
    }

    const candidates = listing.mediaAssets.filter((asset) => isValidAsset(asset) && wbMediaMatchesVariant(asset, productVariant));
    const latestImageBatch = latestWbMediaDeliveryBatch(candidates.filter((asset) => isImage(asset) && asset.sourceStageId === 'E005'));
    const imageOrder = resolveSharedMediaOrder(latestImageBatch);
    if (!imageOrder.ok) {
      warnings.push(`${variant.vendorCode}：图片顺序错误，已停止自动匹配：${imageOrder.message}`);
      return variant;
    }

    matchedVariants += 1;
    let nextVariant: WbVariant = {
      ...variant,
      productVariantId: productVariant.variantId,
      productVariantName: productVariant.name,
      ...(linkedColor ? { productVariantColor: linkedColor } : {})
    };
    if (linkedColor && !currentColorValue && rules.colorSupported) nextVariant = withColorCharacteristic(nextVariant, linkedColor.nameRu);

    const current = media.get(variant.variantId) || { variantId: variant.variantId, imageAssetIds: [] };
    const remaining = Math.max(0, Math.min(30, rules.maxImages) - current.imageAssetIds.length);
    const additions = imageOrder.assets.filter((asset) => !current.imageAssetIds.includes(asset.assetId)).slice(0, remaining).map((asset) => asset.assetId);
    let nextAssignment: WbVariantMedia = additions.length ? { ...current, imageAssetIds: [...current.imageAssetIds, ...additions] } : current;
    imagesAdded += additions.length;
    if (!current.videoAssetId && rules.videoAllowed) {
      const latestVideos = latestWbMediaDeliveryBatch(candidates.filter((asset) => isVideo(asset) && asset.sourceStageId === 'E004'));
      if (latestVideos.length === 1) {
        nextAssignment = { ...nextAssignment, videoAssetId: latestVideos[0]!.assetId };
        videosAdded += 1;
      } else if (latestVideos.length > 1) warnings.push(`${variant.vendorCode}：最新 E004 批次包含 ${latestVideos.length} 个视频，请人工选择一个`);
    }
    media.set(variant.variantId, nextAssignment);
    return nextVariant;
  });

  const variantMedia = listing.variants.map((variant) => media.get(variant.variantId) || { variantId: variant.variantId, imageAssetIds: [] });
  const changed = stableJson(variants) !== stableJson(listing.variants) || stableJson(variantMedia) !== stableJson(listing.variantMedia);
  return { variants, variantMedia, report: { changed, matchedVariants, imagesAdded, videosAdded, warnings: [...new Set(warnings)] } };
}

export function withColorCharacteristic(variant: WbVariant, nameRu?: string): WbVariant {
  const characteristics = variant.characteristics.filter((item) => item.id !== WB_COLOR_CHARACTERISTIC_ID);
  return { ...variant, characteristics: nameRu ? [...characteristics, { id: WB_COLOR_CHARACTERISTIC_ID, value: [nameRu] }] : characteristics };
}

export function variantColorValue(variant: WbVariant): string | undefined {
  const value = variant.characteristics.find((item) => item.id === WB_COLOR_CHARACTERISTIC_ID)?.value;
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first.trim() ? first.trim() : undefined;
}

export function linkVariantToProductVariant(variant: WbVariant, productVariant?: ProductVariant, colorSupported = true): WbVariant {
  if (!productVariant) return { ...variant, productVariantId: undefined, productVariantName: undefined, productVariantColor: undefined };
  const linked = { ...variant, productVariantId: productVariant.variantId, productVariantName: productVariant.name, productVariantColor: productVariant.wbColor };
  return productVariant.wbColor && colorSupported ? withColorCharacteristic(linked, productVariant.wbColor.nameRu) : linked;
}

export function colorIdentityFromDictionary(item: WbDictionaryValue): WbColorIdentity {
  return { colorKey: item.itemKey, nameRu: item.nameRu, nameZh: item.nameZh };
}

function uniqueIndex<T>(items: T[], keyFor: (item: T) => string): Map<string, T> {
  const result = new Map<string, T>();
  const duplicate = new Set<string>();
  for (const item of items) {
    const key = keyFor(item);
    if (result.has(key)) duplicate.add(key);
    else result.set(key, item);
  }
  for (const key of duplicate) result.delete(key);
  return result;
}

function normalizeName(value: string): string { return value.trim().normalize('NFC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е'); }
function isValidAsset(asset: WbMediaAsset): boolean { return asset.validationStatus === 'VALID'; }
function isImage(asset: WbMediaAsset): boolean { return asset.kind.toUpperCase() === 'IMAGE'; }
function isVideo(asset: WbMediaAsset): boolean { return asset.kind.toUpperCase() === 'VIDEO'; }
function stableJson(value: unknown): string { return JSON.stringify(canonicalJsonValue(value)); }

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : canonicalJsonValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalJsonValue(item)]));
}
